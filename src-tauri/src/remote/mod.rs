//! Compola Server: one Compola app (the host) shares its signed-in Zalo account; people sign in to it (local
//! accounts, LDAP, SSO) from other Compola apps and use the account with the role and conversations an admin gave
//! them. The host also serves an admin console. Design and contracts: docs/compola-server.md.
//!
//! * Host: `server` (listener, WebSocket sessions, uploads, media), `api` (REST + admin console), `store` (SQLite:
//!   users, groups, grants, sessions, providers, audit), `auth` (passwords, LDAP, OIDC, device flow), `policy`
//!   (filters what each user sees and may do).
//! * Joined app: `client`. The local engine does not start; Rust keeps one WebSocket to the host.
//!
//! The Zalo session (cookies, databases, keys) never leaves the host.

mod api;
mod auth;
mod client;
mod http;
pub mod policy;
mod server;
mod store;

use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

pub use client::Client;

pub const DEFAULT_PORT: u16 = 39218;
/// UI event about Compola Server: `{kind: "changed"}`, `{kind: "connection", …}`, `{kind: "joinProgress", …}`,
/// `{kind: "access", access}`.
pub const EVENT: &str = "compola://remote";
/// The engine events a joined app's UI receives (filtered per user).
const FORWARDED: &[&str] = &["compola://phase", "compola://state", "compola://badge", "compola://page"];
/// A notification the host's renderer created (`notifications::deliver_remote` on the joined app).
const NOTIFICATION_EVENT: &str = "compola://remote-notification";
/// Notification images larger than this are not sent along.
const MAX_NOTIFICATION_IMAGE: usize = 512 << 10;

// ---- config (`~/Library/Application Support/Compola/remote.json`, 0600) ----

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    pub enabled: bool,
    pub port: u16,
    /// Listen on every interface (LAN, Tailscale); false = loopback only (behind a tunnel or reverse proxy).
    pub allow_network: bool,
    /// Shown to people signing in.
    pub name: String,
    /// How people reach this server (SSO redirects, device links). Empty = `http://<LAN address>:<port>`.
    pub public_url: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, allow_network: true, name: computer_name(), public_url: String::new() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct JoinConfig {
    /// Normalized base URL (`http(s)://host:port/`).
    pub url: String,
    /// The device session token (a server user's sign-in on this install).
    pub token: String,
    pub device_name: String,
    pub server_name: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LastJoin {
    pub url: String,
    pub device_name: String,
    pub username: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Random id of this install: the device id joined sessions carry (never an identity).
    pub instance: String,
    pub server: ServerConfig,
    /// The admin the host app's "Mở trang quản trị" signs in as.
    pub owner_user_id: String,
    /// Set while this app is joined to a Compola Server.
    pub join: Option<JoinConfig>,
    /// The last server left, to prefill the join form.
    pub last_join: Option<LastJoin>,
}

fn config_path() -> std::path::PathBuf {
    crate::platform::app_support().join("remote.json")
}

fn load() -> Config {
    let mut config: Config = std::fs::read(config_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut dirty = false;
    if config.instance.is_empty() {
        config.instance = uuid::Uuid::new_v4().simple().to_string();
        dirty = true;
    }
    if config.join.as_ref().is_some_and(|j| j.token.is_empty()) {
        // A join from before user accounts (access code): sign in again.
        config.join = None;
        dirty = true;
    }
    if dirty {
        let _ = save(&config);
    }
    config
}

fn save(config: &Config) -> Result<(), String> {
    let p = config_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The Mac's name (System Settings › General › Sharing), else its host name.
pub fn computer_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if out.status.success() && !name.is_empty() {
                return name;
            }
        }
        let mut buf = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed along.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = if ok { String::from_utf8_lossy(&buf[..end]).trim_end_matches(".local").to_owned() } else { String::new() };
        if name.is_empty() { "Compola".to_owned() } else { name }
    })
    .clone()
}

/// Whether a server URL names this Mac (loopback, `localhost`, or one of its own addresses).
fn points_at_this_mac(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    match u.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost") || d == computer_name().to_ascii_lowercase().replace(' ', "-") + ".local"
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified() || local_addresses().iter().any(|a| a.get("ip").and_then(Value::as_str) == Some(&ip.to_string())),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        None => false,
    }
}

/// The IPv4 addresses joined apps can reach this Mac on: `{ip, kind: lan|tailscale|public}`.
fn local_addresses() -> Vec<Value> {
    let mut out: Vec<(std::net::Ipv4Addr, &'static str)> = Vec::new();
    // SAFETY: getifaddrs' list is only read while it is alive and freed once.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return Vec::new();
        }
        let mut p = list;
        while !p.is_null() {
            let ifa = &*p;
            if !ifa.ifa_addr.is_null() && i32::from((*ifa.ifa_addr).sa_family) == libc::AF_INET {
                let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let ip = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                let o = ip.octets();
                let kind = if o[0] == 100 && (64..128).contains(&o[1]) {
                    "tailscale"
                } else if ip.is_private() {
                    "lan"
                } else {
                    "public"
                };
                if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !out.iter().any(|(a, _)| *a == ip) {
                    out.push((ip, kind));
                }
            }
            p = ifa.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    let rank = |k: &str| match k {
        "lan" => 0,
        "tailscale" => 1,
        _ => 2,
    };
    out.sort_by_key(|(_, k)| rank(k));
    out.into_iter().map(|(ip, kind)| json!({ "ip": ip.to_string(), "kind": kind })).collect()
}

// ---- state ----

pub struct Remote {
    app: AppHandle,
    config: Mutex<Config>,
    hub: Arc<server::Hub>,
    server: tokio::sync::Mutex<Option<server::Handle>>,
    server_error: Mutex<Option<String>>,
    /// Set (for the app's lifetime) when this app is joined to a Compola Server.
    client: Option<Arc<Client>>,
    /// Accounts and sign-in of the host (None when the database cannot be opened).
    auth: Option<Arc<auth::Auth>>,
    /// What the host's renderer posted, for the policy and the admin console's conversation picker.
    mirror: RwLock<policy::Mirror>,
    /// Cancels a browser sign-in under way (`remote_join_cancel`).
    join_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// The listener runs: the mirror follows the renderer's state.
    serving: std::sync::atomic::AtomicBool,
    /// The host app's own sign-in to its server (the owner), for the native admin screens (`remote_api`).
    owner_token: Mutex<Option<String>>,
    /// The signed-in Zalo uid of the host (from the renderer's profile), recorded with activity.
    account_uid: Mutex<String>,
}

/// Who performed an action (activity tracking): a server user on a device / the web, or the host app itself.
pub struct Actor {
    pub user: Option<(String, String, String)>,
    pub device_id: String,
    pub device_name: String,
    /// `device` | `web` | `host`
    pub device_kind: String,
}

impl Remote {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let mut config = load();
        // A host that joined its own server (loopback / its own address while its server is on) would never start
        // the server it waits for: back to host mode.
        if config.server.enabled && config.join.as_ref().is_some_and(|j| points_at_this_mac(&j.url)) {
            log::warn!("compola server: this app had joined its own server; leaving it");
            config.join = None;
            let _ = save(&config);
        }
        let client = config.join.clone().and_then(|join| match Client::new(app.clone(), join, config.instance.clone()) {
            Ok(c) => Some(c),
            Err(e) => {
                log::warn!("compola server: saved join is unusable ({e}); starting locally");
                None
            }
        });
        let auth = if client.is_some() {
            None
        } else {
            match store::Store::open(&store::Store::path()) {
                Ok(s) => Some(Arc::new(auth::Auth::new(Arc::new(s)))),
                Err(e) => {
                    log::warn!("compola server: accounts database: {e}");
                    None
                }
            }
        };
        Arc::new(Self {
            app,
            config: Mutex::new(config),
            hub: Arc::new(server::Hub::new()),
            server: tokio::sync::Mutex::new(None),
            server_error: Mutex::new(None),
            client,
            auth,
            mirror: RwLock::new(policy::Mirror::default()),
            join_cancel: Mutex::new(None),
            serving: std::sync::atomic::AtomicBool::new(false),
            owner_token: Mutex::new(None),
            account_uid: Mutex::new(String::new()),
        })
    }

    /// Joined to a Compola Server: the local engine must not start.
    pub fn is_joined(&self) -> bool {
        self.client.is_some()
    }

    pub fn start(self: &Arc<Self>) {
        #[cfg(debug_assertions)]
        self.bootstrap_admin_from_env();
        if let Some(client) = &self.client {
            client.start();
            return;
        }
        if self.config.lock().server.enabled {
            let this = self.clone();
            tauri::async_runtime::spawn(async move { this.apply_server().await });
        }
    }

    /// Development aid: `COMPOLA_SERVER_ADMIN=user:password` creates the first admin (debug builds only).
    #[cfg(debug_assertions)]
    fn bootstrap_admin_from_env(&self) {
        let (Some(auth), Ok(spec)) = (self.auth(), std::env::var("COMPOLA_SERVER_ADMIN")) else { return };
        let Some((user, password)) = spec.split_once(':') else { return };
        if auth.store.count_admins().unwrap_or(1) == 0 {
            if let Ok(hash) = auth::hash_password(password) {
                let _ = auth.store.create_user(user, user, "", "local", Some(&hash), true);
            }
        }
    }

    fn auth(&self) -> Option<Arc<auth::Auth>> {
        self.auth.clone()
    }

    fn server_config(&self) -> ServerConfig {
        self.config.lock().server.clone()
    }

    fn server_name(&self) -> String {
        let name = self.config.lock().server.name.clone();
        if name.trim().is_empty() { computer_name() } else { name }
    }

    /// How people reach this server, without a trailing slash.
    fn public_url(&self) -> String {
        let c = self.server_config();
        let configured = c.public_url.trim().trim_end_matches('/').to_owned();
        if !configured.is_empty() {
            return configured;
        }
        let host = if c.allow_network {
            local_addresses().first().and_then(|a| a.get("ip").and_then(Value::as_str).map(str::to_owned)).unwrap_or_else(|| "127.0.0.1".into())
        } else {
            "127.0.0.1".into()
        };
        format!("http://{host}:{}", c.port)
    }

    fn changed(&self) {
        let _ = self.app.emit_to("main", EVENT, json!({ "kind": "changed" }));
    }

    /// (Re)starts or stops the listener for the saved settings; connected apps are dropped either way.
    async fn apply_server(self: &Arc<Self>) {
        let config = self.server_config();
        let mut slot = self.server.lock().await;
        *slot = None;
        self.serving.store(false, std::sync::atomic::Ordering::Relaxed);
        self.hub.kick_all("restarted");
        *self.server_error.lock() = None;
        if config.enabled && self.client.is_none() {
            if self.auth.is_none() {
                *self.server_error.lock() = Some("Không mở được cơ sở dữ liệu tài khoản (server.db).".into());
            } else {
                match server::start(Arc::downgrade(self), config.port, config.allow_network).await {
                    Ok(handle) => {
                        // What the renderer posted before the server started.
                        let mut mirror = policy::Mirror::default();
                        for event in self.engine().map(|e| e.replay()).unwrap_or_default() {
                            mirror.observe(&event);
                        }
                        *self.mirror.write() = mirror;
                        self.serving.store(true, std::sync::atomic::Ordering::Relaxed);
                        *slot = Some(handle);
                    }
                    Err(e) => {
                        log::warn!("compola server: {e}");
                        *self.server_error.lock() = Some(e);
                    }
                }
            }
        }
        drop(slot);
        self.changed();
    }

    fn update_config(&self, f: impl FnOnce(&mut Config)) -> Result<(), String> {
        let mut c = self.config.lock();
        let mut next = c.clone();
        f(&mut next);
        save(&next)?;
        *c = next;
        Ok(())
    }

    fn engine(&self) -> Option<Arc<crate::engine::Engine>> {
        crate::account::engine(&self.app, Some(crate::account::DEFAULT_ID)).ok()
    }

    fn phase_kind(&self) -> String {
        self.engine()
            .and_then(|e| serde_json::to_value(e.phase()).ok())
            .and_then(|v| v.get("kind").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "starting".into())
    }

    /// An admin changed users, groups or grants: connected users get their new access (or are disconnected).
    fn access_changed(&self) {
        let Some(auth) = self.auth() else { return };
        self.hub.refresh_access(
            |user_id| auth.store.user(user_id).ok().and_then(|u| auth.store.access_of(&u).ok()).and_then(|(a, _)| a),
            |access| self.mirror.read().conversations_snapshot(access),
        );
        self.changed();
    }

    fn session_revoked(&self, session_id: &str) {
        self.hub.kick_session(session_id, "revoked");
        self.changed();
    }

    fn online_sessions(&self) -> Vec<String> {
        self.hub.online_sessions()
    }

    /// The signed-in Zalo account, from the profile the renderer posted.
    fn account_json(&self) -> Value {
        let profile = self.engine().map(|e| e.replay()).and_then(|events| {
            events.into_iter().rev().find_map(|e| e.get("user").filter(|u| u.get("userId").is_some()).cloned())
        });
        let text = |k: &str| profile.as_ref().and_then(|p| p.get(k)).and_then(Value::as_str).unwrap_or_default().to_owned();
        json!({
            "name": if text("displayName").is_empty() { text("zaloName") } else { text("displayName") },
            "avatar": text("avatar"),
            "phase": self.phase_kind(),
        })
    }

    fn server_info_json(&self) -> Value {
        let c = self.server_config();
        json!({
            "name": self.server_name(),
            "version": server::version(),
            "publicUrl": self.public_url(),
            "publicUrlConfigured": c.public_url,
            "account": self.account_json(),
            "listen": { "port": c.port, "allowNetwork": c.allow_network },
            "addresses": local_addresses(),
            "online": self.hub.clients_json(),
        })
    }

    fn update_server_identity(&self, name: Option<String>, public_url: Option<String>) -> Result<(), String> {
        let public_url = match public_url {
            Some(u) if !u.trim().is_empty() => {
                let parsed = url::Url::parse(u.trim()).map_err(|_| "Địa chỉ công khai phải là URL đầy đủ, ví dụ https://compola.congty.vn".to_owned())?;
                if parsed.scheme() != "http" && parsed.scheme() != "https" {
                    return Err("Địa chỉ công khai phải bắt đầu bằng http:// hoặc https://".into());
                }
                Some(parsed.as_str().trim_end_matches('/').to_owned())
            }
            Some(_) => Some(String::new()),
            None => None,
        };
        self.update_config(|c| {
            if let Some(n) = name.map(|n| n.trim().chars().take(60).collect::<String>()) {
                c.server.name = if n.is_empty() { computer_name() } else { n };
            }
            if let Some(u) = public_url {
                c.server.public_url = u;
            }
        })?;
        self.changed();
        Ok(())
    }

    async fn state_json(&self) -> Value {
        let config = self.config.lock().clone();
        let running = self.server.lock().await.as_ref().map(|h| h.port);
        let has_admin = self.auth().and_then(|a| a.store.count_admins().ok()).is_some_and(|n| n > 0);
        json!({
            "mode": if self.is_joined() { "joined" } else { "local" },
            "computerName": computer_name(),
            "deviceId": config.instance,
            "server": {
                "config": config.server,
                "running": running.is_some(),
                "error": self.server_error.lock().clone(),
                "addresses": local_addresses(),
                "publicUrl": self.public_url(),
                "hasAdmin": has_admin,
                "adminUrl": format!("{}/admin/", self.public_url()),
                "sessions": self.hub.clients_json(),
            },
            "join": config.join.as_ref().map(|j| json!({
                "url": j.url, "deviceName": j.device_name, "serverName": j.server_name,
                "user": { "username": j.username, "displayName": j.display_name },
            })),
            "lastJoin": config.last_join,
            "connection": self.client.as_ref().map(|c| c.status_json()),
        })
    }

    /// A join must not switch off this app's own shared account: refused while its server is on, and never to itself.
    fn check_join(&self, server: &Value) -> Result<(), String> {
        let (instance, enabled) = {
            let c = self.config.lock();
            (c.instance.clone(), c.server.enabled)
        };
        if server.get("instance").and_then(Value::as_str) == Some(instance.as_str()) {
            return Err("Đây là Compola Server của chính máy này. Máy này đã dùng tài khoản Zalo của nó, không cần tham gia.".into());
        }
        if enabled {
            return Err(
                "Máy này đang bật Compola Server. Tham gia máy chủ khác sẽ tắt tài khoản Zalo đang chia sẻ: hãy tắt Compola Server trong Cài đặt trước.".into(),
            );
        }
        Ok(())
    }

    /// The admin the host app acts as: the one created in the app, else the oldest active admin.
    fn owner(&self, auth: &auth::Auth) -> Result<store::User, String> {
        let owner = self.config.lock().owner_user_id.clone();
        auth.store
            .user(&owner)
            .ok()
            .filter(|u| u.is_admin && !u.disabled)
            .or_else(|| auth.store.first_admin().ok().flatten())
            .ok_or_else(|| "Tạo tài khoản quản trị trước.".to_owned())
    }

    /// Records one attributed action; a successful send also gets its response time (since the oldest unanswered
    /// inbound message of the conversation) and closes that wait.
    fn record_activity(&self, actor: Actor, info: policy::CallInfo, call: &str, ok: bool) {
        let Some(auth) = self.auth() else { return };
        let now = store::now_ms();
        let sends = matches!(info.action, "message.send" | "message.media" | "message.file" | "message.sticker" | "message.card");
        let (response_ms, conversation_name) = {
            let mut mirror = self.mirror.write();
            let name = info.conversation.as_deref().and_then(|c| mirror.conversation_name(c));
            let response = match (&info.conversation, ok && sends) {
                (Some(c), true) => {
                    let r = mirror.pending_since(c).map(|t| (now - t).max(0));
                    mirror.note_outbound(c, now);
                    r
                }
                _ => None,
            };
            (response, name)
        };
        let mut detail = json!({ "call": call });
        if info.conversations.len() > 1 || (info.conversations.len() == 1 && info.conversation.as_ref() != info.conversations.first()) {
            detail["conversations"] = json!(info.conversations);
        }
        auth.store.add_activity(store::NewActivity {
            account: String::new(),
            account_uid: self.account_uid.lock().clone(),
            user: actor.user,
            device_id: actor.device_id,
            device_name: actor.device_name,
            device_kind: actor.device_kind,
            action: info.action.to_owned(),
            conversation_id: info.conversation,
            conversation_name,
            message_id: info.message,
            ok,
            response_ms,
            detail,
        });
    }

    fn save_join(&self, join: JoinConfig) -> Result<(), String> {
        let last = LastJoin { url: join.url.clone(), device_name: join.device_name.clone(), username: join.username.clone() };
        self.update_config(|c| {
            c.join = Some(join);
            c.last_join = Some(last);
        })
    }
}

/// The client of a joined app (None when the app runs its own engine).
pub fn client(app: &AppHandle) -> Option<Arc<Client>> {
    app.try_state::<Arc<Remote>>().and_then(|r| r.client.clone())
}

/// `emit_ui` hook: keeps the policy mirror current and hands the engine's UI events to the joined apps.
pub fn forward_event<S: Serialize>(app: &AppHandle, event: &str, payload: &S) {
    if !FORWARDED.contains(&event) {
        return;
    }
    let Some(remote) = app.try_state::<Arc<Remote>>() else { return };
    if remote.client.is_some() {
        return;
    }
    let observe = remote.serving.load(std::sync::atomic::Ordering::Relaxed) && (event == "compola://state" || event == "compola://page");
    if !observe && !remote.hub.has_clients() {
        return;
    }
    let Ok(value) = serde_json::to_value(payload) else { return };
    if event == "compola://state" {
        if let Some(uid) = value.pointer("/user/userId").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            let mut current = remote.account_uid.lock();
            if *current != uid {
                *current = uid.to_owned();
            }
        }
        remote.mirror.write().observe(&value);
    } else if event == "compola://page" && matches!(value.as_str(), Some("main" | "Main")) {
        remote.mirror.write().reset();
    }
    if remote.hub.has_clients() {
        remote.hub.publish(event, value);
    }
}

/// The host app's own adapter calls (its UI, not a joined user): recorded as `host` activity while the server runs.
pub fn record_local_call(app: &AppHandle, cmd: &str, target: &str, method: &str, args: &[Value], ok: bool) {
    let Some(remote) = app.try_state::<Arc<Remote>>() else { return };
    if remote.client.is_some() || !remote.serving.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let call_args = json!({ "target": target, "method": method, "args": args });
    let Some(info) = policy::describe_call(&remote.mirror.read(), cmd, &call_args) else { return };
    let actor = Actor { user: None, device_id: String::new(), device_name: computer_name(), device_kind: "host".into() };
    remote.record_activity(actor, info, &format!("{target}.{method}"), ok);
}

/// `$znoti.createNotification` hook: joined users who may see the conversation get it too.
pub fn forward_notification(app: &AppHandle, title: &str, body: &str, tag: &str, silent: bool, image: Option<&[u8]>) {
    let Some(remote) = app.try_state::<Arc<Remote>>() else { return };
    if !remote.hub.has_clients() {
        return;
    }
    use base64::Engine as _;
    let image = image.filter(|d| d.len() <= MAX_NOTIFICATION_IMAGE).map(|d| base64::engine::general_purpose::STANDARD.encode(d));
    remote.hub.publish(NOTIFICATION_EVENT, json!({ "title": title, "body": body, "tag": tag, "silent": silent, "image": image }));
}

// ---- commands: host ----

type RemoteState<'a> = State<'a, Arc<Remote>>;

/// Quick mode check for the UI's transport: `{mode: local|joined, connection?}`.
#[tauri::command]
pub fn remote_status(remote: RemoteState<'_>) -> Value {
    match &remote.client {
        Some(c) => json!({ "mode": "joined", "connection": c.status_json() }),
        None => json!({ "mode": "local" }),
    }
}

/// Everything Settings › Compola Server shows.
#[tauri::command]
pub async fn remote_state(remote: RemoteState<'_>) -> Result<Value, String> {
    Ok(remote.state_json().await)
}

#[tauri::command]
pub async fn remote_set_server(remote: RemoteState<'_>, config: ServerConfig) -> Result<(), String> {
    if remote.is_joined() {
        return Err("Máy này đang tham gia một Compola Server khác.".into());
    }
    if config.port < 1024 {
        return Err("Cổng phải từ 1024 đến 65535".into());
    }
    let previous = remote.server_config();
    remote.update_config(|c| {
        c.server.enabled = config.enabled;
        c.server.port = config.port;
        c.server.allow_network = config.allow_network;
    })?;
    remote.update_server_identity(Some(config.name), Some(config.public_url))?;
    let next = remote.server_config();
    let listener_changed = next.enabled != previous.enabled || next.port != previous.port || next.allow_network != previous.allow_network;
    if listener_changed || (next.enabled && remote.server.lock().await.is_none()) {
        remote.inner().apply_server().await;
    }
    Ok(())
}

/// The first admin account (only while there is none).
#[tauri::command]
pub fn remote_admin_setup(remote: RemoteState<'_>, username: String, password: String, display_name: Option<String>) -> Result<Value, String> {
    let auth = remote.auth().ok_or("Không mở được cơ sở dữ liệu tài khoản.")?;
    if auth.store.count_admins().map_err(|e| e.message)? > 0 {
        return Err("Đã có quản trị viên. Quản lý tài khoản trong trang quản trị.".into());
    }
    let hash = auth::hash_password(&password).map_err(|e| e.message)?;
    let user = auth.store.create_user(&username, display_name.as_deref().unwrap_or_default(), "", "local", Some(&hash), true).map_err(|e| e.message)?;
    auth.store.audit(Some(&user), "user.create", &user.username, json!({ "isAdmin": true, "via": "host app" }), "127.0.0.1");
    remote.update_config(|c| c.owner_user_id = user.id.clone())?;
    remote.changed();
    Ok(json!(user))
}

/// Opens the admin console in the browser, signed in as the owner (a one-time link).
#[tauri::command]
pub async fn remote_admin_open(remote: RemoteState<'_>, next: Option<String>) -> Result<String, String> {
    let next = next.filter(|n| n.starts_with("/admin/")).unwrap_or_else(|| "/admin/".into());
    // Joined: the console of the server, signed in as this device's user.
    if let Some(client) = &remote.client {
        let url = client.admin_link(&next).await?;
        tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())?;
        return Ok(url);
    }
    let auth = remote.auth().ok_or("Không mở được cơ sở dữ liệu tài khoản.")?;
    let Some(port) = remote.server.lock().await.as_ref().map(|h| h.port) else {
        return Err("Bật Compola Server trước.".into());
    };
    let user = remote.owner(&auth)?;
    let next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
    let url = format!("http://127.0.0.1:{port}/api/auth/otp?t={}&next={next}", auth.otp_create(&user.id));
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(url)
}

/// The server's REST API (`path` below `/api/`, e.g. `admin/users`) for the app's native admin screens: as this
/// device's user when joined, as the owner on the host. The server checks the rights of every call.
#[tauri::command]
pub async fn remote_api(remote: RemoteState<'_>, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "PUT" | "DELETE") {
        return Err("bad method".into());
    }
    let path = path.trim_start_matches('/').to_owned();
    if path.contains("..") || path.contains("://") || !(path.starts_with("admin/") || path.starts_with("me") || path.starts_with("device/")) {
        return Err("bad path".into());
    }
    if let Some(client) = &remote.client {
        return client.api(&method, &path, body).await;
    }
    let auth = remote.auth().ok_or("Không mở được cơ sở dữ liệu tài khoản.")?;
    let Some(port) = remote.server.lock().await.as_ref().map(|h| h.port) else {
        return Err("Bật Compola Server trước.".into());
    };
    let base = url::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    let http = reqwest::Client::new();
    for attempt in 0..2 {
        let token = match remote.owner_token.lock().clone() {
            Some(t) => t,
            None => {
                let user = remote.owner(&auth)?;
                let (_, t) = auth.store.create_session(&user.id, "web", "", "Ứng dụng Compola (máy chủ)", "127.0.0.1", auth::WEB_TTL_MS).map_err(|e| e.message)?;
                *remote.owner_token.lock() = Some(t.clone());
                t
            }
        };
        match client::api_call(&http, &base, &token, &method, &path, body.clone()).await {
            // The owner session expired or was revoked: a new one, once.
            Err(e) if attempt == 0 && auth.store.session_by_token(&token, "127.0.0.1", None).ok().flatten().is_none() => {
                log::debug!("compola server: owner session renewed ({e})");
                *remote.owner_token.lock() = None;
            }
            other => return other,
        }
    }
    Err("Không gọi được máy chủ.".into())
}

/// Revokes a joined session (the person signs in again to come back).
#[tauri::command]
pub fn remote_kick(remote: RemoteState<'_>, session_id: String) -> Result<bool, String> {
    let id = session_id;
    let auth = remote.auth().ok_or("Không mở được cơ sở dữ liệu tài khoản.")?;
    let session = auth.store.delete_session(&id).map_err(|e| e.message)?;
    if let Some(s) = &session {
        auth.store.audit(None, "session.revoke", &s.device_name, json!({ "userId": s.user_id, "deviceId": s.device_id, "via": "host app" }), "127.0.0.1");
    }
    remote.session_revoked(&id);
    Ok(session.is_some())
}

// ---- commands: joining ----

/// Checks the address and lists how to sign in: `{url, serverName, local, ldap, oidc}`.
#[tauri::command]
pub async fn remote_providers(remote: RemoteState<'_>, url: String) -> Result<Value, String> {
    let base = client::normalize_url(&url)?;
    let mut providers = client::providers(&base).await?;
    remote.check_join(&providers)?;
    providers["url"] = json!(base.to_string());
    Ok(providers)
}

fn device_name_or_default(name: &str) -> String {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
    if n.is_empty() { computer_name() } else { n }
}

/// Username + password (local or LDAP): saves the device sign-in and restarts joined.
#[tauri::command]
pub async fn remote_join_password(
    app: AppHandle,
    remote: RemoteState<'_>,
    url: String,
    username: String,
    password: String,
    provider: Option<String>,
    device_name: String,
) -> Result<(), String> {
    if remote.is_joined() {
        return Err("Máy này đang tham gia một Compola Server khác.".into());
    }
    let base = client::normalize_url(&url)?;
    let server = client::providers(&base).await?;
    remote.check_join(&server)?;
    let device_name = device_name_or_default(&device_name);
    let instance = remote.config.lock().instance.clone();
    let signed_in = client::login_password(&base, &username, &password, provider.as_deref().unwrap_or("local"), &device_name, &instance).await?;
    let server_name = server.get("serverName").and_then(Value::as_str).unwrap_or_default().to_owned();
    remote.save_join(JoinConfig {
        url: base.to_string(),
        token: signed_in.token,
        device_name,
        server_name,
        username: signed_in.username,
        display_name: signed_in.display_name,
    })?;
    log::info!("compola server: joined {}", base.host_str().unwrap_or_default());
    app.restart();
}

/// Sign-in through the browser (any provider, SSO included): device flow, then saves and restarts joined.
#[tauri::command]
pub async fn remote_join_browser(
    app: AppHandle,
    remote: RemoteState<'_>,
    url: String,
    device_name: String,
    provider: Option<String>,
) -> Result<(), String> {
    if remote.is_joined() {
        return Err("Máy này đang tham gia một Compola Server khác.".into());
    }
    let base = client::normalize_url(&url)?;
    let server = client::providers(&base).await?;
    remote.check_join(&server)?;
    let device_name = device_name_or_default(&device_name);
    let instance = remote.config.lock().instance.clone();
    let mut start = client::device_start(&base, &device_name, &instance).await?;
    // An SSO button: straight to that provider, which comes back to the approval page.
    if let Some(p) = provider.filter(|p| !p.is_empty() && p != "local") {
        let next: String = url::form_urlencoded::byte_serialize(format!("/admin/#/device?code={}", start.user_code).as_bytes()).collect();
        let pid: String = url::form_urlencoded::byte_serialize(p.as_bytes()).collect();
        let code: String = url::form_urlencoded::byte_serialize(start.user_code.as_bytes()).collect();
        start.verify_url = format!("{}api/auth/oidc/{pid}/start?next={next}&device={code}", base);
    }
    let _ = app.emit_to("main", EVENT, json!({ "kind": "joinProgress", "userCode": start.user_code, "verifyUrl": start.verify_url, "expiresIn": start.expires_in }));
    tauri_plugin_opener::open_url(&start.verify_url, None::<&str>).map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    *remote.join_cancel.lock() = Some(tx);
    let outcome = tokio::select! {
        r = client::device_wait(&base, &start) => r,
        _ = rx => Err("Đã huỷ.".into()),
    };
    remote.join_cancel.lock().take();
    let signed_in = outcome?;
    let server_name = server.get("serverName").and_then(Value::as_str).unwrap_or_default().to_owned();
    remote.save_join(JoinConfig {
        url: base.to_string(),
        token: signed_in.token,
        device_name,
        server_name,
        username: signed_in.username,
        display_name: signed_in.display_name,
    })?;
    app.restart();
}

#[tauri::command]
pub fn remote_join_cancel(remote: RemoteState<'_>) {
    if let Some(tx) = remote.join_cancel.lock().take() {
        let _ = tx.send(());
    }
}

/// Leaves the server (signs this device out there when reachable) and restarts with the app's own engine.
#[tauri::command]
pub async fn remote_leave(app: AppHandle, remote: RemoteState<'_>) -> Result<(), String> {
    if let Some(c) = &remote.client {
        c.sign_out().await;
    }
    remote.update_config(|c| c.join = None)?;
    app.restart();
}

/// Reconnect now instead of waiting for the next attempt.
#[tauri::command]
pub fn remote_retry(remote: RemoteState<'_>) {
    if let Some(c) = &remote.client {
        c.retry_now();
    }
}

/// Resolves once connected to the server (the UI's boot waits for it before reading the phase and replay).
#[tauri::command]
pub async fn remote_wait_connected(remote: RemoteState<'_>) -> Result<(), String> {
    let client = remote.client.clone().ok_or("not joined")?;
    client.wait_connected(None).await
}

/// One of the engine's commands, run by the host.
#[tauri::command]
pub async fn remote_invoke(remote: RemoteState<'_>, command: String, args: Option<Value>) -> Result<Value, String> {
    let client = remote.client.clone().ok_or("not joined")?;
    client.invoke(&command, args.unwrap_or_else(|| json!({}))).await
}

/// `engine_call_with_files` of a joined app: the files (picked here when `files` is null) are uploaded first.
#[tauri::command]
pub async fn remote_call_with_files(
    remote: RemoteState<'_>,
    target: String,
    method: String,
    args: Vec<Value>,
    files: Option<Vec<String>>,
    pick: Option<String>,
) -> Result<Value, String> {
    let client = remote.client.clone().ok_or("not joined")?;
    client.call_with_files(target, method, args, files, pick).await
}

/// `media_save` of a joined app: downloaded through the host.
#[tauri::command]
pub async fn remote_media_save(remote: RemoteState<'_>, url: String, dest_path: String) -> Result<String, String> {
    let client = remote.client.clone().ok_or("not joined")?;
    client.media_save(&url, &dest_path).await
}

/// `media_open_file` of a joined app: downloaded through the host, then opened (or revealed) here.
#[tauri::command]
pub async fn remote_media_open_file(remote: RemoteState<'_>, url: String, name: Option<String>) -> Result<Value, String> {
    let client = remote.client.clone().ok_or("not joined")?;
    client.media_open_file(&url, name.as_deref().unwrap_or_default()).await
}
