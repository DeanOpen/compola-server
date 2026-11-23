//! Compola Server accounts (`~/Library/Application Support/Compola/server.db`, 0600): users, groups, access grants,
//! sessions, sign-in providers and the audit log. One connection behind a mutex: every operation is small.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;

use super::policy::{Access, Role, Scope};

/// Store errors carry the HTTP status the API answers with.
#[derive(Debug, Clone)]
pub struct StoreError {
    pub status: u16,
    pub message: String,
}

impl StoreError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    fn not_found(what: &str) -> Self {
        Self::new(404, format!("Không tìm thấy {what}."))
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(500, format!("Lỗi cơ sở dữ liệu: {e}"))
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

/// Usernames and group names are unique without regard to case or surrounding spaces.
pub fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// 32 random bytes, hex.
pub fn new_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(sha2::Sha256::digest(token.as_bytes()))
}

fn valid_username(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && n.chars().count() <= 64 && !n.chars().any(|c| c.is_control() || c == '/' || c == '\\')
}

// ---- types (camelCase JSON, docs/compola-server.md) ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub email: String,
    /// `local`, `ldap:<providerId>`, `oidc:<providerId>`.
    pub source: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub has_password: bool,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
}

impl User {
    pub fn brief(&self) -> Value {
        json!({ "id": self.id, "username": self.username, "displayName": self.display_name })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub members: Vec<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    /// `user` | `group`
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub subject: Subject,
    /// The Zalo account id, or `"*"` for every account.
    pub account: String,
    pub role: Role,
    pub scope: Scope,
    pub note: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub user_id: String,
    /// `web` | `device`
    pub kind: String,
    pub device_id: String,
    pub device_name: String,
    pub ip: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    /// `ldap` | `oidc`
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub config: Value,
    pub created_at: i64,
}

/// Config keys that are never sent back to the admin console.
pub const SECRET_KEYS: &[&str] = &["bindPassword", "clientSecret"];
pub const SECRET_MASK: &str = "••••";

impl Provider {
    /// The provider as the admin console sees it: secrets masked.
    pub fn public(&self) -> Value {
        let mut config = self.config.clone();
        if let Some(map) = config.as_object_mut() {
            for k in SECRET_KEYS {
                if map.get(*k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
                    map.insert((*k).into(), json!(SECRET_MASK));
                }
            }
        }
        json!({ "id": self.id, "kind": self.kind, "name": self.name, "enabled": self.enabled, "config": config, "createdAt": self.created_at })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: i64,
    pub actor: Option<Value>,
    pub action: String,
    pub target: String,
    pub detail: Value,
    pub ip: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserPatch {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub is_admin: Option<bool>,
    pub disabled: Option<bool>,
}

/// One attributed action on the Zalo account (docs/compola-server.md, "Activity tracking").
#[derive(Clone, Debug, Default)]
pub struct NewActivity {
    pub account: String,
    /// The Zalo uid of the account (stable across a remove and re-add; docs/multi-account.md §1).
    pub account_uid: String,
    pub user: Option<(String, String, String)>, // id, username, display name
    pub device_id: String,
    pub device_name: String,
    /// `device` | `web` | `host`
    pub device_kind: String,
    pub action: String,
    pub conversation_id: Option<String>,
    pub conversation_name: Option<String>,
    pub message_id: Option<String>,
    pub ok: bool,
    pub response_ms: Option<i64>,
    pub detail: Value,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActivityFilter {
    pub user_id: Option<String>,
    pub account: Option<String>,
    pub conversation_id: Option<String>,
    /// Comma-separated actions, each exact or a prefix (`message` matches `message.send`).
    pub action: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<i64>,
    pub before: Option<i64>,
}

const ACTIVITY_COLS: &str = "id, at, account, user_id, username, display_name, device_id, device_name, device_kind, action, conversation_id, conversation_name, message_id, ok, response_ms, detail, account_uid";
const ACTIVITY_WHERE: &str = "(?1 IS NULL OR user_id = ?1) AND (?2 IS NULL OR account = ?2) AND (?3 IS NULL OR conversation_id = ?3)
  AND (?4 IS NULL OR EXISTS (SELECT 1 FROM json_each(?4) j WHERE activity.action = j.value OR activity.action LIKE j.value || '.%'))
  AND (?5 IS NULL OR at >= ?5) AND (?6 IS NULL OR at < ?6)";

fn activity_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let user_id: Option<String> = r.get(3)?;
    let detail: String = r.get(15)?;
    let conversation: Option<String> = r.get(10)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "at": r.get::<_, i64>(1)?,
        "account": r.get::<_, String>(2)?,
        "user": user_id.map(|id| json!({ "id": id, "username": r.get::<_, Option<String>>(4).ok().flatten(), "displayName": r.get::<_, Option<String>>(5).ok().flatten() })),
        "device": { "id": r.get::<_, String>(6)?, "name": r.get::<_, String>(7)?, "kind": r.get::<_, String>(8)? },
        "action": r.get::<_, String>(9)?,
        "conversation": conversation.map(|id| json!({ "id": id, "name": r.get::<_, Option<String>>(11).ok().flatten() })),
        "messageId": r.get::<_, Option<String>>(12)?,
        "ok": r.get::<_, bool>(13)?,
        "responseMs": r.get::<_, Option<i64>>(14)?,
        "detail": serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null),
        "accountUid": r.get::<_, String>(16)?,
    }))
}

/// Stats of a group of activity rows.
#[derive(Default)]
struct Tally {
    label: String,
    sent: i64,
    media: i64,
    recalled: i64,
    reactions: i64,
    reads: i64,
    opens: i64,
    conversations: std::collections::HashSet<String>,
    responses: Vec<i64>,
}

impl Tally {
    fn add(&mut self, action: &str, conversation: Option<&str>, response_ms: Option<i64>) {
        match action {
            "message.send" | "message.sticker" | "message.card" | "message.forward" => self.sent += 1,
            "message.media" | "message.file" => {
                self.sent += 1;
                self.media += 1;
            }
            "message.recall" => self.recalled += 1,
            "message.react" => self.reactions += 1,
            "conversation.read" => self.reads += 1,
            "conversation.open" => self.opens += 1,
            _ => {}
        }
        if action.starts_with("message.") {
            if let Some(c) = conversation {
                self.conversations.insert(c.to_owned());
            }
        }
        if let Some(ms) = response_ms {
            self.responses.push(ms);
        }
    }

    fn json(mut self, key: &str) -> Value {
        self.responses.sort_unstable();
        let n = self.responses.len();
        let pct = |p: f64| (n > 0).then(|| self.responses[((n as f64 - 1.0) * p).round() as usize]);
        let avg = (n > 0).then(|| self.responses.iter().sum::<i64>() / n as i64);
        json!({
            "key": key, "label": if self.label.is_empty() { key.to_owned() } else { self.label.clone() },
            "sent": self.sent, "media": self.media, "recalled": self.recalled, "reactions": self.reactions,
            "reads": self.reads, "opens": self.opens, "conversations": self.conversations.len(), "responses": n,
            "avgResponseMs": avg, "medianResponseMs": pct(0.5), "p90ResponseMs": pct(0.9),
        })
    }
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_owned() }
}

/// Columns added after the first release.
fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let has = |table: &str, column: &str| -> rusqlite::Result<bool> {
        let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names.iter().any(|n| n == column))
    };
    // Multi-account (docs/multi-account.md §7): grants name their Zalo account; older ones were for `default`.
    if !has("grants", "account")? {
        conn.execute_batch("ALTER TABLE grants ADD COLUMN account TEXT NOT NULL DEFAULT 'default';")?;
    }
    Ok(())
}

/// What a user may do, per Zalo account (docs/compola-server.md, "Multiple Zalo accounts"). `accounts` keys are
/// account ids or `"*"` (every account).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccess {
    pub admin: bool,
    pub accounts: BTreeMap<String, Access>,
}

impl UserAccess {
    pub fn admin() -> Self {
        Self { admin: true, accounts: BTreeMap::new() }
    }

    /// The access on one account: admins have everything; else that account's grants merged with `"*"`.
    pub fn for_account(&self, account: &str) -> Option<Access> {
        if self.admin {
            return Some(Access { role: Role::Admin, scope: Scope { all: true, ..Default::default() } });
        }
        let parts: Vec<&Access> = [self.accounts.get(account), self.accounts.get("*")].into_iter().flatten().collect();
        let first = parts.first()?;
        let role = parts.iter().map(|a| a.role).max().unwrap_or(first.role);
        let all = parts.iter().any(|a| a.scope.all);
        let mut conversations = BTreeSet::new();
        let mut labels = BTreeSet::new();
        if !all {
            for a in &parts {
                conversations.extend(a.scope.conversations.iter().cloned());
                labels.extend(a.scope.labels.iter().cloned());
            }
        }
        Some(Access { role, scope: Scope { all, conversations: conversations.into_iter().collect(), labels: labels.into_iter().collect() } })
    }

    /// `{admin, accounts: {<id>: {role, scope}}}` over the host's accounts (`"*"` expanded).
    pub fn expanded(&self, account_ids: &[String]) -> Value {
        let accounts: serde_json::Map<String, Value> = account_ids
            .iter()
            .filter_map(|id| self.for_account(id).map(|a| (id.clone(), serde_json::to_value(a).unwrap_or(Value::Null))))
            .collect();
        json!({ "admin": self.admin, "accounts": accounts })
    }
}

// ---- store ----

pub struct Store {
    conn: Mutex<rusqlite::Connection>,
}

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'local',
  password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS groups_(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'local', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(
  group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, user_id));
CREATE TABLE IF NOT EXISTS grants(
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, role TEXT NOT NULL,
  scope TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '', device_name TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, username TEXT, action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', ip TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS audit_at ON audit(id DESC);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account TEXT NOT NULL DEFAULT '',
  user_id TEXT, username TEXT, display_name TEXT,
  device_id TEXT NOT NULL DEFAULT '', device_name TEXT NOT NULL DEFAULT '', device_kind TEXT NOT NULL DEFAULT 'device',
  action TEXT NOT NULL, conversation_id TEXT, conversation_name TEXT, message_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1, response_ms INTEGER, detail TEXT NOT NULL DEFAULT '{}', account_uid TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, at);
CREATE INDEX IF NOT EXISTS activity_conv ON activity(conversation_id, at);
";

/// Audit entries kept.
const AUDIT_KEEP: i64 = 100_000;

const USER_COLS: &str = "id, username, display_name, email, source, is_admin, disabled, password_hash IS NOT NULL, created_at, last_login_at";

fn user_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        username: r.get(1)?,
        display_name: r.get(2)?,
        email: r.get(3)?,
        source: r.get(4)?,
        is_admin: r.get(5)?,
        disabled: r.get(6)?,
        has_password: r.get(7)?,
        created_at: r.get(8)?,
        last_login_at: r.get(9)?,
    })
}

const SESSION_COLS: &str = "id, user_id, kind, device_id, device_name, ip, created_at, last_seen_at, expires_at";

fn session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        user_id: r.get(1)?,
        kind: r.get(2)?,
        device_id: r.get(3)?,
        device_name: r.get(4)?,
        ip: r.get(5)?,
        created_at: r.get(6)?,
        last_seen_at: r.get(7)?,
        expires_at: r.get(8)?,
    })
}

fn grant_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    let role: String = r.get(3)?;
    let scope: String = r.get(4)?;
    Ok(Grant {
        id: r.get(0)?,
        subject: Subject { kind: r.get(1)?, id: r.get(2)? },
        account: r.get(7)?,
        role: if role == "agent" { Role::Agent } else { Role::Viewer },
        scope: serde_json::from_str(&scope).unwrap_or_default(),
        note: r.get(5)?,
        created_at: r.get(6)?,
    })
}

fn provider_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Provider> {
    let config: String = r.get(4)?;
    Ok(Provider {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        enabled: r.get(3)?,
        config: serde_json::from_str(&config).unwrap_or(Value::Null),
        created_at: r.get(5)?,
    })
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Agent => "agent",
        Role::Admin => "admin",
    }
}

/// Grants hold viewer or agent; admin comes from `users.is_admin`.
fn grant_role(role: Role) -> Role {
    if role == Role::Viewer { Role::Viewer } else { Role::Agent }
}

/// A grant names one valid account (or `"*"`, which needs the whole account), and a scope that is not empty.
fn check_grant(account: &str, scope: &Scope) -> Result<()> {
    if account != "*" && !crate::account::valid_id(account) {
        return Err(StoreError::new(400, "Tài khoản Zalo không hợp lệ."));
    }
    if account == "*" && !scope.all {
        return Err(StoreError::new(
            400,
            "Quyền cho «Tất cả tài khoản» phải là «Tất cả cuộc trò chuyện»: danh sách hội thoại và nhãn chỉ có nghĩa trong một tài khoản.",
        ));
    }
    if !scope.all && scope.conversations.is_empty() && scope.labels.is_empty() {
        return Err(StoreError::new(400, "Chọn ít nhất một cuộc trò chuyện hoặc nhãn, hoặc bật «Tất cả cuộc trò chuyện»."));
    }
    Ok(())
}

fn clean_scope(scope: Scope) -> Scope {
    let dedupe = |v: Vec<String>| v.into_iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect::<BTreeSet<_>>().into_iter().collect();
    if scope.all {
        Scope { all: true, conversations: Vec::new(), labels: Vec::new() }
    } else {
        Scope { all: false, conversations: dedupe(scope.conversations), labels: dedupe(scope.labels) }
    }
}

impl ActivityFilter {
    /// The action list as the JSON array the queries read (`json_each`).
    fn actions(&self) -> Option<String> {
        let list: Vec<&str> = self.action.as_deref()?.split(',').map(str::trim).filter(|a| !a.is_empty()).collect();
        (!list.is_empty()).then(|| serde_json::to_string(&list).unwrap_or_default())
    }
}

impl Store {
    pub fn path() -> PathBuf {
        crate::platform::app_support().join("server.db")
    }

    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = rusqlite::Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        Self { conn: Mutex::new(conn) }
    }

    // ---- users ----

    pub fn users(&self) -> Result<Vec<User>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY username_key"))?;
        let rows = st.query_map([], user_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn user(&self, id: &str) -> Result<User> {
        let c = self.conn.lock();
        c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"), [id], user_row).optional()?.ok_or_else(|| StoreError::not_found("người dùng"))
    }

    pub fn user_by_name(&self, username: &str) -> Result<Option<User>> {
        let c = self.conn.lock();
        Ok(c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE username_key = ?1"), [name_key(username)], user_row).optional()?)
    }

    pub fn password_hash(&self, id: &str) -> Result<Option<String>> {
        let c = self.conn.lock();
        Ok(c.query_row("SELECT password_hash FROM users WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten())
    }

    pub fn count_admins(&self) -> Result<i64> {
        let c = self.conn.lock();
        Ok(c.query_row("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND disabled = 0", [], |r| r.get(0))?)
    }

    pub fn first_admin(&self) -> Result<Option<User>> {
        let c = self.conn.lock();
        Ok(c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY created_at LIMIT 1"), [], user_row).optional()?)
    }

    /// A new user. `source` local needs `password_hash`; external users are matched by username at their sign-in.
    pub fn create_user(&self, username: &str, display_name: &str, email: &str, source: &str, password_hash: Option<&str>, is_admin: bool) -> Result<User> {
        if !valid_username(username) {
            return Err(StoreError::new(400, "Tên đăng nhập không hợp lệ (1–64 ký tự, không chứa / hoặc \\)."));
        }
        if source == "local" && password_hash.is_none() {
            return Err(StoreError::new(400, "Tài khoản nội bộ cần mật khẩu."));
        }
        let id = new_id("u");
        let display = if display_name.trim().is_empty() { username.trim() } else { display_name.trim() };
        let c = self.conn.lock();
        let r = c.execute(
            "INSERT INTO users(id, username, username_key, display_name, email, source, password_hash, is_admin, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id, username.trim(), name_key(username), display, email.trim(), source, password_hash, is_admin, now_ms()],
        );
        match r {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err(StoreError::new(409, format!("Tên đăng nhập «{}» đã có người dùng (không phân biệt hoa thường).", username.trim())));
            }
            Err(e) => return Err(e.into()),
        }
        drop(c);
        self.user(&id)
    }

    pub fn update_user(&self, id: &str, patch: UserPatch) -> Result<User> {
        let user = self.user(id)?;
        if (patch.is_admin == Some(false) || patch.disabled == Some(true)) && user.is_admin && !user.disabled && self.count_admins()? <= 1 {
            return Err(StoreError::new(409, "Cần giữ lại ít nhất một quản trị viên đang hoạt động."));
        }
        let c = self.conn.lock();
        c.execute(
            "UPDATE users SET display_name = ?2, email = ?3, is_admin = ?4, disabled = ?5 WHERE id = ?1",
            params![
                id,
                patch.display_name.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).unwrap_or(user.display_name),
                patch.email.map(|s| s.trim().to_owned()).unwrap_or(user.email),
                patch.is_admin.unwrap_or(user.is_admin),
                patch.disabled.unwrap_or(user.disabled),
            ],
        )?;
        if patch.disabled == Some(true) {
            c.execute("DELETE FROM sessions WHERE user_id = ?1", [id])?;
        }
        drop(c);
        self.user(id)
    }

    pub fn set_password(&self, id: &str, hash: &str) -> Result<()> {
        let user = self.user(id)?;
        if user.source != "local" {
            return Err(StoreError::new(400, "Chỉ tài khoản nội bộ mới có mật khẩu trong Compola."));
        }
        let c = self.conn.lock();
        c.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", params![id, hash])?;
        Ok(())
    }

    pub fn delete_user(&self, id: &str) -> Result<User> {
        let user = self.user(id)?;
        if user.is_admin && !user.disabled && self.count_admins()? <= 1 {
            return Err(StoreError::new(409, "Không thể xoá quản trị viên cuối cùng."));
        }
        let c = self.conn.lock();
        c.execute("DELETE FROM grants WHERE subject_type = 'user' AND subject_id = ?1", [id])?;
        c.execute("DELETE FROM users WHERE id = ?1", [id])?;
        Ok(user)
    }

    pub fn touch_login(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute("UPDATE users SET last_login_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        Ok(())
    }

    /// After an external sign-in: refresh what the directory / IdP says. `is_admin` is set only when the provider
    /// maps an admin group (Some).
    pub fn refresh_external(&self, id: &str, display_name: &str, email: &str, is_admin: Option<bool>) -> Result<()> {
        let c = self.conn.lock();
        if !display_name.trim().is_empty() {
            c.execute("UPDATE users SET display_name = ?2 WHERE id = ?1", params![id, display_name.trim()])?;
        }
        if !email.trim().is_empty() {
            c.execute("UPDATE users SET email = ?2 WHERE id = ?1", params![id, email.trim()])?;
        }
        if let Some(admin) = is_admin {
            c.execute("UPDATE users SET is_admin = ?2 WHERE id = ?1", params![id, admin])?;
        }
        Ok(())
    }

    // ---- groups ----

    pub fn groups(&self) -> Result<Vec<Group>> {
        let c = self.conn.lock();
        let mut members: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut st = c.prepare("SELECT group_id, user_id FROM group_members")?;
            for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (g, u) = row?;
                members.entry(g).or_default().push(u);
            }
        }
        let mut st = c.prepare("SELECT id, name, description, source, created_at FROM groups_ ORDER BY name_key")?;
        let rows = st
            .query_map([], |r| {
                Ok(Group { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, source: r.get(3)?, members: Vec::new(), created_at: r.get(4)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(|mut g| {
            g.members = members.remove(&g.id).unwrap_or_default();
            g
        }).collect())
    }

    pub fn group(&self, id: &str) -> Result<Group> {
        self.groups()?.into_iter().find(|g| g.id == id).ok_or_else(|| StoreError::not_found("nhóm"))
    }

    pub fn create_group(&self, name: &str, description: &str, source: &str) -> Result<Group> {
        if name.trim().is_empty() {
            return Err(StoreError::new(400, "Nhập tên nhóm."));
        }
        let id = new_id("g");
        let c = self.conn.lock();
        match c.execute(
            "INSERT INTO groups_(id, name, name_key, description, source, created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, name.trim(), name_key(name), description.trim(), source, now_ms()],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err(StoreError::new(409, format!("Đã có nhóm tên «{}».", name.trim())));
            }
            Err(e) => return Err(e.into()),
        }
        drop(c);
        self.group(&id)
    }

    pub fn update_group(&self, id: &str, name: Option<&str>, description: Option<&str>) -> Result<Group> {
        let g = self.group(id)?;
        let name = name.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&g.name).to_owned();
        let c = self.conn.lock();
        match c.execute(
            "UPDATE groups_ SET name = ?2, name_key = ?3, description = ?4 WHERE id = ?1",
            params![id, name, name_key(&name), description.map(str::trim).unwrap_or(&g.description)],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err(StoreError::new(409, format!("Đã có nhóm tên «{name}».")));
            }
            Err(e) => return Err(e.into()),
        }
        drop(c);
        self.group(id)
    }

    pub fn delete_group(&self, id: &str) -> Result<Group> {
        let g = self.group(id)?;
        let c = self.conn.lock();
        c.execute("DELETE FROM grants WHERE subject_type = 'group' AND subject_id = ?1", [id])?;
        c.execute("DELETE FROM groups_ WHERE id = ?1", [id])?;
        Ok(g)
    }

    pub fn set_members(&self, id: &str, user_ids: &[String]) -> Result<Group> {
        self.group(id)?;
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM group_members WHERE group_id = ?1", [id])?;
        for u in user_ids.iter().collect::<BTreeSet<_>>() {
            tx.execute("INSERT OR IGNORE INTO group_members(group_id, user_id) SELECT ?1, id FROM users WHERE id = ?2", params![id, u])?;
        }
        tx.commit()?;
        drop(c);
        self.group(id)
    }

    pub fn groups_of(&self, user_id: &str) -> Result<Vec<String>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT group_id FROM group_members WHERE user_id = ?1")?;
        let rows = st.query_map([user_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    /// The directory's groups of `source` for this user: groups are created by name when missing and the user's
    /// memberships in groups of that source are replaced (local groups are left alone).
    pub fn sync_external_groups(&self, user_id: &str, source: &str, names: &[String]) -> Result<()> {
        let mut ids = Vec::new();
        for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            let existing: Option<(String, String)> = {
                let c = self.conn.lock();
                c.query_row("SELECT id, source FROM groups_ WHERE name_key = ?1", [name_key(name)], |r| Ok((r.get(0)?, r.get(1)?))).optional()?
            };
            match existing {
                Some((id, s)) if s == source => ids.push(id),
                Some(_) => {} // a local group with the same name is not taken over
                None => ids.push(self.create_group(name, "", source)?.id),
            }
        }
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM group_members WHERE user_id = ?1 AND group_id IN (SELECT id FROM groups_ WHERE source = ?2)", params![user_id, source])?;
        for id in ids {
            tx.execute("INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?1, ?2)", params![id, user_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- grants ----

    pub fn grants(&self) -> Result<Vec<Grant>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id, subject_type, subject_id, role, scope, note, created_at, account FROM grants ORDER BY created_at")?;
        let rows = st.query_map([], grant_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn grant(&self, id: &str) -> Result<Grant> {
        self.grants()?.into_iter().find(|g| g.id == id).ok_or_else(|| StoreError::not_found("quyền"))
    }

    fn check_subject(&self, subject: &Subject) -> Result<()> {
        match subject.kind.as_str() {
            "user" => self.user(&subject.id).map(|_| ()),
            "group" => self.group(&subject.id).map(|_| ()),
            _ => Err(StoreError::new(400, "Đối tượng phải là người dùng hoặc nhóm.")),
        }
    }

    pub fn create_grant(&self, subject: Subject, account: &str, role: Role, scope: Scope, note: &str) -> Result<Grant> {
        self.check_subject(&subject)?;
        let scope = clean_scope(scope);
        check_grant(account, &scope)?;
        let id = new_id("a");
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO grants(id, subject_type, subject_id, role, scope, note, created_at, account) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, subject.kind, subject.id, role_name(grant_role(role)), serde_json::to_string(&scope).unwrap_or_default(), note.trim(), now_ms(), account],
        )?;
        drop(c);
        self.grant(&id)
    }

    pub fn update_grant(&self, id: &str, account: Option<&str>, role: Option<Role>, scope: Option<Scope>, note: Option<&str>) -> Result<Grant> {
        let g = self.grant(id)?;
        let scope = clean_scope(scope.unwrap_or(g.scope));
        let account = account.unwrap_or(&g.account).to_owned();
        check_grant(&account, &scope)?;
        let c = self.conn.lock();
        c.execute(
            "UPDATE grants SET role = ?2, scope = ?3, note = ?4, account = ?5 WHERE id = ?1",
            params![id, role_name(grant_role(role.unwrap_or(g.role))), serde_json::to_string(&scope).unwrap_or_default(), note.map(str::trim).unwrap_or(&g.note), account],
        )?;
        drop(c);
        self.grant(id)
    }

    pub fn delete_grant(&self, id: &str) -> Result<Grant> {
        let g = self.grant(id)?;
        self.conn.lock().execute("DELETE FROM grants WHERE id = ?1", [id])?;
        Ok(g)
    }

    /// Effective access per account: admins see everything; otherwise, per account, the highest role and the union
    /// of the scopes of the user's own and their groups' grants (`"*"` grants apply to every account). None = no
    /// access at all. `via` lists the grants that count.
    pub fn access_of(&self, user: &User) -> Result<(Option<UserAccess>, Vec<Value>)> {
        if user.disabled {
            return Ok((None, Vec::new()));
        }
        if user.is_admin {
            return Ok((Some(UserAccess::admin()), vec![json!({ "admin": true })]));
        }
        let groups = self.groups_of(&user.id)?;
        let grants: Vec<Grant> = self
            .grants()?
            .into_iter()
            .filter(|g| (g.subject.kind == "user" && g.subject.id == user.id) || (g.subject.kind == "group" && groups.contains(&g.subject.id)))
            .collect();
        if grants.is_empty() {
            return Ok((None, Vec::new()));
        }
        let mut by_account: BTreeMap<String, Vec<&Grant>> = BTreeMap::new();
        for g in &grants {
            by_account.entry(g.account.clone()).or_default().push(g);
        }
        let accounts = by_account
            .into_iter()
            .map(|(account, list)| {
                let role = list.iter().map(|g| g.role).max().unwrap_or(Role::Viewer);
                let all = list.iter().any(|g| g.scope.all);
                let mut conversations = BTreeSet::new();
                let mut labels = BTreeSet::new();
                if !all {
                    for g in &list {
                        conversations.extend(g.scope.conversations.iter().cloned());
                        labels.extend(g.scope.labels.iter().cloned());
                    }
                }
                (account, Access { role, scope: Scope { all, conversations: conversations.into_iter().collect(), labels: labels.into_iter().collect() } })
            })
            .collect();
        let via = grants
            .iter()
            .map(|g| json!({ "grantId": g.id, "subject": g.subject, "account": g.account, "role": g.role, "scope": g.scope }))
            .collect();
        Ok((Some(UserAccess { admin: false, accounts }), via))
    }

    // ---- sessions ----

    /// A new session → (session, bearer token). The token is only stored hashed.
    pub fn create_session(&self, user_id: &str, kind: &str, device_id: &str, device_name: &str, ip: &str, ttl_ms: i64) -> Result<(Session, String)> {
        let token = new_token();
        let id = new_id("s");
        let now = now_ms();
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO sessions(id, token_hash, user_id, kind, device_id, device_name, ip, created_at, last_seen_at, expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
            params![id, token_hash(&token), user_id, kind, device_id.chars().take(64).collect::<String>(), device_name.chars().take(60).collect::<String>(), ip, now, now + ttl_ms],
        )?;
        c.execute("DELETE FROM sessions WHERE expires_at < ?1", [now])?;
        let session = c.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"), [&id], session_row)?;
        Ok((session, token))
    }

    /// The live session and user of a token; extends device sessions (sliding) and records the address.
    pub fn session_by_token(&self, token: &str, ip: &str, slide_ms: Option<i64>) -> Result<Option<(Session, User)>> {
        let c = self.conn.lock();
        let now = now_ms();
        let Some(mut session) =
            c.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE token_hash = ?1"), [token_hash(token)], session_row).optional()?
        else {
            return Ok(None);
        };
        if session.expires_at < now {
            c.execute("DELETE FROM sessions WHERE id = ?1", [&session.id])?;
            return Ok(None);
        }
        let Some(user) = c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"), [&session.user_id], user_row).optional()? else {
            return Ok(None);
        };
        if user.disabled {
            return Ok(None);
        }
        // Writes at most once a minute per session.
        if now - session.last_seen_at > 60_000 || session.ip != ip {
            let expires = slide_ms.map_or(session.expires_at, |s| (now + s).max(session.expires_at));
            c.execute("UPDATE sessions SET last_seen_at = ?2, ip = ?3, expires_at = ?4 WHERE id = ?1", params![session.id, now, ip, expires])?;
            session.last_seen_at = now;
            session.ip = ip.to_owned();
            session.expires_at = expires;
        }
        Ok(Some((session, user)))
    }

    pub fn sessions(&self) -> Result<Vec<Session>> {
        let c = self.conn.lock();
        c.execute("DELETE FROM sessions WHERE expires_at < ?1", [now_ms()])?;
        let mut st = c.prepare(&format!("SELECT {SESSION_COLS} FROM sessions ORDER BY last_seen_at DESC"))?;
        let rows = st.query_map([], session_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_session(&self, id: &str) -> Result<Option<Session>> {
        let c = self.conn.lock();
        let s = c.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"), [id], session_row).optional()?;
        c.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        Ok(s)
    }

    pub fn delete_session_by_token(&self, token: &str) -> Result<Option<Session>> {
        let c = self.conn.lock();
        let s = c.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE token_hash = ?1"), [token_hash(token)], session_row).optional()?;
        c.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash(token)])?;
        Ok(s)
    }

    // ---- providers ----

    pub fn providers(&self) -> Result<Vec<Provider>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id, kind, name, enabled, config, created_at FROM providers ORDER BY created_at")?;
        let rows = st.query_map([], provider_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn provider(&self, id: &str) -> Result<Provider> {
        self.providers()?.into_iter().find(|p| p.id == id).ok_or_else(|| StoreError::not_found("nhà cung cấp đăng nhập"))
    }

    pub fn create_provider(&self, kind: &str, name: &str, enabled: bool, config: Value) -> Result<Provider> {
        if kind != "ldap" && kind != "oidc" {
            return Err(StoreError::new(400, "Loại phải là ldap hoặc oidc."));
        }
        if name.trim().is_empty() {
            return Err(StoreError::new(400, "Nhập tên hiển thị."));
        }
        let id = new_id(kind);
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO providers(id, kind, name, enabled, config, created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, kind, name.trim(), enabled, config.to_string(), now_ms()],
        )?;
        drop(c);
        self.provider(&id)
    }

    /// Masked secrets (`••••`) in `config` keep the stored values.
    pub fn update_provider(&self, id: &str, name: Option<&str>, enabled: Option<bool>, config: Option<Value>) -> Result<Provider> {
        let p = self.provider(id)?;
        let config = match config {
            Some(mut next) => {
                if let (Some(map), Some(old)) = (next.as_object_mut(), p.config.as_object()) {
                    for k in SECRET_KEYS {
                        if map.get(*k).and_then(Value::as_str) == Some(SECRET_MASK) {
                            map.insert((*k).into(), old.get(*k).cloned().unwrap_or(Value::Null));
                        }
                    }
                }
                next
            }
            None => p.config.clone(),
        };
        let c = self.conn.lock();
        c.execute(
            "UPDATE providers SET name = ?2, enabled = ?3, config = ?4 WHERE id = ?1",
            params![id, name.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&p.name), enabled.unwrap_or(p.enabled), config.to_string()],
        )?;
        drop(c);
        self.provider(id)
    }

    pub fn delete_provider(&self, id: &str) -> Result<Provider> {
        let p = self.provider(id)?;
        self.conn.lock().execute("DELETE FROM providers WHERE id = ?1", [id])?;
        Ok(p)
    }

    // ---- audit ----

    pub fn audit(&self, actor: Option<&User>, action: &str, target: &str, detail: Value, ip: &str) {
        let c = self.conn.lock();
        let r = c.execute(
            "INSERT INTO audit(at, user_id, username, action, target, detail, ip) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![now_ms(), actor.map(|u| u.id.clone()), actor.map(|u| u.username.clone()), action, target, detail.to_string(), ip],
        );
        if let Ok(_) = r {
            let id = c.last_insert_rowid();
            if id % 1000 == 0 {
                let _ = c.execute("DELETE FROM audit WHERE id <= ?1", [id - AUDIT_KEEP]);
            }
        }
    }

    pub fn audit_entries(&self, limit: i64, before: Option<i64>, user_id: Option<&str>, action: Option<&str>) -> Result<Vec<AuditEntry>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id, at, user_id, username, action, target, detail, ip FROM audit
             WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR user_id = ?2) AND (?3 IS NULL OR action = ?3 OR action LIKE ?3 || '.%')
             ORDER BY id DESC LIMIT ?4",
        )?;
        let rows = st
            .query_map(params![before, user_id, action, limit.clamp(1, 500)], |r| {
                let user_id: Option<String> = r.get(2)?;
                let username: Option<String> = r.get(3)?;
                let detail: String = r.get(6)?;
                Ok(AuditEntry {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    actor: user_id.map(|id| json!({ "userId": id, "username": username })),
                    action: r.get(4)?,
                    target: r.get(5)?,
                    detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
                    ip: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ---- activity ----

    pub fn add_activity(&self, a: NewActivity) {
        let c = self.conn.lock();
        let (user_id, username, display) = a.user.map(|(i, u, d)| (Some(i), Some(u), Some(d))).unwrap_or((None, None, None));
        let r = c.execute(
            &format!("INSERT INTO activity({}) VALUES(NULL,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", ACTIVITY_COLS),
            params![
                now_ms(), a.account, user_id, username, display, a.device_id, a.device_name, a.device_kind, a.action,
                a.conversation_id, a.conversation_name, a.message_id, a.ok, a.response_ms, a.detail.to_string(), a.account_uid
            ],
        );
        if let Err(e) = r {
            log::warn!("compola server: activity not recorded: {e}");
        }
    }

    pub fn activity(&self, f: &ActivityFilter) -> Result<Vec<Value>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!(
            "SELECT {ACTIVITY_COLS} FROM activity WHERE {ACTIVITY_WHERE} AND (?7 IS NULL OR id < ?7) ORDER BY id DESC LIMIT ?8"
        ))?;
        let rows = st
            .query_map(
                params![f.user_id, f.account, f.conversation_id, f.actions(), f.from, f.to, f.before, f.limit.unwrap_or(100).clamp(1, 1000)],
                activity_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Totals and groups (`user` | `day` | `account` | `conversation`) of the filtered activity.
    pub fn activity_stats(&self, f: &ActivityFilter, group_by: &str) -> Result<Value> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!(
            "SELECT at, account, user_id, COALESCE(display_name, username, ''), action, conversation_id, COALESCE(conversation_name, ''), response_ms
             FROM activity WHERE {ACTIVITY_WHERE} AND ok = 1"
        ))?;
        let mut groups: std::collections::BTreeMap<String, Tally> = std::collections::BTreeMap::new();
        let mut totals = Tally::default();
        let mut rows = st.query(params![f.user_id, f.account, f.conversation_id, f.actions(), f.from, f.to])?;
        while let Some(r) = rows.next()? {
            let at: i64 = r.get(0)?;
            let account: String = r.get(1)?;
            let user: Option<String> = r.get(2)?;
            let user_label: String = r.get(3)?;
            let action: String = r.get(4)?;
            let conversation: Option<String> = r.get(5)?;
            let conversation_label: String = r.get(6)?;
            let response: Option<i64> = r.get(7)?;
            let (key, label) = match group_by {
                "day" => {
                    use chrono::TimeZone;
                    let day = chrono::Local.timestamp_millis_opt(at).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
                    (day, String::new())
                }
                "account" => (account.clone(), String::new()),
                "conversation" => match &conversation {
                    Some(c) => (c.clone(), conversation_label.clone()),
                    None => continue,
                },
                _ => (user.clone().unwrap_or_else(|| "host".into()), if user.is_some() { user_label } else { "Máy chủ".into() }),
            };
            let g = groups.entry(key).or_default();
            if g.label.is_empty() {
                g.label = label;
            }
            g.add(&action, conversation.as_deref(), response);
            totals.add(&action, conversation.as_deref(), response);
        }
        let rows: Vec<Value> = groups.into_iter().map(|(k, t)| t.json(&k)).collect();
        Ok(json!({ "rows": rows, "totals": totals.json("total") }))
    }

    /// The filtered activity as CSV (UTF-8 with BOM, for Excel), oldest first.
    pub fn activity_csv(&self, f: &ActivityFilter) -> Result<String> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("SELECT {ACTIVITY_COLS} FROM activity WHERE {ACTIVITY_WHERE} ORDER BY id LIMIT 1000000"))?;
        let mut out = String::from("\u{feff}thoi_gian,tai_khoan_zalo,nguoi_dung,ten_hien_thi,thiet_bi,ma_thiet_bi,loai_thiet_bi,hanh_dong,hoi_thoai,ten_hoi_thoai,tin_nhan,thanh_cong,phan_hoi_ms\n");
        let mut rows = st.query(params![f.user_id, f.account, f.conversation_id, f.actions(), f.from, f.to])?;
        while let Some(r) = rows.next()? {
            use chrono::TimeZone;
            let at: i64 = r.get(1)?;
            let when = chrono::Local.timestamp_millis_opt(at).single().map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_default();
            let text = |i: usize| r.get::<_, Option<String>>(i).ok().flatten().unwrap_or_default();
            let fields = [
                when,
                text(2),
                text(4),
                text(5),
                text(7),
                text(6),
                text(8),
                text(9),
                text(10),
                text(11),
                text(12),
                if r.get::<_, bool>(13)? { "1".into() } else { "0".into() },
                r.get::<_, Option<i64>>(14)?.map(|v| v.to_string()).unwrap_or_default(),
            ];
            out.push_str(&fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
            out.push('\n');
        }
        Ok(out)
    }

    pub fn audit_recent_count(&self, action: &str, ip: &str, since: i64) -> Result<i64> {
        let c = self.conn.lock();
        Ok(c.query_row("SELECT COUNT(*) FROM audit WHERE action = ?1 AND ip = ?2 AND at > ?3", params![action, ip, since], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(convs: &[&str], labels: &[&str]) -> Scope {
        Scope { all: false, conversations: convs.iter().map(|s| s.to_string()).collect(), labels: labels.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn usernames_are_unique_without_case() {
        let s = Store::memory();
        s.create_user("Lan", "Lan", "", "local", Some("h"), true).unwrap();
        let e = s.create_user(" lan ", "", "", "local", Some("h"), false).unwrap_err();
        assert_eq!(e.status, 409);
        assert!(s.create_user("ext", "", "", "oidc:x", None, false).is_ok());
        assert_eq!(s.create_user("nopass", "", "", "local", None, false).unwrap_err().status, 400);
    }

    #[test]
    fn effective_access_is_max_role_and_union_of_scopes() {
        let s = Store::memory();
        let admin = s.create_user("admin", "", "", "local", Some("h"), true).unwrap();
        let u = s.create_user("an", "", "", "local", Some("h"), false).unwrap();
        assert!(s.access_of(&u).unwrap().0.is_none());
        let g = s.create_group("Sales", "", "local").unwrap();
        s.set_members(&g.id, &[u.id.clone()]).unwrap();
        s.create_grant(Subject { kind: "user".into(), id: u.id.clone() }, "default", Role::Viewer, scope(&["c1"], &[]), "").unwrap();
        s.create_grant(Subject { kind: "group".into(), id: g.id.clone() }, "default", Role::Agent, scope(&["c2"], &["l1"]), "").unwrap();
        let (access, via) = s.access_of(&u).unwrap();
        let access = access.unwrap().for_account("default").unwrap();
        assert_eq!(access.role, Role::Agent);
        assert_eq!(access.scope, scope(&["c1", "c2"], &["l1"]));
        assert_eq!(via.len(), 2);
        assert_eq!(s.access_of(&admin).unwrap().0.unwrap().for_account("a1b2c3d4e").unwrap().role, Role::Admin);
        // Deleting the group removes its grant.
        s.delete_group(&g.id).unwrap();
        assert_eq!(s.access_of(&u).unwrap().0.unwrap().for_account("default").unwrap().role, Role::Viewer);
    }

    #[test]
    fn grants_are_per_account_and_star_needs_every_conversation() {
        let s = Store::memory();
        let u = s.create_user("an", "", "", "local", Some("h"), false).unwrap();
        let me = || Subject { kind: "user".into(), id: u.id.clone() };
        assert_eq!(s.create_grant(me(), "*", Role::Viewer, scope(&["c1"], &[]), "").unwrap_err().status, 400);
        assert_eq!(s.create_grant(me(), "../x", Role::Viewer, Scope { all: true, ..Default::default() }, "").unwrap_err().status, 400);
        s.create_grant(me(), "a1b2c3d4e", Role::Agent, scope(&["c9"], &[]), "").unwrap();
        s.create_grant(me(), "*", Role::Viewer, Scope { all: true, ..Default::default() }, "").unwrap();
        let access = s.access_of(&u).unwrap().0.unwrap();
        // a1b2c3d4: agent (its own grant) with every conversation (from "*").
        let a = access.for_account("a1b2c3d4e").unwrap();
        assert_eq!((a.role, a.scope.all), (Role::Agent, true));
        // Any other account: the "*" viewer grant only.
        let d = access.for_account("default").unwrap();
        assert_eq!((d.role, d.scope.all), (Role::Viewer, true));
        let expanded = access.expanded(&["default".into(), "a1b2c3d4e".into()]);
        assert_eq!(expanded["accounts"]["a1b2c3d4e"]["role"], json!("agent"));
        // Without "*", an account without a grant is out of reach.
        let v = s.create_user("vy", "", "", "local", Some("h"), false).unwrap();
        s.create_grant(Subject { kind: "user".into(), id: v.id.clone() }, "a1b2c3d4e", Role::Viewer, Scope { all: true, ..Default::default() }, "").unwrap();
        assert!(s.access_of(&v).unwrap().0.unwrap().for_account("default").is_none());
    }

    #[test]
    fn old_grants_migrate_to_the_default_account() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(&SCHEMA.replace(", account TEXT NOT NULL DEFAULT 'default'", "")).unwrap();
        conn.execute("INSERT INTO grants(id, subject_type, subject_id, role, scope, note, created_at) VALUES('a_1','user','u','viewer','{\"all\":true}','',1)", []).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let account: String = conn.query_row("SELECT account FROM grants WHERE id = 'a_1'", [], |r| r.get(0)).unwrap();
        assert_eq!(account, "default");
    }

    #[test]
    fn the_last_admin_stays() {
        let s = Store::memory();
        let a = s.create_user("a", "", "", "local", Some("h"), true).unwrap();
        assert_eq!(s.update_user(&a.id, UserPatch { is_admin: Some(false), ..Default::default() }).unwrap_err().status, 409);
        assert_eq!(s.delete_user(&a.id).unwrap_err().status, 409);
    }

    #[test]
    fn sessions_are_found_by_token_only_and_end_with_the_user() {
        let s = Store::memory();
        let u = s.create_user("u", "", "", "local", Some("h"), false).unwrap();
        let (session, token) = s.create_session(&u.id, "device", "dev1", "MacBook", "10.0.0.2", 60_000).unwrap();
        assert!(s.session_by_token("nope", "x", None).unwrap().is_none());
        assert_eq!(s.session_by_token(&token, "10.0.0.2", None).unwrap().unwrap().0.id, session.id);
        s.update_user(&u.id, UserPatch { disabled: Some(true), ..Default::default() }).unwrap();
        assert!(s.session_by_token(&token, "10.0.0.2", None).unwrap().is_none());
    }

    #[test]
    fn activity_is_filtered_grouped_and_exported() {
        let s = Store::memory();
        let add = |user: &str, action: &str, conv: &str, ms: Option<i64>| {
            s.add_activity(NewActivity {
                user: Some((user.into(), user.into(), user.to_uppercase())),
                device_kind: "device".into(),
                action: action.into(),
                conversation_id: Some(conv.into()),
                conversation_name: Some(format!("Khách, {conv}")),
                ok: true,
                response_ms: ms,
                detail: json!({}),
                ..Default::default()
            })
        };
        add("lan", "message.send", "c1", Some(60_000));
        add("lan", "message.send", "c2", Some(120_000));
        add("lan", "message.react", "c1", None);
        add("minh", "message.media", "c1", Some(30_000));
        add("minh", "conversation.open", "c3", None);
        let all = ActivityFilter::default();
        assert_eq!(s.activity(&all).unwrap().len(), 5);
        let lan = ActivityFilter { user_id: Some("lan".into()), ..Default::default() };
        assert_eq!(s.activity(&lan).unwrap().len(), 3);
        let messages = ActivityFilter { action: Some("message".into()), ..Default::default() };
        assert_eq!(s.activity(&messages).unwrap().len(), 4);
        let two = ActivityFilter { action: Some("message.react, conversation.open".into()), ..Default::default() };
        assert_eq!(s.activity(&two).unwrap().len(), 2);
        let stats = s.activity_stats(&all, "user").unwrap();
        assert_eq!(stats["totals"]["sent"], json!(3));
        assert_eq!(stats["totals"]["conversations"], json!(2));
        assert_eq!(stats["totals"]["medianResponseMs"], json!(60_000));
        let lan_row = stats["rows"].as_array().unwrap().iter().find(|r| r["key"] == json!("lan")).unwrap().clone();
        assert_eq!(lan_row["label"], json!("LAN"));
        assert_eq!(lan_row["avgResponseMs"], json!(90_000));
        let csv = s.activity_csv(&all).unwrap();
        assert!(csv.starts_with('\u{feff}'));
        assert_eq!(csv.lines().count(), 6);
        assert!(csv.contains("\"Khách, c1\""));
    }

    #[test]
    fn provider_secrets_are_masked_and_kept() {
        let s = Store::memory();
        let p = s.create_provider("ldap", "AD", true, json!({ "url": "ldaps://x", "bindPassword": "secret" })).unwrap();
        assert_eq!(p.public()["config"]["bindPassword"], json!(SECRET_MASK));
        let p = s.update_provider(&p.id, None, None, Some(json!({ "url": "ldaps://y", "bindPassword": SECRET_MASK }))).unwrap();
        assert_eq!(p.config["bindPassword"], json!("secret"));
        assert_eq!(p.config["url"], json!("ldaps://y"));
    }

    #[test]
    fn external_groups_sync_without_touching_local_ones() {
        let s = Store::memory();
        let u = s.create_user("u", "", "", "ldap:p", None, false).unwrap();
        let local = s.create_group("Kế toán", "", "local").unwrap();
        s.set_members(&local.id, &[u.id.clone()]).unwrap();
        s.sync_external_groups(&u.id, "ldap:p", &["Sales".into(), "kế toán".into()]).unwrap();
        let mine = s.groups_of(&u.id).unwrap();
        assert_eq!(mine.len(), 2); // Sales (new, ldap) + the local one it was already in
        s.sync_external_groups(&u.id, "ldap:p", &[]).unwrap();
        assert_eq!(s.groups_of(&u.id).unwrap(), vec![local.id]);
    }
}
