//! Compola Server: one Compola app shares its signed-in Zalo account, other Compola apps join it and use that account
//! remotely (docs/compola-server.md).
//!
//! * **Host** (`server`): Settings › Compola Server. HTTP + WebSocket on `0.0.0.0:<port>` (or loopback only, for a
//!   tunnel / reverse proxy). Every request carries `Authorization: Bearer <access code>`. The UI contract of the
//!   engine travels over `/ws`: the joined app's commands (`engine_call`, `engine_replay`, …, an allow-list) and the
//!   engine's UI events (`compola://phase|state|badge|page`) plus the renderer's notifications. Media and files go over
//!   plain HTTP (`/media/load` answers exactly like the `compola-media` scheme, `/upload` takes the files to send).
//! * **Joined app** (`client`): the login screen's "Compola Server" tab. The local engine does not start; Rust keeps
//!   one WebSocket to the host, re-emits its events to the UI window, forwards the UI's commands (`remote_invoke`) and
//!   the `compola-media` requests, uploads picked files before sending them, and shows the host's notifications.
//!
//! The Zalo session (cookies, databases, keys) never leaves the host: a joined app only sees what the UI sees.

mod client;
mod http;
mod server;

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

pub use client::Client;

pub const DEFAULT_PORT: u16 = 39218;
/// UI event about Compola Server: `{kind: "changed"}` (host settings, devices) or `{kind: "connection", …status}`.
pub const EVENT: &str = "compola://remote";
/// The engine events a joined app's UI receives.
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
    /// The access code joined apps present (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`).
    pub code: String,
    /// Shown to joined apps.
    pub name: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, allow_network: true, code: new_code(), name: computer_name() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct JoinConfig {
    /// Normalized base URL (`http(s)://host:port/`).
    pub url: String,
    pub code: String,
    pub device_name: String,
    pub server_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LastJoin {
    pub url: String,
    pub device_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Random id of this installation (an app may not join itself).
    pub instance: String,
    pub server: ServerConfig,
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
    if config.instance.is_empty() {
        config.instance = uuid::Uuid::new_v4().simple().to_string();
        let _ = save(&config);
    }
    if normalize_code(&config.server.code).len() < 20 {
        config.server.code = new_code();
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

/// No 0/O, 1/I/L: easy to read out and type on another machine.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// 25 characters from a 31-letter alphabet (≈124 bits), in groups of five.
pub fn new_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..5)
        .map(|_| (0..5).map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char).collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// Upper case, letters and digits only (dashes and spaces typed or pasted along are ignored).
pub fn normalize_code(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// Constant-time comparison of two normalized codes.
pub fn codes_match(expected: &str, given: &str) -> bool {
    let (a, b) = (normalize_code(expected), normalize_code(given));
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
}

impl Remote {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let config = load();
        let client = config.join.clone().and_then(|join| match Client::new(app.clone(), join) {
            Ok(c) => Some(c),
            Err(e) => {
                log::warn!("compola server: saved join is unusable ({e}); starting locally");
                None
            }
        });
        Arc::new(Self {
            app,
            config: Mutex::new(config),
            hub: Arc::new(server::Hub::new()),
            server: tokio::sync::Mutex::new(None),
            server_error: Mutex::new(None),
            client,
        })
    }

    /// Joined to a Compola Server: the local engine must not start.
    pub fn is_joined(&self) -> bool {
        self.client.is_some()
    }

    pub fn start(self: &Arc<Self>) {
        if let Some(client) = &self.client {
            client.start();
            return;
        }
        if self.config.lock().server.enabled {
            let this = self.clone();
            tauri::async_runtime::spawn(async move { this.apply_server().await });
        }
    }

    fn server_config(&self) -> ServerConfig {
        self.config.lock().server.clone()
    }

    fn changed(&self) {
        let _ = self.app.emit_to("main", EVENT, json!({ "kind": "changed" }));
    }

    /// (Re)starts or stops the listener for the saved settings; connected apps are dropped either way.
    async fn apply_server(self: &Arc<Self>) {
        let config = self.server_config();
        let mut slot = self.server.lock().await;
        *slot = None;
        self.hub.kick_all("restarted");
        *self.server_error.lock() = None;
        if config.enabled && self.client.is_none() {
            match server::start(Arc::downgrade(self), config.port, config.allow_network).await {
                Ok(handle) => *slot = Some(handle),
                Err(e) => {
                    log::warn!("compola server: {e}");
                    *self.server_error.lock() = Some(e);
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
        self.app.try_state::<Arc<crate::engine::Engine>>().map(|e| e.inner().clone())
    }

    fn phase_kind(&self) -> String {
        self.engine()
            .and_then(|e| serde_json::to_value(e.phase()).ok())
            .and_then(|v| v.get("kind").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "starting".into())
    }

    async fn state_json(&self) -> Value {
        let config = self.config.lock().clone();
        let running = self.server.lock().await.as_ref().map(|h| h.port);
        json!({
            "mode": if self.is_joined() { "joined" } else { "local" },
            "computerName": computer_name(),
            "server": {
                "config": config.server,
                "running": running.is_some(),
                "error": self.server_error.lock().clone(),
                "addresses": local_addresses(),
                "clients": self.hub.clients_json(),
            },
            "join": config.join.as_ref().map(|j| json!({ "url": j.url, "deviceName": j.device_name, "serverName": j.server_name })),
            "lastJoin": config.last_join,
            "connection": self.client.as_ref().map(|c| c.status_json()),
        })
    }
}

/// The client of a joined app (None when the app runs its own engine).
pub fn client(app: &AppHandle) -> Option<Arc<Client>> {
    app.try_state::<Arc<Remote>>().and_then(|r| r.client.clone())
}

/// `emit_ui` hook: hands the engine's UI events to the joined apps.
pub fn forward_event<S: Serialize>(app: &AppHandle, event: &str, payload: &S) {
    if !FORWARDED.contains(&event) {
        return;
    }
    let Some(remote) = app.try_state::<Arc<Remote>>() else { return };
    if remote.hub.has_clients() {
        remote.hub.publish(&json!({ "t": "event", "event": event, "payload": payload }));
    }
}

/// `$znoti.createNotification` hook: joined apps show the notification too.
pub fn forward_notification(app: &AppHandle, title: &str, body: &str, tag: &str, silent: bool, image: Option<&[u8]>) {
    let Some(remote) = app.try_state::<Arc<Remote>>() else { return };
    if !remote.hub.has_clients() {
        return;
    }
    use base64::Engine as _;
    let image = image.filter(|d| d.len() <= MAX_NOTIFICATION_IMAGE).map(|d| base64::engine::general_purpose::STANDARD.encode(d));
    remote.hub.publish(&json!({
        "t": "event",
        "event": NOTIFICATION_EVENT,
        "payload": { "title": title, "body": body, "tag": tag, "silent": silent, "image": image },
    }));
}

// ---- commands ----

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
    let name = config.name.trim().chars().take(60).collect::<String>();
    remote.update_config(|c| {
        c.server = ServerConfig { code: previous.code.clone(), name: if name.is_empty() { computer_name() } else { name }, ..config };
    })?;
    let next = remote.server_config();
    let listener_changed = next.enabled != previous.enabled || next.port != previous.port || next.allow_network != previous.allow_network;
    if listener_changed || remote.server.lock().await.is_none() && next.enabled {
        remote.inner().apply_server().await;
    } else {
        remote.changed();
    }
    Ok(())
}

/// New access code: every joined app is disconnected and needs the new code.
#[tauri::command]
pub fn remote_regenerate_code(remote: RemoteState<'_>) -> Result<String, String> {
    let code = new_code();
    remote.update_config(|c| c.server.code = code.clone())?;
    remote.hub.kick_all("codeChanged");
    remote.changed();
    Ok(code)
}

#[tauri::command]
pub fn remote_kick(remote: RemoteState<'_>, id: String) -> bool {
    let kicked = remote.hub.kick(&id, "kicked");
    remote.changed();
    kicked
}

/// Checks the server and the code, saves the join and restarts the app joined.
#[tauri::command]
pub async fn remote_join(app: AppHandle, remote: RemoteState<'_>, url: String, code: String, device_name: String) -> Result<(), String> {
    if remote.is_joined() {
        return Err("Máy này đang tham gia một Compola Server khác.".into());
    }
    let base = client::normalize_url(&url)?;
    let code = normalize_code(&code);
    if code.len() < 20 {
        return Err("Mã truy cập gồm 25 ký tự, dạng XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.".into());
    }
    let info = client::probe(&base, &code).await?;
    if info.instance == remote.config.lock().instance {
        return Err("Đây là Compola Server của chính máy này.".into());
    }
    let device_name = device_name.trim().chars().take(60).collect::<String>();
    let device_name = if device_name.is_empty() { computer_name() } else { device_name };
    remote.update_config(|c| {
        c.join = Some(JoinConfig { url: base.to_string(), code, device_name: device_name.clone(), server_name: info.name.clone() });
        c.last_join = Some(LastJoin { url: base.to_string(), device_name: device_name.clone() });
    })?;
    log::info!("compola server: joining {}", base.host_str().unwrap_or_default());
    app.restart();
}

/// Leaves the server and restarts the app with its own engine (the host's account stays signed in).
#[tauri::command]
pub fn remote_leave(app: AppHandle, remote: RemoteState<'_>) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_long_unambiguous_and_compared_loosely() {
        let code = new_code();
        assert_eq!(code.len(), 29);
        assert_eq!(normalize_code(&code).len(), 25);
        assert!(!code.contains(['0', 'O', '1', 'I', 'L']));
        assert!(codes_match(&code, &code.to_lowercase().replace('-', " ")));
        assert!(!codes_match(&code, &new_code()));
        assert!(!codes_match("", ""));
        assert!(!codes_match(&code, &code[..20]));
    }
}
