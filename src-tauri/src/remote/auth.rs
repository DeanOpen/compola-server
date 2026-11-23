//! Signing in to a Compola Server: local passwords (argon2id), LDAP (bind + search, groups), OpenID Connect / plain
//! OAuth 2 (authorization code + PKCE), the device flow joined apps use to sign in through the browser, one-time owner
//! links for the host app's "Mở trang quản trị", and a per-address brake on failed attempts.
//!
//! Account ≠ device: an identity is always a server user; directory / IdP users are matched to users of the same
//! provider by username (case-insensitive) and never take over a user of another source.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::Digest;

use super::store::{Provider, Store, StoreError, User};

type Result<T> = std::result::Result<T, StoreError>;

pub const WEB_TTL_MS: i64 = 12 * 3600 * 1000;
pub const DEVICE_TTL_MS: i64 = 90 * 24 * 3600 * 1000;
const DEVICE_REQUEST_TTL: Duration = Duration::from_secs(600);
const OIDC_PENDING_TTL: Duration = Duration::from_secs(600);
const OTP_TTL: Duration = Duration::from_secs(120);
const FAILURE_WINDOW: Duration = Duration::from_secs(600);
const MAX_FAILURES: usize = 8;
const MIN_PASSWORD: usize = 8;

fn err(status: u16, message: impl Into<String>) -> StoreError {
    StoreError::new(status, message)
}

// ---- passwords ----

pub fn hash_password(password: &str) -> Result<String> {
    use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
    if password.chars().count() < MIN_PASSWORD {
        return Err(err(400, format!("Mật khẩu cần ít nhất {MIN_PASSWORD} ký tự.")));
    }
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| err(500, e.to_string()))
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(hash).is_ok_and(|h| argon2::Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

/// Costs about as much as a real verification, so unknown usernames do not answer faster.
fn burn_password_check(password: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let hash = DUMMY.get_or_init(|| hash_password("compola-dummy-password").unwrap_or_default());
    let _ = verify_password(hash, password);
}

// ---- helpers ----

fn random_url_safe(bytes: usize) -> String {
    use base64::Engine as _;
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn user_code() -> String {
    use rand::Rng;
    const A: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let mut rng = rand::thread_rng();
    let part = |rng: &mut rand::rngs::ThreadRng| (0..4).map(|_| A[rng.gen_range(0..A.len())] as char).collect::<String>();
    format!("{}-{}", part(&mut rng), part(&mut rng))
}

fn normalize_user_code(code: &str) -> String {
    let c: String = code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect();
    if c.len() == 8 { format!("{}-{}", &c[..4], &c[4..]) } else { c }
}

fn cfg_str<'a>(config: &'a Value, key: &str) -> &'a str {
    config.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default()
}

fn cfg_bool(config: &Value, key: &str) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// What a directory / IdP says about a person.
#[derive(Debug, Default, Clone)]
pub struct Identity {
    pub username: String,
    pub display_name: String,
    pub email: String,
    pub groups: Vec<String>,
    /// Some when the provider maps an admin group.
    pub is_admin: Option<bool>,
}

struct OidcPending {
    provider_id: String,
    verifier: String,
    nonce: String,
    next: String,
    device: Option<String>,
    redirect_uri: String,
    at: Instant,
}

#[derive(Clone)]
struct Endpoints {
    authorization: String,
    token: String,
    userinfo: String,
}

enum DeviceStatus {
    Pending,
    Approved(String),
    Denied,
}

struct DeviceRequest {
    user_code: String,
    device_id: String,
    device_name: String,
    ip: String,
    created_at: i64,
    at: Instant,
    status: DeviceStatus,
}

pub struct Auth {
    pub store: Arc<Store>,
    http: reqwest::Client,
    oidc_pending: Mutex<HashMap<String, OidcPending>>,
    discovery: Mutex<HashMap<String, (Endpoints, Instant)>>,
    devices: Mutex<HashMap<String, DeviceRequest>>,
    otps: Mutex<HashMap<String, (String, Instant)>>,
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Auth {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            http: reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(20)).build().unwrap_or_default(),
            oidc_pending: Mutex::new(HashMap::new()),
            discovery: Mutex::new(HashMap::new()),
            devices: Mutex::new(HashMap::new()),
            otps: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
        }
    }

    // ---- brake ----

    pub fn check_brake(&self, ip: &str) -> Result<()> {
        let mut f = self.failures.lock();
        let list = f.entry(ip.to_owned()).or_default();
        list.retain(|t| t.elapsed() < FAILURE_WINDOW);
        if list.len() >= MAX_FAILURES {
            return Err(err(429, "Đăng nhập sai quá nhiều lần. Thử lại sau ít phút."));
        }
        Ok(())
    }

    fn note_failure(&self, ip: &str) {
        self.failures.lock().entry(ip.to_owned()).or_default().push(Instant::now());
    }

    // ---- password sign-in (local / LDAP) ----

    pub async fn login_password(&self, username: &str, password: &str, provider: &str, ip: &str) -> Result<User> {
        self.check_brake(ip)?;
        let result = if provider.is_empty() || provider == "local" {
            self.login_local(username, password)
        } else {
            let p = self.store.provider(provider)?;
            if p.kind != "ldap" || !p.enabled {
                return Err(err(400, "Nhà cung cấp đăng nhập này không dùng mật khẩu."));
            }
            match ldap_authenticate(&p.config, username, password).await {
                Ok(identity) => self.admit(&p, identity),
                Err(e) => Err(e),
            }
        };
        match &result {
            Ok(user) => {
                self.store.audit(Some(user), "login", provider_label(provider), json!({ "method": "password" }), ip);
            }
            Err(e) => {
                if e.status == 401 {
                    self.note_failure(ip);
                }
                self.store.audit(None, "login.failed", username.trim(), json!({ "provider": provider, "reason": e.message }), ip);
            }
        }
        result
    }

    fn login_local(&self, username: &str, password: &str) -> Result<User> {
        let wrong = || err(401, "Sai tên đăng nhập hoặc mật khẩu.");
        let Some(user) = self.store.user_by_name(username)? else {
            burn_password_check(password);
            return Err(wrong());
        };
        if user.source != "local" {
            burn_password_check(password);
            return Err(err(401, "Tài khoản này đăng nhập qua LDAP / SSO, không dùng mật khẩu nội bộ."));
        }
        let Some(hash) = self.store.password_hash(&user.id)? else { return Err(wrong()) };
        if !verify_password(&hash, password) {
            return Err(wrong());
        }
        if user.disabled {
            return Err(err(403, "Tài khoản đã bị khoá."));
        }
        self.store.touch_login(&user.id)?;
        Ok(user)
    }

    /// A directory / IdP identity → the server user (created just in time when the provider allows it).
    fn admit(&self, provider: &Provider, identity: Identity) -> Result<User> {
        let source = format!("{}:{}", provider.kind, provider.id);
        if identity.username.trim().is_empty() {
            return Err(err(401, "Nhà cung cấp không trả về tên đăng nhập."));
        }
        let user = match self.store.user_by_name(&identity.username)? {
            Some(u) if u.source == source => u,
            Some(u) => {
                return Err(err(
                    409,
                    format!(
                        "Tên đăng nhập «{}» đã thuộc về một tài khoản khác ({}). Quản trị viên cần đổi hoặc xoá tài khoản đó trước.",
                        u.username,
                        source_label(&u.source)
                    ),
                ));
            }
            None if cfg_bool(&provider.config, "autoCreate") => self.store.create_user(
                &identity.username,
                &identity.display_name,
                &identity.email,
                &source,
                None,
                identity.is_admin.unwrap_or(false),
            )?,
            None => return Err(err(403, "Tài khoản này chưa được quản trị viên thêm vào Compola Server.")),
        };
        if user.disabled {
            return Err(err(403, "Tài khoản đã bị khoá."));
        }
        self.store.refresh_external(&user.id, &identity.display_name, &identity.email, identity.is_admin)?;
        if provider.config.get("groupsClaim").is_some() || !cfg_str(&provider.config, "groupBaseDn").is_empty() {
            self.store.sync_external_groups(&user.id, &source, &identity.groups)?;
        }
        self.store.touch_login(&user.id)?;
        self.store.user(&user.id)
    }

    /// Settings › "Kiểm tra": connects (and, with credentials, signs in) without creating anything.
    pub async fn test_provider(&self, provider: &Provider, username: &str, password: &str) -> Value {
        match provider.kind.as_str() {
            "ldap" => {
                if username.trim().is_empty() {
                    match ldap_probe(&provider.config).await {
                        Ok(msg) => json!({ "ok": true, "message": msg }),
                        Err(e) => json!({ "ok": false, "message": e.message }),
                    }
                } else {
                    match ldap_authenticate(&provider.config, username, password).await {
                        Ok(id) => json!({ "ok": true, "message": "Đăng nhập LDAP thành công.", "user": {
                            "username": id.username, "displayName": id.display_name, "email": id.email, "groups": id.groups, "isAdmin": id.is_admin,
                        } }),
                        Err(e) => json!({ "ok": false, "message": e.message }),
                    }
                }
            }
            "oidc" => match self.endpoints(provider).await {
                Ok(e) => json!({ "ok": true, "message": format!("Đọc được cấu hình: {}", e.authorization) }),
                Err(e) => json!({ "ok": false, "message": e.message }),
            },
            _ => json!({ "ok": false, "message": "Loại không hỗ trợ" }),
        }
    }

    // ---- OpenID Connect / OAuth 2 ----

    async fn endpoints(&self, provider: &Provider) -> Result<Endpoints> {
        let c = &provider.config;
        let manual = Endpoints {
            authorization: cfg_str(c, "authorizationUrl").to_owned(),
            token: cfg_str(c, "tokenUrl").to_owned(),
            userinfo: cfg_str(c, "userinfoUrl").to_owned(),
        };
        let issuer = cfg_str(c, "issuer").trim_end_matches('/').to_owned();
        if issuer.is_empty() || (!manual.authorization.is_empty() && !manual.token.is_empty()) {
            if manual.authorization.is_empty() || manual.token.is_empty() {
                return Err(err(400, "Cần issuer (OIDC) hoặc authorizationUrl + tokenUrl (OAuth 2)."));
            }
            return Ok(manual);
        }
        if let Some((e, at)) = self.discovery.lock().get(&provider.id) {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(e.clone());
            }
        }
        let url = format!("{issuer}/.well-known/openid-configuration");
        let response = self.http.get(&url).send().await.map_err(|e| err(502, format!("Không đọc được {url}: {e}")))?;
        let doc: Value = serde_json::from_slice(&response.bytes().await.map_err(|e| err(502, e.to_string()))?)
            .map_err(|_| err(502, format!("{url} không phải cấu hình OpenID")))?;
        let pick = |k: &str, manual: &str| if manual.is_empty() { doc.get(k).and_then(Value::as_str).unwrap_or_default().to_owned() } else { manual.to_owned() };
        let e = Endpoints {
            authorization: pick("authorization_endpoint", &manual.authorization),
            token: pick("token_endpoint", &manual.token),
            userinfo: pick("userinfo_endpoint", &manual.userinfo),
        };
        if e.authorization.is_empty() || e.token.is_empty() {
            return Err(err(502, "Cấu hình OpenID thiếu authorization_endpoint / token_endpoint."));
        }
        self.discovery.lock().insert(provider.id.clone(), (e.clone(), Instant::now()));
        Ok(e)
    }

    /// The IdP URL to send the browser to.
    pub async fn oidc_start(&self, provider_id: &str, redirect_uri: &str, next: &str, device: Option<String>) -> Result<String> {
        let provider = self.store.provider(provider_id)?;
        if provider.kind != "oidc" || !provider.enabled {
            return Err(err(400, "Nhà cung cấp SSO này đang tắt."));
        }
        let endpoints = self.endpoints(&provider).await?;
        let state = random_url_safe(24);
        let verifier = random_url_safe(48);
        let nonce = random_url_safe(16);
        let challenge = {
            use base64::Engine as _;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()))
        };
        let scopes = match cfg_str(&provider.config, "scopes") {
            "" => "openid profile email",
            s => s,
        };
        let mut url = url::Url::parse(&endpoints.authorization).map_err(|_| err(400, "authorizationUrl không hợp lệ"))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", cfg_str(&provider.config, "clientId"))
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", scopes)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("nonce", &nonce);
        let mut pending = self.oidc_pending.lock();
        pending.retain(|_, p| p.at.elapsed() < OIDC_PENDING_TTL);
        pending.insert(
            state,
            OidcPending {
                provider_id: provider.id.clone(),
                verifier,
                nonce,
                next: next.to_owned(),
                device,
                redirect_uri: redirect_uri.to_owned(),
                at: Instant::now(),
            },
        );
        Ok(url.to_string())
    }

    /// The IdP sent the browser back: exchange the code, read the claims, admit the user → (user, next, device code).
    pub async fn oidc_callback(&self, code: &str, state: &str, ip: &str) -> Result<(User, String, Option<String>)> {
        let pending = self.oidc_pending.lock().remove(state).filter(|p| p.at.elapsed() < OIDC_PENDING_TTL);
        let Some(pending) = pending else {
            return Err(err(400, "Phiên đăng nhập SSO đã hết hạn. Thử lại."));
        };
        let provider = self.store.provider(&pending.provider_id)?;
        let result = self.oidc_identity(&provider, &pending, code).await.and_then(|identity| self.admit(&provider, identity));
        match &result {
            Ok(user) => self.store.audit(Some(user), "login", &provider.name, json!({ "method": "sso" }), ip),
            Err(e) => self.store.audit(None, "login.failed", &provider.name, json!({ "reason": e.message }), ip),
        }
        result.map(|user| (user, pending.next, pending.device))
    }

    async fn oidc_identity(&self, provider: &Provider, pending: &OidcPending, code: &str) -> Result<Identity> {
        let c = &provider.config;
        let endpoints = self.endpoints(provider).await?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &pending.redirect_uri)
            .append_pair("client_id", cfg_str(c, "clientId"))
            .append_pair("client_secret", cfg_str(c, "clientSecret"))
            .append_pair("code_verifier", &pending.verifier)
            .finish();
        let response = self
            .http
            .post(&endpoints.token)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(reqwest::header::ACCEPT, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| err(502, format!("Không đổi được mã đăng nhập: {e}")))?;
        let status = response.status();
        let token: Value = serde_json::from_slice(&response.bytes().await.map_err(|e| err(502, e.to_string()))?).unwrap_or(Value::Null);
        if !status.is_success() || token.get("error").is_some() {
            let reason = token.get("error_description").or_else(|| token.get("error")).and_then(Value::as_str).unwrap_or("không rõ");
            return Err(err(401, format!("Nhà cung cấp SSO từ chối: {reason}")));
        }
        // Claims: the ID token (received directly from the token endpoint over TLS, OIDC Core 3.1.3.7 (6)) and the
        // userinfo endpoint (which wins).
        let mut claims = serde_json::Map::new();
        if let Some(id_token) = token.get("id_token").and_then(Value::as_str) {
            if let Some(payload) = id_token.split('.').nth(1) {
                use base64::Engine as _;
                if let Ok(Value::Object(map)) =
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or(())
                {
                    if map.get("nonce").and_then(Value::as_str).is_some_and(|n| n != pending.nonce) {
                        return Err(err(401, "ID token không khớp phiên đăng nhập."));
                    }
                    claims.extend(map);
                }
            }
        }
        let access = token.get("access_token").and_then(Value::as_str).unwrap_or_default();
        if !endpoints.userinfo.is_empty() && !access.is_empty() {
            let response = self
                .http
                .get(&endpoints.userinfo)
                .bearer_auth(access)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, "Compola-Server")
                .send()
                .await
                .map_err(|e| err(502, format!("Không đọc được thông tin người dùng: {e}")))?;
            if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&response.bytes().await.unwrap_or_default()) {
                claims.extend(map);
            }
        }
        if claims.is_empty() {
            return Err(err(502, "Nhà cung cấp SSO không trả về thông tin người dùng."));
        }
        let claim = |k: &str| match claims.get(k) {
            Some(Value::String(s)) => s.trim().to_owned(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        let configured = cfg_str(c, "usernameClaim");
        let username = [configured, "preferred_username", "email", "login", "upn", "sub"]
            .iter()
            .filter(|k| !k.is_empty())
            .map(|k| claim(k))
            .find(|v| !v.is_empty())
            .unwrap_or_default();
        let display_name = [cfg_str(c, "displayNameClaim"), "name", "given_name"].iter().filter(|k| !k.is_empty()).map(|k| claim(k)).find(|v| !v.is_empty()).unwrap_or_default();
        let email = claim(if cfg_str(c, "emailClaim").is_empty() { "email" } else { cfg_str(c, "emailClaim") });
        let groups: Vec<String> = match cfg_str(c, "groupsClaim") {
            "" => Vec::new(),
            key => match claims.get(key) {
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                Some(Value::String(s)) => s.split(',').map(|g| g.trim().to_owned()).filter(|g| !g.is_empty()).collect(),
                _ => Vec::new(),
            },
        };
        let admin_group = cfg_str(c, "adminGroup");
        let is_admin = (!admin_group.is_empty()).then(|| groups.iter().any(|g| g.eq_ignore_ascii_case(admin_group)));
        Ok(Identity { username, display_name, email, groups, is_admin })
    }

    // ---- device flow ----

    pub fn device_start(&self, device_name: &str, device_id: &str, ip: &str) -> (String, String) {
        let device_code = super::store::new_token();
        let code = user_code();
        let mut d = self.devices.lock();
        d.retain(|_, r| r.at.elapsed() < DEVICE_REQUEST_TTL);
        d.insert(
            device_code.clone(),
            DeviceRequest {
                user_code: code.clone(),
                device_id: device_id.chars().take(64).collect(),
                device_name: device_name.chars().filter(|c| !c.is_control()).take(60).collect(),
                ip: ip.to_owned(),
                created_at: super::store::now_ms(),
                at: Instant::now(),
                status: DeviceStatus::Pending,
            },
        );
        (device_code, code)
    }

    pub fn device_info(&self, code: &str) -> Option<Value> {
        let code = normalize_user_code(code);
        let d = self.devices.lock();
        d.values().find(|r| r.user_code == code && r.at.elapsed() < DEVICE_REQUEST_TTL && matches!(r.status, DeviceStatus::Pending)).map(|r| {
            json!({ "deviceName": r.device_name, "deviceId": r.device_id, "ip": r.ip, "createdAt": r.created_at })
        })
    }

    pub fn device_approve(&self, code: &str, user: &User, approve: bool, ip: &str) -> Result<()> {
        if approve && self.store.access_of(user)?.0.is_none() {
            return Err(err(403, "Tài khoản của bạn chưa được cấp quyền dùng tài khoản Zalo này."));
        }
        let code = normalize_user_code(code);
        let mut d = self.devices.lock();
        let Some(r) = d.values_mut().find(|r| r.user_code == code && r.at.elapsed() < DEVICE_REQUEST_TTL) else {
            return Err(err(404, "Mã thiết bị không đúng hoặc đã hết hạn."));
        };
        if !matches!(r.status, DeviceStatus::Pending) {
            return Err(err(409, "Yêu cầu này đã được xử lý."));
        }
        r.status = if approve { DeviceStatus::Approved(user.id.clone()) } else { DeviceStatus::Denied };
        let detail = json!({ "deviceName": r.device_name, "deviceId": r.device_id, "deviceIp": r.ip, "approved": approve });
        drop(d);
        self.store.audit(Some(user), "device.approve", &code, detail, ip);
        Ok(())
    }

    pub fn device_poll(&self, device_code: &str) -> Result<Value> {
        let mut d = self.devices.lock();
        let Some(r) = d.get(device_code) else { return Ok(json!({ "status": "expired" })) };
        if r.at.elapsed() >= DEVICE_REQUEST_TTL {
            d.remove(device_code);
            return Ok(json!({ "status": "expired" }));
        }
        match &r.status {
            DeviceStatus::Pending => Ok(json!({ "status": "pending" })),
            DeviceStatus::Denied => {
                d.remove(device_code);
                Ok(json!({ "status": "denied" }))
            }
            DeviceStatus::Approved(user_id) => {
                let user_id = user_id.clone();
                let r = d.remove(device_code).expect("present");
                drop(d);
                let user = self.store.user(&user_id)?;
                let (_, token) = self.store.create_session(&user.id, "device", &r.device_id, &r.device_name, &r.ip, DEVICE_TTL_MS)?;
                Ok(json!({ "status": "approved", "token": token, "user": user.brief() }))
            }
        }
    }

    // ---- owner links ----

    pub fn otp_create(&self, user_id: &str) -> String {
        let token = super::store::new_token();
        let mut o = self.otps.lock();
        o.retain(|_, (_, at)| at.elapsed() < OTP_TTL);
        o.insert(token.clone(), (user_id.to_owned(), Instant::now()));
        token
    }

    pub fn otp_take(&self, token: &str) -> Option<String> {
        self.otps.lock().remove(token).filter(|(_, at)| at.elapsed() < OTP_TTL).map(|(u, _)| u)
    }
}

fn provider_label(provider: &str) -> &str {
    if provider.is_empty() { "local" } else { provider }
}

pub fn source_label(source: &str) -> String {
    match source.split_once(':') {
        Some(("ldap", _)) => "LDAP".into(),
        Some(("oidc", _)) => "SSO".into(),
        _ => "tài khoản nội bộ".into(),
    }
}

// ---- LDAP ----

async fn ldap_connect(config: &Value) -> Result<ldap3::Ldap> {
    let url = cfg_str(config, "url");
    if !(url.starts_with("ldap://") || url.starts_with("ldaps://")) {
        return Err(err(400, "URL LDAP phải bắt đầu bằng ldap:// hoặc ldaps://"));
    }
    let mut settings = ldap3::LdapConnSettings::new().set_conn_timeout(Duration::from_secs(10)).set_starttls(cfg_bool(config, "startTls"));
    if cfg_bool(config, "tlsInsecure") {
        settings = settings.set_no_tls_verify(true);
    }
    let (conn, ldap) = ldap3::LdapConnAsync::with_settings(settings, url).await.map_err(|e| err(502, format!("Không kết nối được LDAP: {e}")))?;
    ldap3::drive!(conn);
    Ok(ldap)
}

async fn ldap_service_bind(ldap: &mut ldap3::Ldap, config: &Value) -> Result<()> {
    let dn = cfg_str(config, "bindDn");
    if dn.is_empty() {
        return Ok(());
    }
    ldap.simple_bind(dn, cfg_str(config, "bindPassword"))
        .await
        .and_then(|r| r.success())
        .map(|_| ())
        .map_err(|e| err(502, format!("Tài khoản dịch vụ LDAP (bindDn) không đăng nhập được: {e}")))
}

async fn ldap_probe(config: &Value) -> Result<String> {
    let mut ldap = ldap_connect(config).await?;
    ldap_service_bind(&mut ldap, config).await?;
    let _ = ldap.unbind().await;
    Ok("Kết nối LDAP và đăng nhập tài khoản dịch vụ thành công.".into())
}

fn first_attr(entry: &ldap3::SearchEntry, name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    entry.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).and_then(|(_, v)| v.first().cloned()).unwrap_or_default()
}

/// Verifies `username` / `password` against the directory and reads the person's attributes and groups.
pub async fn ldap_authenticate(config: &Value, username: &str, password: &str) -> Result<Identity> {
    let username = username.trim();
    // An empty password would be an anonymous bind, which "succeeds" on most servers.
    if username.is_empty() || password.is_empty() {
        return Err(err(401, "Sai tên đăng nhập hoặc mật khẩu."));
    }
    let escaped = ldap3::ldap_escape(username).into_owned();
    let username_attr = match cfg_str(config, "usernameAttr") {
        "" => "uid",
        a => a,
    };
    let display_attr = match cfg_str(config, "displayNameAttr") {
        "" => "cn",
        a => a,
    };
    let email_attr = match cfg_str(config, "emailAttr") {
        "" => "mail",
        a => a,
    };
    let attrs = vec![username_attr, display_attr, email_attr, "memberOf"];

    let mut ldap = ldap_connect(config).await?;
    // Find the person's DN: a template (`uid={username},ou=people,dc=…`) or a search with the service account.
    let template = cfg_str(config, "userDnTemplate");
    let (dn, entry) = if !template.is_empty() {
        (template.replace("{username}", &ldap3::dn_escape(username)), None)
    } else {
        ldap_service_bind(&mut ldap, config).await?;
        let base = cfg_str(config, "userBaseDn");
        let filter = match cfg_str(config, "userFilter") {
            "" => format!("({username_attr}={escaped})"),
            f => f.replace("{username}", &escaped),
        };
        let (entries, _) = ldap
            .search(base, ldap3::Scope::Subtree, &filter, attrs.clone())
            .await
            .and_then(|r| r.success())
            .map_err(|e| err(502, format!("Tìm người dùng LDAP thất bại: {e}")))?;
        match entries.len() {
            0 => return Err(err(401, "Sai tên đăng nhập hoặc mật khẩu.")),
            1 => {
                let e = ldap3::SearchEntry::construct(entries.into_iter().next().expect("one"));
                (e.dn.clone(), Some(e))
            }
            _ => return Err(err(409, "Có nhiều người dùng LDAP khớp tên này; kiểm tra userFilter.")),
        }
    };
    // The person's own bind proves the password.
    let bound = ldap.simple_bind(&dn, password).await.and_then(|r| r.success());
    if bound.is_err() {
        let _ = ldap.unbind().await;
        return Err(err(401, "Sai tên đăng nhập hoặc mật khẩu."));
    }
    let entry = match entry {
        Some(e) => e,
        None => {
            let (entries, _) = ldap
                .search(&dn, ldap3::Scope::Base, "(objectClass=*)", attrs.clone())
                .await
                .and_then(|r| r.success())
                .map_err(|e| err(502, format!("Đọc thông tin LDAP thất bại: {e}")))?;
            entries.into_iter().next().map(ldap3::SearchEntry::construct).ok_or_else(|| err(502, "Không đọc được thông tin LDAP."))?
        }
    };
    // Groups: a group search (`(member={dn})`) when configured, else `memberOf`.
    let group_attr = match cfg_str(config, "groupNameAttr") {
        "" => "cn",
        a => a,
    };
    let mut groups: Vec<String> = Vec::new();
    let group_base = cfg_str(config, "groupBaseDn");
    if !group_base.is_empty() {
        let _ = ldap_service_bind(&mut ldap, config).await;
        let filter = match cfg_str(config, "groupFilter") {
            "" => format!("(|(member={0})(uniqueMember={0})(memberUid={1}))", ldap3::ldap_escape(&dn), escaped),
            f => f.replace("{dn}", &ldap3::ldap_escape(&dn)).replace("{username}", &escaped),
        };
        if let Ok((entries, _)) = ldap.search(group_base, ldap3::Scope::Subtree, &filter, vec![group_attr]).await.and_then(|r| r.success()) {
            groups = entries.into_iter().map(ldap3::SearchEntry::construct).map(|e| first_attr(&e, group_attr)).filter(|g| !g.is_empty()).collect();
        }
    } else if let Some((_, values)) = entry.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case("memberOf")) {
        // `cn=Sales,ou=groups,dc=…` → `Sales`
        groups = values
            .iter()
            .filter_map(|dn| dn.split(',').next().and_then(|rdn| rdn.split_once('=')).map(|(_, v)| v.trim().to_owned()))
            .filter(|g| !g.is_empty())
            .collect();
    }
    let _ = ldap.unbind().await;
    let admin_group = cfg_str(config, "adminGroup");
    let found_name = first_attr(&entry, username_attr);
    Ok(Identity {
        username: if found_name.is_empty() { username.to_owned() } else { found_name },
        display_name: first_attr(&entry, display_attr),
        email: first_attr(&entry, email_attr),
        is_admin: (!admin_group.is_empty()).then(|| groups.iter().any(|g| g.eq_ignore_ascii_case(admin_group))),
        groups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_hash_and_verify() {
        let h = hash_password("correct horse").unwrap();
        assert!(verify_password(&h, "correct horse"));
        assert!(!verify_password(&h, "wrong horse"));
        assert_eq!(hash_password("short").unwrap_err().status, 400);
    }

    #[test]
    fn device_codes_are_readable_and_normalized() {
        let c = user_code();
        assert_eq!(c.len(), 9);
        assert_eq!(normalize_user_code(&c.to_lowercase().replace('-', " ")), c);
    }

    #[tokio::test]
    async fn local_sign_in_and_brake() {
        let store = Arc::new(Store::memory());
        store.create_user("Lan", "Lan", "", "local", Some(&hash_password("mat-khau-1").unwrap()), false).unwrap();
        let auth = Auth::new(store.clone());
        assert!(auth.login_password("lan", "mat-khau-1", "local", "1.1.1.1").await.is_ok());
        for _ in 0..MAX_FAILURES {
            assert_eq!(auth.login_password("lan", "nope-nope", "local", "2.2.2.2").await.unwrap_err().status, 401);
        }
        assert_eq!(auth.login_password("lan", "mat-khau-1", "local", "2.2.2.2").await.unwrap_err().status, 429);
        assert!(auth.login_password("lan", "mat-khau-1", "", "3.3.3.3").await.is_ok());
    }

    #[tokio::test]
    async fn device_flow_needs_an_approver_with_access() {
        let store = Arc::new(Store::memory());
        let nobody = store.create_user("nobody", "", "", "local", Some("h"), false).unwrap();
        let admin = store.create_user("admin", "", "", "local", Some("h"), true).unwrap();
        let auth = Auth::new(store);
        let (device_code, code) = auth.device_start("MacBook", "dev-1", "10.0.0.9");
        assert_eq!(auth.device_info(&code).unwrap()["deviceId"], json!("dev-1"));
        assert_eq!(auth.device_poll(&device_code).unwrap()["status"], json!("pending"));
        assert_eq!(auth.device_approve(&code, &nobody, true, "x").unwrap_err().status, 403);
        auth.device_approve(&code, &admin, true, "x").unwrap();
        let done = auth.device_poll(&device_code).unwrap();
        assert_eq!(done["status"], json!("approved"));
        assert!(done["token"].as_str().is_some_and(|t| t.len() == 64));
        // The token is handed out once.
        assert_eq!(auth.device_poll(&device_code).unwrap()["status"], json!("expired"));
    }

    #[test]
    fn external_users_never_take_over_another_source() {
        let store = Arc::new(Store::memory());
        store.create_user("lan", "", "", "local", Some("h"), false).unwrap();
        let p = store.create_provider("oidc", "Google", true, json!({ "autoCreate": true })).unwrap();
        let auth = Auth::new(store.clone());
        let e = auth.admit(&p, Identity { username: "LAN".into(), ..Default::default() }).unwrap_err();
        assert_eq!(e.status, 409);
        let u = auth.admit(&p, Identity { username: "minh@x.vn".into(), display_name: "Minh".into(), ..Default::default() }).unwrap();
        assert_eq!(u.source, format!("oidc:{}", p.id));
        assert_eq!(u.display_name, "Minh");
        let closed = store.create_provider("oidc", "Corp", true, json!({ "autoCreate": false })).unwrap();
        assert_eq!(auth.admit(&closed, Identity { username: "new".into(), ..Default::default() }).unwrap_err().status, 403);
    }
}
