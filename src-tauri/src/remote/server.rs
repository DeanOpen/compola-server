//! The host side of Compola Server (see `super`, docs/compola-server.md). Routes:
//!
//! * `GET /info` — `{app: "compola-server", version}`.
//! * `/api/*` — sign-in, device flow, admin API (`super::api`); `/admin/*` — the admin console.
//! * `GET /ws` (Bearer device token) — WebSocket. Server → app: `{t: hello, server, user, access}`, `{t: event, event,
//!   payload}` (filtered by the user's access), `{t: result, id, ok, value | error}`, `{t: access, access}`,
//!   `{t: bye, reason}`. App → server: `{t: invoke, id, cmd, args}` (checked by `policy::check_call`).
//! * `GET|HEAD /media/load?…` (Bearer) — the `compola-media` scheme of this app, Range included.
//! * `POST /upload?id=<32 hex>&name=&offset=` (Bearer, agent) — a file to send, appended in chunks.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role as WsRole, WebSocketConfig};

use super::Remote;
use super::http::{Conn, Head};
use super::policy::{self, Access, CallKind, Role};
use super::store::{Session, User};

/// Joined apps at once.
const MAX_SESSIONS: usize = 32;
/// TCP connections at once (media loads use a few each).
const MAX_CONNECTIONS: usize = 192;
const IDLE: Duration = Duration::from_secs(75);
const PING_EVERY: Duration = Duration::from_secs(20);
/// Largest upload chunk and file.
const MAX_CHUNK: u64 = 32 << 20;
const MAX_UPLOAD: u64 = 2 << 30;
/// Uploads older than this are removed.
const UPLOAD_TTL: Duration = Duration::from_secs(6 * 3600);

pub const CALLS_UNSUPPORTED: &str = "Cuộc gọi chưa dùng được khi kết nối qua Compola Server.";

pub fn ws_config() -> WebSocketConfig {
    let mut c = WebSocketConfig::default();
    // `engine_replay` can be large on a busy account.
    c.max_message_size = Some(512 << 20);
    c.max_frame_size = Some(512 << 20);
    c
}

// ---- connected apps ----

/// An event for every session; each filters it with its own access.
#[derive(Clone)]
pub struct Broadcast {
    pub event: Arc<str>,
    pub payload: Arc<Value>,
}

struct Peer {
    session_id: String,
    user_id: String,
    username: String,
    device_id: String,
    device_name: String,
    addr: String,
    since: i64,
    access: Arc<Mutex<Access>>,
    kick: mpsc::UnboundedSender<&'static str>,
    push: mpsc::UnboundedSender<String>,
}

pub struct Hub {
    tx: broadcast::Sender<Broadcast>,
    peers: Mutex<Vec<Peer>>,
}

impl Hub {
    pub fn new() -> Self {
        Self { tx: broadcast::channel(8192).0, peers: Mutex::new(Vec::new()) }
    }

    pub fn has_clients(&self) -> bool {
        self.tx.receiver_count() > 0
    }

    pub fn publish(&self, event: &str, payload: Value) {
        let _ = self.tx.send(Broadcast { event: Arc::from(event), payload: Arc::new(payload) });
    }

    pub fn clients_json(&self) -> Vec<Value> {
        self.peers
            .lock()
            .iter()
            .map(|p| {
                json!({
                    "id": p.session_id, "userId": p.user_id, "username": p.username, "deviceId": p.device_id,
                    "deviceName": p.device_name, "address": p.addr, "since": p.since, "role": p.access.lock().role,
                })
            })
            .collect()
    }

    pub fn online_sessions(&self) -> Vec<String> {
        self.peers.lock().iter().map(|p| p.session_id.clone()).collect()
    }

    /// Ends the sessions of a revoked sign-in.
    pub fn kick_session(&self, session_id: &str, reason: &'static str) -> bool {
        self.peers.lock().iter().filter(|p| p.session_id == session_id).fold(false, |any, p| p.kick.send(reason).is_ok() || any)
    }

    pub fn kick_all(&self, reason: &'static str) {
        for p in self.peers.lock().iter() {
            let _ = p.kick.send(reason);
        }
    }

    /// Re-evaluates every connected user's access (an admin changed users, groups or grants).
    pub fn refresh_access(&self, access_of: impl Fn(&str) -> Option<Access>, snapshot: impl Fn(&Access) -> Option<Value>) {
        for p in self.peers.lock().iter() {
            match access_of(&p.user_id) {
                None => {
                    let _ = p.kick.send("revoked");
                }
                Some(next) => {
                    let mut current = p.access.lock();
                    if *current != next {
                        *current = next.clone();
                        let _ = p.push.send(json!({ "t": "access", "access": next }).to_string());
                        if let Some(snapshot) = snapshot(&next) {
                            let _ = p.push.send(json!({ "t": "event", "event": "compola://state", "payload": snapshot }).to_string());
                        }
                    }
                }
            }
        }
    }

    fn remove(&self, session_id: &str, since: i64) {
        self.peers.lock().retain(|p| !(p.session_id == session_id && p.since == since));
    }
}

// ---- listener ----

pub struct Handle {
    pub port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start(remote: Weak<Remote>, port: u16, allow_network: bool) -> Result<Handle, String> {
    let ip = if allow_network { "0.0.0.0" } else { "127.0.0.1" };
    let listener = TcpListener::bind((ip, port)).await.map_err(|e| format!("không mở được cổng {port}: {e}"))?;
    log::info!("compola server listening on {ip}:{port}");
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else { continue };
            let Some(remote) = remote.upgrade() else { break };
            let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
            let _ = stream.set_nodelay(true);
            tauri::async_runtime::spawn(async move {
                serve(remote, stream, peer).await;
                drop(permit);
            });
        }
    });
    Ok(Handle { port, task })
}

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The client address: the socket's, or — when the connection comes from this Mac (a tunnel / reverse proxy on
/// loopback) — the first `X-Forwarded-For` hop.
fn client_ip(head: &Head, peer: &SocketAddr) -> String {
    if peer.ip().is_loopback() {
        if let Some(forwarded) = head.header("x-forwarded-for").and_then(|v| v.split(',').next()).map(str::trim).filter(|v| !v.is_empty()) {
            return forwarded.chars().take(64).collect();
        }
    }
    peer.ip().to_string()
}

async fn serve(remote: Arc<Remote>, stream: TcpStream, peer: SocketAddr) {
    let mut conn = Conn::new(stream);
    loop {
        let head = match tokio::time::timeout(IDLE, conn.read_head()).await {
            Ok(Ok(Some(h))) => h,
            _ => return,
        };
        let Ok(length) = head.content_length() else {
            let _ = conn.respond_json(411, &json!({ "error": "Content-Length required" }), true).await;
            return;
        };
        let close = head.wants_close();
        let method = head.method.clone();
        let path = head.path().to_owned();
        let ip = client_ip(&head, &peer);

        let result = if method == "GET" && (path == "/" || path == "/info") {
            match conn.skip_body(length).await {
                Ok(()) => conn.respond_json(200, &json!({ "app": "compola-server", "version": version() }), close).await,
                Err(e) => Err(e),
            }
        } else if path == "/admin" || path.starts_with("/admin/") {
            match conn.skip_body(length).await {
                Ok(()) => {
                    let reply = super::api::admin_file(&path);
                    conn.respond(reply.status, &reply.headers, &reply.body, method == "HEAD", close).await
                }
                Err(e) => Err(e),
            }
        } else if path.starts_with("/api/") {
            if length > super::api::MAX_BODY {
                let _ = conn.respond_json(413, &json!({ "error": "Dữ liệu quá lớn" }), true).await;
                return;
            }
            let mut body = Vec::with_capacity(length as usize);
            if conn.read_body_into(length, &mut body).await.is_err() {
                return;
            }
            let reply = super::api::handle(&remote, &head, &body, &ip).await;
            conn.respond(reply.status, &reply.headers, &reply.body, method == "HEAD", close).await
        } else {
            // Joined apps: a device session with access to the account.
            let Some((session, user, access)) = device_session(&remote, &head, &ip) else {
                tokio::time::sleep(Duration::from_millis(600)).await;
                let _ = conn.respond_json(401, &json!({ "error": "Phiên đăng nhập đã hết hạn hoặc bị thu hồi." }), true).await;
                return;
            };
            match (method.as_str(), path.as_str()) {
                ("GET", "/ws") if head.is_websocket_upgrade() => {
                    upgrade(remote, conn, head, ip, session, user, access).await;
                    return;
                }
                ("GET" | "HEAD", "/media/load") => match conn.skip_body(length).await {
                    Ok(()) => media(&remote, &mut conn, &head, close).await,
                    Err(e) => Err(e),
                },
                ("POST", "/upload") if access.role >= Role::Agent => upload(&mut conn, &head, length, close).await,
                ("POST", "/upload") => {
                    let _ = conn.respond_json(403, &json!({ "error": "Bạn chỉ có quyền xem." }), true).await;
                    return;
                }
                _ => match conn.skip_body(length).await {
                    Ok(()) => conn.respond_json(404, &json!({ "error": "not found" }), close).await,
                    Err(e) => Err(e),
                },
            }
        };
        if result.is_err() || close {
            return;
        }
    }
}

fn device_session(remote: &Remote, head: &Head, ip: &str) -> Option<(Session, User, Access)> {
    let token = head.bearer()?;
    let auth = remote.auth()?;
    let (session, user) = auth.store.session_by_token(token, ip, Some(super::auth::DEVICE_TTL_MS)).ok()??;
    if session.kind != "device" {
        return None;
    }
    let access = auth.store.access_of(&user).ok()?.0?;
    Some((session, user, access))
}

/// Local files a joined user may load: downloaded media (`…/ZaloDownloads/…`), the media cache and the zCloud cache.
/// Never the Zalo databases, settings or other people's uploads, which also live under the folders this app's own
/// UI may read.
fn remote_may_read(path: &std::path::Path) -> bool {
    let Ok(resolved) = std::fs::canonicalize(path) else { return false };
    let base = crate::platform::app_support();
    let under = |root: PathBuf| std::fs::canonicalize(root).is_ok_and(|r| resolved.starts_with(&r) && resolved != r);
    let in_downloads = under(base.join("ZaloData")) && resolved.components().any(|c| c.as_os_str() == "ZaloDownloads");
    let temp = std::env::temp_dir().join("Compola");
    in_downloads || under(base.join("MediaCache")) || (under(temp.clone()) && !under(temp.join("remote-uploads")))
}

/// The local file a `compola-media` query names (`file=` or `url=file://…`), if any.
fn local_target(head: &Head) -> Option<PathBuf> {
    if let Some(file) = head.param("file") {
        return Some(PathBuf::from(file));
    }
    let url = url::Url::parse(&head.param("url")?).ok()?;
    (url.scheme() == "file").then(|| url.to_file_path().ok()).flatten()
}

async fn media(remote: &Remote, conn: &mut Conn, head: &Head, close: bool) -> std::io::Result<()> {
    if let Some(path) = local_target(head) {
        if !remote_may_read(&path) {
            return conn.respond_json(403, &json!({ "error": "path not allowed" }), close).await;
        }
    }
    let uri = format!("compola-media://load?{}", head.query());
    let mut builder = http::Request::builder().method(head.method.as_str()).uri(uri);
    if let Some(range) = head.header("range") {
        builder = builder.header(http::header::RANGE, range);
    }
    let response = match builder.body(Vec::new()) {
        Ok(request) => crate::media::protocol::respond(&remote.app, &request).await,
        Err(_) => return conn.respond_json(400, &json!({ "error": "bad request" }), close).await,
    };
    let headers: Vec<(String, String)> =
        response.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_owned(), v.to_owned()))).collect();
    conn.respond(response.status().as_u16(), &headers, response.body(), head.method == "HEAD", close).await
}

// ---- uploads ----

pub fn uploads_root() -> PathBuf {
    std::env::temp_dir().join("Compola").join("remote-uploads")
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A file name without path separators, control characters or a leading dot; None when nothing usable is left.
pub fn safe_file_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(180).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_owned();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `<id>/<name>` of an upload → its absolute path, only when it lies inside the uploads folder.
pub fn resolve_upload(reference: &str) -> Option<String> {
    let (id, name) = reference.split_once('/')?;
    if !valid_id(id) || safe_file_name(name).as_deref() != Some(name) {
        return None;
    }
    let root = std::fs::canonicalize(uploads_root()).ok()?;
    let path = std::fs::canonicalize(root.join(id).join(name)).ok()?;
    (path.starts_with(&root) && path.is_file()).then(|| path.to_string_lossy().into_owned())
}

fn sweep_uploads() {
    let Ok(entries) = std::fs::read_dir(uploads_root()) else { return };
    for e in entries.flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|d| d > UPLOAD_TTL)) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

async fn upload(conn: &mut Conn, head: &Head, length: u64, close: bool) -> std::io::Result<()> {
    let id = head.param("id").unwrap_or_default();
    let name = head.param("name").and_then(|n| safe_file_name(&n));
    let offset: Option<u64> = head.param("offset").and_then(|o| o.parse().ok());
    let (Some(name), Some(offset)) = (name, offset) else {
        conn.skip_body(length).await?;
        return conn.respond_json(400, &json!({ "error": "id, name, offset" }), close).await;
    };
    if !valid_id(&id) {
        conn.skip_body(length).await?;
        return conn.respond_json(400, &json!({ "error": "bad id" }), close).await;
    }
    if length > MAX_CHUNK || offset.saturating_add(length) > MAX_UPLOAD {
        // The body is not read: the connection ends with the answer.
        return conn.respond_json(413, &json!({ "error": "Tệp quá lớn" }), true).await;
    }
    let dir = uploads_root().join(&id);
    let path = dir.join(&name);
    let opened = async {
        if offset == 0 {
            tokio::task::spawn_blocking(sweep_uploads).await.ok();
            tokio::fs::create_dir_all(&dir).await?;
            tokio::fs::File::create(&path).await
        } else {
            let file = tokio::fs::OpenOptions::new().append(true).open(&path).await?;
            if file.metadata().await?.len() != offset {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "offset"));
            }
            Ok(file)
        }
    }
    .await;
    let mut file = match opened {
        Ok(f) => f,
        Err(e) => {
            conn.skip_body(length).await?;
            return conn.respond_json(409, &json!({ "error": e.to_string() }), close).await;
        }
    };
    conn.read_body_into(length, &mut file).await?;
    use tokio::io::AsyncWriteExt;
    file.flush().await?;
    conn.respond_json(200, &json!({ "path": format!("{id}/{name}"), "size": offset + length }), close).await
}

// ---- WebSocket session ----

async fn upgrade(remote: Arc<Remote>, mut conn: Conn, head: Head, ip: String, session: Session, user: User, access: Access) {
    let Some(key) = head.header("sec-websocket-key") else {
        let _ = conn.respond_json(400, &json!({ "error": "Sec-WebSocket-Key" }), true).await;
        return;
    };
    if remote.hub.peers.lock().len() >= MAX_SESSIONS {
        let _ = conn.respond_json(503, &json!({ "error": "Quá nhiều thiết bị đang kết nối" }), true).await;
        return;
    }
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    let response = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    if conn.write_raw(response.as_bytes()).await.is_err() {
        return;
    }
    let ws = WebSocketStream::from_raw_socket(conn.into_stream(), WsRole::Server, Some(ws_config())).await;
    session_loop(remote, ws, ip, session, user, access).await;
}

/// What one joined user's session needs while it runs.
struct Who {
    user: User,
    session: Session,
    ip: String,
    access: Arc<Mutex<Access>>,
}

async fn session_loop(remote: Arc<Remote>, ws: WebSocketStream<TcpStream>, ip: String, session: Session, user: User, access: Access) {
    let (mut sink, mut source) = ws.split();
    let mut events = remote.hub.tx.subscribe();
    let (kick_tx, mut kick_rx) = mpsc::unbounded_channel();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let since = super::store::now_ms();
    let shared_access = Arc::new(Mutex::new(access.clone()));
    remote.hub.peers.lock().push(Peer {
        session_id: session.id.clone(),
        user_id: user.id.clone(),
        username: user.username.clone(),
        device_id: session.device_id.clone(),
        device_name: session.device_name.clone(),
        addr: ip.clone(),
        since,
        access: shared_access.clone(),
        kick: kick_tx,
        push: out_tx.clone(),
    });
    log::info!("compola server: {} joined on «{}» from {ip}", user.username, session.device_name);
    remote.changed();
    let who = Arc::new(Who { user: user.clone(), session: session.clone(), ip: ip.clone(), access: shared_access.clone() });

    let hello = json!({
        "t": "hello",
        "server": { "name": remote.server_name(), "version": version() },
        "user": user.brief(),
        "access": access,
    });
    let mut alive = sink.send(Message::text(hello.to_string())).await.is_ok();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut last_seen = Instant::now();
    let mut bye: Option<&'static str> = None;
    // filter_event is stateless: when label membership or this user's access changes, the conversation list is sent
    // again whole, so conversations that left the scope disappear from it.
    let mut seen_generation = remote.mirror.read().generation();
    let mut seen_access = access.clone();
    while alive {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    last_seen = Instant::now();
                    handle_text(&remote, &who, text.as_str(), &out_tx);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => last_seen = Instant::now(),
            },
            event = events.recv() => match event {
                Ok(b) => {
                    let current = shared_access.lock().clone();
                    let resync = {
                        let mirror = remote.mirror.read();
                        let generation = mirror.generation();
                        let stale = generation != seen_generation || current != seen_access;
                        seen_generation = generation;
                        seen_access = current.clone();
                        stale.then(|| mirror.conversations_snapshot(&current)).flatten()
                    };
                    if let Some(snapshot) = resync {
                        let text = json!({ "t": "event", "event": "compola://state", "payload": snapshot }).to_string();
                        if sink.send(Message::text(text)).await.is_err() {
                            break;
                        }
                    }
                    let filtered = policy::filter_event(&current, &remote.mirror.read(), &b.event, &b.payload);
                    if let Some(payload) = filtered {
                        let text = json!({ "t": "event", "event": &*b.event, "payload": payload }).to_string();
                        alive = sink.send(Message::text(text)).await.is_ok();
                    }
                }
                // Too slow to keep up: it reconnects and catches up through the replay.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    bye = Some("lagged");
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(out) = out_rx.recv() => alive = sink.send(Message::text(out)).await.is_ok(),
            reason = kick_rx.recv() => {
                bye = Some(reason.unwrap_or("closed"));
                break;
            }
            _ = ping.tick() => {
                if last_seen.elapsed() > IDLE {
                    break;
                }
                alive = sink.send(Message::Ping(Vec::new().into())).await.is_ok();
            }
        }
    }
    if let Some(reason) = bye {
        let _ = sink.send(Message::text(json!({ "t": "bye", "reason": reason }).to_string())).await;
        let _ = sink.close().await;
    }
    remote.hub.remove(&session.id, since);
    log::info!("compola server: {} left «{}»", user.username, session.device_name);
    remote.changed();
}

fn handle_text(remote: &Arc<Remote>, who: &Arc<Who>, text: &str, out: &mpsc::UnboundedSender<String>) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    if msg.get("t").and_then(Value::as_str) != Some("invoke") {
        return;
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or_default().to_owned();
    let args = msg.get("args").cloned().unwrap_or_else(|| json!({}));
    let remote = remote.clone();
    let who = who.clone();
    let out = out.clone();
    tauri::async_runtime::spawn(async move {
        let reply = match dispatch(&remote, &who, &cmd, &args).await {
            Ok(value) => json!({ "t": "result", "id": id, "ok": true, "value": value }),
            Err(error) => json!({ "t": "result", "id": id, "ok": false, "error": error }),
        };
        let _ = out.send(reply.to_string());
    });
}

fn audit(remote: &Remote, who: &Who, action: &str, target: &str, detail: Value) {
    if let Some(auth) = remote.auth() {
        let mut detail = detail;
        detail["deviceId"] = json!(who.session.device_id);
        detail["deviceName"] = json!(who.session.device_name);
        auth.store.audit(Some(&who.user), action, target, detail, &who.ip);
    }
}

/// One invoke of a joined user: the policy decides, the engine runs it, read results are filtered.
async fn dispatch(remote: &Remote, who: &Who, cmd: &str, args: &Value) -> Result<Value, String> {
    let access = who.access.lock().clone();
    let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let list = |k: &str| args.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let target_method = format!("{}.{}", text("target"), text("method"));

    let kind = {
        let mirror = remote.mirror.read();
        policy::check_call(&access, &mirror, cmd, args)
    };
    let kind = match kind {
        Ok(k) => k,
        Err(reason) => {
            audit(remote, who, "denied", cmd, json!({ "call": target_method, "reason": reason }));
            return Err(reason);
        }
    };

    let engine = remote.engine().ok_or("engine not running")?;
    let result = match cmd {
        "engine_phase" => serde_json::to_value(engine.phase()).map_err(|e| e.to_string()),
        "engine_info" => Ok(engine.info()),
        "engine_replay" => {
            let mirror = remote.mirror.read();
            let events = engine.replay().into_iter().filter_map(|e| policy::filter_event(&access, &mirror, "compola://state", &e)).collect();
            Ok(Value::Array(events))
        }
        "engine_call" => {
            let target = text("target");
            if target.starts_with("__zaloCall") {
                return Err(CALLS_UNSUPPORTED.into());
            }
            engine.call_adapter(&target, &text("method"), list("args")).await
        }
        "engine_call_with_files" => {
            let mut paths = Vec::new();
            for reference in list("files") {
                let reference = reference.as_str().unwrap_or_default();
                paths.push(resolve_upload(reference).ok_or_else(|| format!("Không tìm thấy tệp đã tải lên: {reference}"))?);
            }
            engine.call_adapter_with_files(&text("target"), &text("method"), list("args"), paths).await
        }
        "engine_refresh_qr" => {
            engine.refresh_qr();
            Ok(Value::Null)
        }
        "engine_retry_runtime" => {
            engine.retry_runtime_setup();
            Ok(Value::Null)
        }
        "automation_search" | "automation_search_status" | "automation_conversations" | "automation_messages" => automation(remote, cmd, args).await,
        _ => Err(format!("Lệnh «{cmd}» không dùng được khi kết nối qua Compola Server.")),
    };
    if kind == CallKind::Write {
        let ok = result.is_ok();
        let action = if cmd == "engine_call" || cmd == "engine_call_with_files" { format!("call.{target_method}") } else { format!("call.{cmd}") };
        audit(remote, who, &action, "", json!({ "ok": ok }));
    }
    let result = result?;
    // Undo ids, group members, mention candidates… the policy needs to check later calls.
    if cmd == "engine_call" || cmd == "engine_call_with_files" {
        remote.mirror.write().observe_result(cmd, args, &result);
    }
    if kind == CallKind::Read {
        let mirror = remote.mirror.read();
        return Ok(policy::filter_result(&access, &mirror, cmd, args, result));
    }
    Ok(result)
}

async fn automation(remote: &Remote, cmd: &str, args: &Value) -> Result<Value, String> {
    use tauri::Manager;
    let a = remote.app.try_state::<Arc<crate::automation::Automation>>().map(|s| s.inner().clone()).ok_or("automation not running")?;
    let text = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned).filter(|s| !s.is_empty());
    let num = |k: &str, d: u64| args.get(k).and_then(Value::as_u64).unwrap_or(d) as usize;
    match cmd {
        "automation_search" => {
            a.search_messages(&text("query").unwrap_or_default(), text("conversationId"), num("limit", 30).clamp(1, 200), num("context", 0).min(10)).await
        }
        "automation_search_status" => Ok(a.search_status_json()),
        "automation_conversations" => serde_json::to_value(a.find_conversations(text("query").as_deref(), num("limit", 50), false)).map_err(|e| e.to_string()),
        "automation_messages" => serde_json::to_value(a.recent_messages(text("conversationId").as_deref(), num("limit", 50))).map_err(|e| e.to_string()),
        _ => Err("unknown".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_names_cannot_leave_their_folder() {
        assert_eq!(safe_file_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_file_name("a/b\\c.png").as_deref(), Some("c.png"));
        assert_eq!(safe_file_name("..").as_deref(), None);
        assert_eq!(safe_file_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(safe_file_name("Ảnh chụp 1.png").as_deref(), Some("Ảnh chụp 1.png"));
        assert!(resolve_upload("../x").is_none());
        assert!(resolve_upload("0123456789abcdef0123456789abcdef/../../x").is_none());
    }

    #[test]
    fn joined_users_cannot_read_databases_or_uploads() {
        let base = crate::platform::app_support();
        assert!(!remote_may_read(&base.join("ZaloData/sqlite")));
        assert!(!remote_may_read(&base.join("server.db")));
        assert!(!remote_may_read(&base.join("cookies.json")));
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = uploads_root().join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.txt"), b"x").unwrap();
        assert!(!remote_may_read(&dir.join("x.txt")));
        let other = std::env::temp_dir().join("Compola").join(format!("zcloud-{id}.jpg"));
        std::fs::write(&other, b"x").unwrap();
        assert!(remote_may_read(&other));
        std::fs::remove_file(other).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn uploads_resolve_inside_the_folder_only() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = uploads_root().join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.txt"), b"x").unwrap();
        assert!(resolve_upload(&format!("{id}/x.txt")).is_some());
        assert!(resolve_upload(&format!("{id}/y.txt")).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
