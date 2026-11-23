//! `/api/*` (sign-in, device flow, admin) and `/admin/*` (the admin console, built by `npm run build:admin` into
//! `src-tauri/admin-dist` and embedded). Contract: docs/compola-server.md.

use std::sync::Arc;

use include_dir::{Dir, include_dir};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Remote;
use super::auth::{self, Auth};
use super::http::Head;
use super::policy::{Role, Scope};
use super::store::{Session, StoreError, Subject, User, UserPatch};

static ADMIN: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/admin-dist");

pub const COOKIE: &str = "compola_session";
/// Largest JSON body.
pub const MAX_BODY: u64 = 1 << 20;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into()), ("Cache-Control".into(), "no-store".into())],
            body: serde_json::to_vec(&value).unwrap_or_default(),
        }
    }

    fn ok(value: Value) -> Self {
        Self::json(200, value)
    }

    fn error(e: StoreError) -> Self {
        Self::json(e.status, json!({ "error": e.message }))
    }

    fn redirect(location: &str) -> Self {
        Self { status: 302, headers: vec![("Location".into(), location.into()), ("Cache-Control".into(), "no-store".into())], body: Vec::new() }
    }

    fn with_header(mut self, k: &str, v: String) -> Self {
        self.headers.push((k.into(), v));
        self
    }
}

type R<T> = Result<T, StoreError>;

fn bad(message: impl Into<String>) -> StoreError {
    StoreError::new(400, message)
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> R<T> {
    serde_json::from_slice(if body.is_empty() { b"{}" } else { body }).map_err(|e| bad(format!("Dữ liệu không hợp lệ: {e}")))
}

fn cookie_value(head: &Head, name: &str) -> Option<String> {
    head.headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        .flat_map(|(_, v)| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim().to_owned())
}

/// The session token of a request: the joined app's bearer token or the admin console's cookie.
pub fn request_token(head: &Head) -> Option<String> {
    head.bearer().map(str::to_owned).or_else(|| cookie_value(head, COOKIE)).filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub struct Ctx<'a> {
    pub remote: &'a Arc<Remote>,
    pub auth: &'a Arc<Auth>,
    pub head: &'a Head,
    pub body: &'a [u8],
    pub ip: String,
}

impl Ctx<'_> {
    fn secure(&self) -> bool {
        self.head.header("x-forwarded-proto").is_some_and(|p| p.eq_ignore_ascii_case("https")) || self.remote.public_url().starts_with("https://")
    }

    fn session_cookie(&self, token: &str) -> String {
        format!(
            "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
            auth::WEB_TTL_MS / 1000,
            if self.secure() { "; Secure" } else { "" }
        )
    }

    fn clear_cookie(&self) -> String {
        format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}", if self.secure() { "; Secure" } else { "" })
    }

    /// A web session's label: "Chrome · macOS" from the User-Agent (the console's sessions have no device id).
    fn browser(&self) -> String {
        browser_label(self.head.header("user-agent").unwrap_or_default())
    }

    fn current(&self) -> R<(Session, User)> {
        let token = request_token(self.head).ok_or_else(|| StoreError::new(401, "Chưa đăng nhập."))?;
        let slide = (self.head.bearer().is_some()).then_some(auth::DEVICE_TTL_MS);
        self.auth.store.session_by_token(&token, &self.ip, slide)?.ok_or_else(|| StoreError::new(401, "Phiên đăng nhập đã hết hạn."))
    }

    fn admin(&self) -> R<User> {
        let (_, user) = self.current()?;
        if !user.is_admin {
            return Err(StoreError::new(403, "Bạn không có quyền quản trị."));
        }
        Ok(user)
    }

    fn audit(&self, actor: &User, action: &str, target: &str, detail: Value) {
        self.auth.store.audit(Some(actor), action, target, detail, &self.ip);
    }
}

pub fn browser_label(ua: &str) -> String {
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        "Opera"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "Trình duyệt"
    };
    let os = if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() { browser.to_owned() } else { format!("{browser} · {os}") }
}

/// `next` must stay inside the admin console (no open redirect).
fn safe_next(next: Option<String>) -> String {
    next.filter(|n| n.starts_with("/admin/") && !n.starts_with("//") && !n.contains(['\r', '\n', '\\'])).unwrap_or_else(|| "/admin/".into())
}

fn encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// ---- entry ----

pub async fn handle(remote: &Arc<Remote>, head: &Head, body: &[u8], ip: &str) -> Reply {
    let Some(auth) = remote.auth() else {
        return Reply::json(503, json!({ "error": "Không mở được cơ sở dữ liệu tài khoản của Compola Server." }));
    };
    let ctx = Ctx { remote, auth: &auth, head, body, ip: ip.to_owned() };
    // Requests that change something must come from our own pages / apps (a cross-site form cannot set this header).
    let reads = head.method == "GET" || head.method == "HEAD";
    let browser_flow = head.path() == "/api/auth/oidc/callback" || head.path() == "/api/auth/otp" || head.path().ends_with("/start");
    if !reads && head.header("x-compola") != Some("1") {
        return Reply::json(403, json!({ "error": "Thiếu header X-Compola." }));
    }
    let segments: Vec<&str> = head.path().trim_start_matches("/api/").split('/').filter(|s| !s.is_empty()).collect();
    let result = route(&ctx, head.method.as_str(), &segments).await;
    match result {
        Ok(reply) => reply,
        Err(e) if browser_flow && head.method == "GET" => Reply::redirect(&format!("/admin/#/login?error={}", encode(&e.message))),
        Err(e) => Reply::error(e),
    }
}

async fn route(ctx: &Ctx<'_>, method: &str, seg: &[&str]) -> R<Reply> {
    match (method, seg) {
        // ---- public / sign-in ----
        ("GET", ["auth", "providers"]) => providers_public(ctx),
        ("POST", ["auth", "login"]) => login(ctx).await,
        ("GET", ["auth", "oidc", "callback"]) => oidc_callback(ctx).await,
        ("GET", ["auth", "oidc", id, "start"]) => {
            let redirect_uri = format!("{}/api/auth/oidc/callback", ctx.remote.public_url());
            let device = ctx.head.param("device").filter(|d| !d.is_empty());
            let next = safe_next(ctx.head.param("next"));
            Ok(Reply::redirect(&ctx.auth.oidc_start(id, &redirect_uri, &next, device).await?))
        }
        ("GET", ["auth", "otp"]) => {
            let user_id = ctx.head.param("t").and_then(|t| ctx.auth.otp_take(&t)).ok_or_else(|| StoreError::new(401, "Liên kết đã hết hạn. Mở lại từ Compola."))?;
            let user = ctx.auth.store.user(&user_id)?;
            let (_, token) = ctx.auth.store.create_session(&user.id, "web", "", &ctx.browser(), &ctx.ip, auth::WEB_TTL_MS)?;
            ctx.audit(&user, "login", "owner", json!({ "method": "owner-link" }));
            Ok(Reply::redirect("/admin/").with_header("Set-Cookie", ctx.session_cookie(&token)))
        }
        ("POST", ["auth", "logout"]) => {
            if let Some(token) = request_token(ctx.head) {
                if let Some(session) = ctx.auth.store.delete_session_by_token(&token)? {
                    ctx.remote.session_revoked(&session.id);
                    if let Ok(user) = ctx.auth.store.user(&session.user_id) {
                        ctx.audit(&user, "logout", &session.device_name, json!({ "kind": session.kind, "deviceId": session.device_id }));
                    }
                }
            }
            Ok(Reply::ok(json!({ "ok": true })).with_header("Set-Cookie", ctx.clear_cookie()))
        }
        ("GET", ["me"]) => {
            let (session, user) = ctx.current()?;
            let (access, via) = ctx.auth.store.access_of(&user)?;
            Ok(Reply::ok(json!({ "user": user, "session": session, "access": access, "via": via })))
        }

        ("GET", ["me", "sessions"]) => {
            let (current, user) = ctx.current()?;
            let list: Vec<Value> = ctx
                .auth
                .store
                .sessions()?
                .into_iter()
                .filter(|s| s.user_id == user.id)
                .map(|s| {
                    json!({
                        "id": s.id, "user": user.brief(), "kind": s.kind, "deviceId": s.device_id, "deviceName": s.device_name, "ip": s.ip,
                        "createdAt": s.created_at, "lastSeenAt": s.last_seen_at, "expiresAt": s.expires_at,
                        "online": ctx.remote.online_sessions().contains(&s.id), "current": s.id == current.id,
                    })
                })
                .collect();
            Ok(Reply::ok(json!(list)))
        }
        ("DELETE", ["me", "sessions", id]) => {
            let (_, user) = ctx.current()?;
            let mine = ctx.auth.store.sessions()?.into_iter().any(|s| s.id == *id && s.user_id == user.id);
            if !mine {
                return Err(StoreError::new(404, "Không tìm thấy phiên đăng nhập."));
            }
            if let Some(s) = ctx.auth.store.delete_session(id)? {
                ctx.remote.session_revoked(&s.id);
                ctx.audit(&user, "session.revoke", &s.device_name, json!({ "deviceId": s.device_id, "kind": s.kind, "own": true }));
            }
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // ---- device flow ----
        ("POST", ["device", "start"]) => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct B {
                device_name: String,
                device_id: String,
            }
            let b: B = parse(ctx.body)?;
            ctx.auth.check_brake(&ctx.ip)?;
            let (device_code, user_code) = ctx.auth.device_start(&b.device_name, &b.device_id, &ctx.ip);
            let verify_url = format!("{}/admin/#/device?code={user_code}", ctx.remote.public_url());
            Ok(Reply::ok(json!({ "deviceCode": device_code, "userCode": user_code, "verifyUrl": verify_url, "expiresIn": 600, "interval": 2 })))
        }
        ("POST", ["device", "poll"]) => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct B {
                device_code: String,
            }
            let b: B = parse(ctx.body)?;
            Ok(Reply::ok(ctx.auth.device_poll(&b.device_code)?))
        }
        ("GET", ["device", "info"]) => {
            ctx.current()?;
            let code = ctx.head.param("code").unwrap_or_default();
            ctx.auth.device_info(&code).map(Reply::ok).ok_or_else(|| StoreError::new(404, "Mã thiết bị không đúng hoặc đã hết hạn."))
        }
        ("POST", ["device", "approve"]) => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct B {
                user_code: String,
                approve: bool,
            }
            let (_, user) = ctx.current()?;
            let b: B = parse(ctx.body)?;
            ctx.auth.device_approve(&b.user_code, &user, b.approve, &ctx.ip)?;
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // ---- admin ----
        (_, ["admin", rest @ ..]) => {
            let admin = ctx.admin()?;
            admin_route(ctx, &admin, method, rest).await
        }
        _ => Err(StoreError::new(404, "Không có API này.")),
    }
}

fn providers_public(ctx: &Ctx<'_>) -> R<Reply> {
    let providers = ctx.auth.store.providers()?;
    let list = |kind: &str| providers.iter().filter(|p| p.enabled && p.kind == kind).map(|p| json!({ "id": p.id, "name": p.name })).collect::<Vec<_>>();
    Ok(Reply::ok(json!({ "serverName": ctx.remote.server_name(), "local": true, "ldap": list("ldap"), "oidc": list("oidc") })))
}

async fn login(ctx: &Ctx<'_>) -> R<Reply> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Device {
        name: String,
        id: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct B {
        username: String,
        password: String,
        provider: String,
        device: Option<Device>,
    }
    let b: B = parse(ctx.body)?;
    let user = ctx.auth.login_password(&b.username, &b.password, &b.provider, &ctx.ip).await?;
    match b.device {
        Some(device) => {
            if ctx.auth.store.access_of(&user)?.0.is_none() {
                return Err(StoreError::new(403, "Tài khoản của bạn chưa được cấp quyền dùng tài khoản Zalo này. Liên hệ quản trị viên."));
            }
            let (_, token) = ctx.auth.store.create_session(&user.id, "device", &device.id, &device.name, &ctx.ip, auth::DEVICE_TTL_MS)?;
            Ok(Reply::ok(json!({ "token": token, "user": user.brief() })))
        }
        None => {
            let (_, token) = ctx.auth.store.create_session(&user.id, "web", "", &ctx.browser(), &ctx.ip, auth::WEB_TTL_MS)?;
            Ok(Reply::ok(json!({ "user": user })).with_header("Set-Cookie", ctx.session_cookie(&token)))
        }
    }
}

async fn oidc_callback(ctx: &Ctx<'_>) -> R<Reply> {
    if let Some(error) = ctx.head.param("error") {
        let reason = ctx.head.param("error_description").unwrap_or(error);
        return Err(StoreError::new(401, format!("Nhà cung cấp SSO từ chối: {reason}")));
    }
    let code = ctx.head.param("code").unwrap_or_default();
    let state = ctx.head.param("state").unwrap_or_default();
    let (user, next, device) = ctx.auth.oidc_callback(&code, &state, &ctx.ip).await?;
    let (_, token) = ctx.auth.store.create_session(&user.id, "web", "", &ctx.browser(), &ctx.ip, auth::WEB_TTL_MS)?;
    let target = match device {
        Some(code) => format!("/admin/#/device?code={}", encode(&code)),
        None => next,
    };
    Ok(Reply::redirect(&target).with_header("Set-Cookie", ctx.session_cookie(&token)))
}

// ---- admin routes ----

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct NewUser {
    username: String,
    display_name: String,
    email: String,
    password: Option<String>,
    is_admin: bool,
    /// `local` (default, needs a password) or `ldap:<id>` / `oidc:<id>` (pre-created external user).
    source: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GroupBody {
    name: Option<String>,
    description: Option<String>,
    user_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantBody {
    subject: Option<Subject>,
    role: Option<Role>,
    scope: Option<Scope>,
    note: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ProviderBody {
    kind: String,
    name: Option<String>,
    enabled: Option<bool>,
    config: Option<Value>,
}

async fn admin_route(ctx: &Ctx<'_>, admin: &User, method: &str, seg: &[&str]) -> R<Reply> {
    let store = &ctx.auth.store;
    let remote = ctx.remote;
    match (method, seg) {
        // users
        ("GET", ["users"]) => Ok(Reply::ok(json!(store.users()?))),
        ("POST", ["users"]) => {
            let b: NewUser = parse(ctx.body)?;
            let source = b.source.unwrap_or_else(|| "local".into());
            let hash = if source == "local" {
                Some(auth::hash_password(b.password.as_deref().unwrap_or_default())?)
            } else {
                let (kind, id) = source.split_once(':').ok_or_else(|| bad("Nguồn tài khoản không hợp lệ."))?;
                let p = store.provider(id)?;
                if p.kind != kind {
                    return Err(bad("Nguồn tài khoản không hợp lệ."));
                }
                None
            };
            let user = store.create_user(&b.username, &b.display_name, &b.email, &source, hash.as_deref(), b.is_admin)?;
            ctx.audit(admin, "user.create", &user.username, json!({ "source": user.source, "isAdmin": user.is_admin }));
            Ok(Reply::json(201, json!(user)))
        }
        ("PATCH", ["users", id]) => {
            let patch: UserPatch = parse(ctx.body)?;
            let detail = json!({ "isAdmin": patch.is_admin, "disabled": patch.disabled });
            let user = store.update_user(id, patch)?;
            ctx.audit(admin, "user.update", &user.username, detail);
            remote.access_changed();
            Ok(Reply::ok(json!(user)))
        }
        ("POST", ["users", id, "password"]) => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct B {
                password: String,
            }
            let b: B = parse(ctx.body)?;
            store.set_password(id, &auth::hash_password(&b.password)?)?;
            let user = store.user(id)?;
            ctx.audit(admin, "user.password", &user.username, json!({}));
            Ok(Reply::ok(json!({ "ok": true })))
        }
        ("DELETE", ["users", id]) => {
            let user = store.delete_user(id)?;
            ctx.audit(admin, "user.delete", &user.username, json!({}));
            remote.access_changed();
            Ok(Reply::ok(json!({ "ok": true })))
        }
        ("GET", ["access", user_id]) => {
            let user = store.user(user_id)?;
            let (access, via) = store.access_of(&user)?;
            Ok(Reply::ok(json!({ "user": user.brief(), "role": access.as_ref().map(|a| a.role), "scope": access.map(|a| a.scope), "via": via })))
        }

        // groups
        ("GET", ["groups"]) => Ok(Reply::ok(json!(store.groups()?))),
        ("POST", ["groups"]) => {
            let b: GroupBody = parse(ctx.body)?;
            let mut group = store.create_group(b.name.as_deref().unwrap_or_default(), b.description.as_deref().unwrap_or_default(), "local")?;
            if !b.user_ids.is_empty() {
                group = store.set_members(&group.id, &b.user_ids)?;
            }
            ctx.audit(admin, "group.create", &group.name, json!({ "members": group.members.len() }));
            remote.access_changed();
            Ok(Reply::json(201, json!(group)))
        }
        ("PATCH", ["groups", id]) => {
            let b: GroupBody = parse(ctx.body)?;
            let group = store.update_group(id, b.name.as_deref(), b.description.as_deref())?;
            ctx.audit(admin, "group.update", &group.name, json!({}));
            Ok(Reply::ok(json!(group)))
        }
        ("PUT", ["groups", id, "members"]) => {
            let b: GroupBody = parse(ctx.body)?;
            let group = store.set_members(id, &b.user_ids)?;
            ctx.audit(admin, "group.members", &group.name, json!({ "members": group.members.len() }));
            remote.access_changed();
            Ok(Reply::ok(json!(group)))
        }
        ("DELETE", ["groups", id]) => {
            let group = store.delete_group(id)?;
            ctx.audit(admin, "group.delete", &group.name, json!({}));
            remote.access_changed();
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // grants
        ("GET", ["grants"]) => Ok(Reply::ok(json!(store.grants()?))),
        ("POST", ["grants"]) => {
            let b: GrantBody = parse(ctx.body)?;
            let subject = b.subject.ok_or_else(|| bad("Chọn người dùng hoặc nhóm."))?;
            let grant = store.create_grant(subject, b.role.unwrap_or(Role::Viewer), b.scope.unwrap_or_default(), b.note.as_deref().unwrap_or_default())?;
            ctx.audit(admin, "grant.create", &grant.subject.id, json!({ "role": grant.role, "scope": grant.scope }));
            remote.access_changed();
            Ok(Reply::json(201, json!(grant)))
        }
        ("PATCH", ["grants", id]) => {
            let b: GrantBody = parse(ctx.body)?;
            let grant = store.update_grant(id, b.role, b.scope, b.note.as_deref())?;
            ctx.audit(admin, "grant.update", &grant.subject.id, json!({ "role": grant.role, "scope": grant.scope }));
            remote.access_changed();
            Ok(Reply::ok(json!(grant)))
        }
        ("DELETE", ["grants", id]) => {
            let grant = store.delete_grant(id)?;
            ctx.audit(admin, "grant.delete", &grant.subject.id, json!({ "role": grant.role }));
            remote.access_changed();
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // providers
        ("GET", ["providers"]) => Ok(Reply::ok(json!(store.providers()?.iter().map(|p| p.public()).collect::<Vec<_>>()))),
        ("POST", ["providers"]) => {
            let b: ProviderBody = parse(ctx.body)?;
            let p = store.create_provider(&b.kind, b.name.as_deref().unwrap_or_default(), b.enabled.unwrap_or(true), b.config.unwrap_or_else(|| json!({})))?;
            ctx.audit(admin, "provider.create", &p.name, json!({ "kind": p.kind }));
            Ok(Reply::json(201, p.public()))
        }
        ("PATCH", ["providers", id]) => {
            let b: ProviderBody = parse(ctx.body)?;
            let p = store.update_provider(id, b.name.as_deref(), b.enabled, b.config)?;
            ctx.audit(admin, "provider.update", &p.name, json!({ "enabled": p.enabled }));
            Ok(Reply::ok(p.public()))
        }
        ("DELETE", ["providers", id]) => {
            let p = store.delete_provider(id)?;
            ctx.audit(admin, "provider.delete", &p.name, json!({}));
            Ok(Reply::ok(json!({ "ok": true })))
        }
        ("POST", ["providers", id, "test"]) => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct B {
                username: String,
                password: String,
            }
            let b: B = parse(ctx.body)?;
            let p = store.provider(id)?;
            Ok(Reply::ok(ctx.auth.test_provider(&p, &b.username, &b.password).await))
        }

        // sessions / devices
        ("GET", ["sessions"]) => {
            let users = store.users()?;
            let online = remote.online_sessions();
            let list: Vec<Value> = store
                .sessions()?
                .into_iter()
                .map(|s| {
                    let user = users.iter().find(|u| u.id == s.user_id).map(|u| u.brief());
                    json!({
                        "id": s.id, "user": user, "kind": s.kind, "deviceId": s.device_id, "deviceName": s.device_name,
                        "ip": s.ip, "createdAt": s.created_at, "lastSeenAt": s.last_seen_at, "expiresAt": s.expires_at,
                        "online": online.contains(&s.id),
                    })
                })
                .collect();
            Ok(Reply::ok(json!(list)))
        }
        ("DELETE", ["sessions", id]) => {
            if let Some(s) = store.delete_session(id)? {
                remote.session_revoked(&s.id);
                ctx.audit(admin, "session.revoke", &s.device_name, json!({ "userId": s.user_id, "deviceId": s.device_id, "kind": s.kind }));
            }
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // audit
        ("GET", ["audit"]) => {
            let limit = ctx.head.param("limit").and_then(|l| l.parse().ok()).unwrap_or(100);
            let before = ctx.head.param("before").and_then(|b| b.parse().ok());
            let user_id = ctx.head.param("userId").filter(|s| !s.is_empty());
            let action = ctx.head.param("action").filter(|s| !s.is_empty());
            Ok(Reply::ok(json!(store.audit_entries(limit, before, user_id.as_deref(), action.as_deref())?)))
        }

        // the host's Zalo account: status, sign-in by QR, sign-out (a host can be run headless / from afar)
        ("GET", ["zalo"]) => {
            let engine = remote.engine().ok_or_else(|| StoreError::new(503, "Engine chưa chạy."))?;
            Ok(Reply::ok(json!({ "phase": engine.phase(), "account": remote.account_json() })))
        }
        ("POST", ["zalo", "qr"]) => {
            let engine = remote.engine().ok_or_else(|| StoreError::new(503, "Engine chưa chạy."))?;
            engine.refresh_qr();
            ctx.audit(admin, "zalo.qr", "", json!({}));
            Ok(Reply::ok(json!({ "ok": true })))
        }
        ("POST", ["zalo", "logout"]) => {
            let engine = remote.engine().ok_or_else(|| StoreError::new(503, "Engine chưa chạy."))?;
            let account = remote.account_json();
            engine.log_out();
            ctx.audit(admin, "zalo.logout", account.get("name").and_then(Value::as_str).unwrap_or_default(), json!({}));
            Ok(Reply::ok(json!({ "ok": true })))
        }
        ("POST", ["zalo", "retry"]) => {
            let engine = remote.engine().ok_or_else(|| StoreError::new(503, "Engine chưa chạy."))?;
            engine.retry_runtime_setup();
            ctx.audit(admin, "zalo.retry", "", json!({}));
            Ok(Reply::ok(json!({ "ok": true })))
        }

        // the account
        ("GET", ["conversations"]) => Ok(Reply::ok(remote.mirror.read().conversations_json())),
        ("GET", ["server"]) => Ok(Reply::ok(remote.server_info_json())),
        ("PATCH", ["server"]) => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct B {
                name: Option<String>,
                public_url: Option<String>,
            }
            let b: B = parse(ctx.body)?;
            remote.update_server_identity(b.name, b.public_url).map_err(bad)?;
            ctx.audit(admin, "server.update", "", json!({}));
            Ok(Reply::ok(remote.server_info_json()))
        }
        _ => Err(StoreError::new(404, "Không có API này.")),
    }
}

// ---- admin console files ----

const ADMIN_MISSING: &str = "<!doctype html><meta charset=utf-8><title>Compola Server</title><body style=\"font-family:system-ui;padding:40px\">\
<h1>Compola Server</h1><p>Trang quản trị chưa được build. Chạy <code>npm run build:admin</code> rồi build lại ứng dụng.</p>";

pub fn admin_file(path: &str) -> Reply {
    let rel = path.trim_start_matches("/admin").trim_start_matches('/');
    let security = [
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        (
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ];
    let (file, cache) = match (!rel.is_empty()).then(|| ADMIN.get_file(rel)).flatten() {
        Some(f) => (Some(f), if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" }),
        // SPA: unknown paths get index.html.
        None => (ADMIN.get_file("index.html"), "no-cache"),
    };
    let mut reply = match file {
        Some(f) => {
            let mime = mime_guess::from_path(f.path()).first_or_octet_stream().to_string();
            Reply { status: 200, headers: vec![("Content-Type".into(), mime), ("Cache-Control".into(), cache.into())], body: f.contents().to_vec() }
        }
        None => Reply { status: 200, headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into())], body: ADMIN_MISSING.as_bytes().to_vec() },
    };
    reply.headers.extend(security.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    reply
}
