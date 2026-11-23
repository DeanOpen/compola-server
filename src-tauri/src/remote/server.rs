//! The host side of Compola Server (see `super`). Routes, all but `/info` behind `Authorization: Bearer <code>`:
//!
//! * `GET /info` — `{app: "compola-server", version}` (tells a Compola Server apart from anything else on the port).
//! * `GET /auth` — checks the code: `{app, version, name, instance, phase}`.
//! * `GET /ws` — WebSocket. Server → app: `{t: hello, server}`, `{t: event, event, payload}`, `{t: result, id, ok,
//!   value | error}`, `{t: bye, reason}`. App → server: `{t: invoke, id, cmd, args}` (allow-list in [`dispatch`]).
//! * `GET|HEAD /media/load?…` — the `compola-media` scheme of this app (`media::protocol::respond`), Range included.
//! * `POST /upload?id=<32 hex>&name=<file name>&offset=<n>` — a file to send, in chunks appended in order; answers
//!   `{path: "<id>/<name>", size}`, which `engine_call_with_files` then names.

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
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use super::Remote;
use super::http::{Conn, Head};

/// Joined apps at once.
const MAX_SESSIONS: usize = 16;
/// TCP connections at once (media loads use a few each).
const MAX_CONNECTIONS: usize = 128;
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

struct Peer {
    id: String,
    name: String,
    addr: String,
    since: i64,
    kick: mpsc::UnboundedSender<&'static str>,
}

pub struct Hub {
    tx: broadcast::Sender<Arc<str>>,
    peers: Mutex<Vec<Peer>>,
}

impl Hub {
    pub fn new() -> Self {
        Self { tx: broadcast::channel(8192).0, peers: Mutex::new(Vec::new()) }
    }

    pub fn has_clients(&self) -> bool {
        self.tx.receiver_count() > 0
    }

    pub fn publish(&self, message: &Value) {
        let _ = self.tx.send(Arc::from(message.to_string()));
    }

    pub fn clients_json(&self) -> Vec<Value> {
        self.peers.lock().iter().map(|p| json!({ "id": p.id, "name": p.name, "address": p.addr, "since": p.since })).collect()
    }

    pub fn kick(&self, id: &str, reason: &'static str) -> bool {
        self.peers.lock().iter().find(|p| p.id == id).is_some_and(|p| p.kick.send(reason).is_ok())
    }

    pub fn kick_all(&self, reason: &'static str) {
        for p in self.peers.lock().iter() {
            let _ = p.kick.send(reason);
        }
    }

    fn remove(&self, id: &str) {
        self.peers.lock().retain(|p| p.id != id);
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

fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
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

        if method == "GET" && (path == "/" || path == "/info") {
            if conn.skip_body(length).await.is_err() {
                return;
            }
            let _ = conn.respond_json(200, &json!({ "app": "compola-server", "version": version() }), close).await;
            if close {
                return;
            }
            continue;
        }

        let code = remote.server_config().code;
        if !head.bearer().is_some_and(|given| super::codes_match(&code, given)) {
            log::info!("compola server: refused {method} {path} from {peer} (access code)");
            tokio::time::sleep(Duration::from_millis(800)).await;
            let _ = conn.respond_json(401, &json!({ "error": "Mã truy cập không đúng" }), true).await;
            return;
        }

        let result = match (method.as_str(), path.as_str()) {
            ("GET", "/auth") => {
                let body = json!({
                    "app": "compola-server",
                    "version": version(),
                    "name": remote.server_config().name,
                    "instance": remote.config.lock().instance.clone(),
                    "phase": remote.phase_kind(),
                });
                match conn.skip_body(length).await {
                    Ok(()) => conn.respond_json(200, &body, close).await,
                    Err(e) => Err(e),
                }
            }
            ("GET", "/ws") if head.is_websocket_upgrade() => {
                upgrade(remote, conn, head, peer).await;
                return;
            }
            ("GET" | "HEAD", "/media/load") => match conn.skip_body(length).await {
                Ok(()) => media(&remote, &mut conn, &head, close).await,
                Err(e) => Err(e),
            },
            ("POST", "/upload") => upload(&mut conn, &head, length, close).await,
            _ => match conn.skip_body(length).await {
                Ok(()) => conn.respond_json(404, &json!({ "error": "not found" }), close).await,
                Err(e) => Err(e),
            },
        };
        if result.is_err() || close {
            return;
        }
    }
}

async fn media(remote: &Remote, conn: &mut Conn, head: &Head, close: bool) -> std::io::Result<()> {
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

async fn upgrade(remote: Arc<Remote>, mut conn: Conn, head: Head, peer: SocketAddr) {
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
    let device = head
        .header("x-compola-device")
        .map(|d| url::form_urlencoded::parse(format!("d={d}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default())
        .map(|d| d.chars().filter(|c| !c.is_control()).take(60).collect::<String>())
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| "Compola".into());
    let ws = WebSocketStream::from_raw_socket(conn.into_stream(), Role::Server, Some(ws_config())).await;
    session(remote, ws, peer, device).await;
}

async fn session(remote: Arc<Remote>, ws: WebSocketStream<TcpStream>, peer: SocketAddr, device: String) {
    let (mut sink, mut source) = ws.split();
    let mut events = remote.hub.tx.subscribe();
    let (kick_tx, mut kick_rx) = mpsc::unbounded_channel();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let id = uuid::Uuid::new_v4().simple().to_string();
    remote.hub.peers.lock().push(Peer {
        id: id.clone(),
        name: device.clone(),
        addr: peer.ip().to_string(),
        since: chrono::Utc::now().timestamp_millis(),
        kick: kick_tx,
    });
    log::info!("compola server: {device} joined from {}", peer.ip());
    remote.changed();

    let config = remote.server_config();
    let hello = json!({ "t": "hello", "server": { "name": config.name, "version": version(), "instance": remote.config.lock().instance.clone() } });
    let mut alive = sink.send(Message::text(hello.to_string())).await.is_ok();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut last_seen = Instant::now();
    while alive {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    last_seen = Instant::now();
                    handle_text(&remote, text.as_str(), &out_tx);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => last_seen = Instant::now(),
            },
            event = events.recv() => match event {
                Ok(text) => alive = sink.send(Message::text(text.to_string())).await.is_ok(),
                // Too slow to keep up: it reconnects and catches up through the replay.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = sink.send(Message::text(json!({ "t": "bye", "reason": "lagged" }).to_string())).await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(out) = out_rx.recv() => alive = sink.send(Message::text(out)).await.is_ok(),
            reason = kick_rx.recv() => {
                let _ = sink.send(Message::text(json!({ "t": "bye", "reason": reason.unwrap_or("closed") }).to_string())).await;
                let _ = sink.close().await;
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
    remote.hub.remove(&id);
    log::info!("compola server: {device} left");
    remote.changed();
}

fn handle_text(remote: &Arc<Remote>, text: &str, out: &mpsc::UnboundedSender<String>) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    if msg.get("t").and_then(Value::as_str) != Some("invoke") {
        return;
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or_default().to_owned();
    let args = msg.get("args").cloned().unwrap_or_else(|| json!({}));
    let remote = remote.clone();
    let out = out.clone();
    tauri::async_runtime::spawn(async move {
        let reply = match dispatch(&remote, &cmd, &args).await {
            Ok(value) => json!({ "t": "result", "id": id, "ok": true, "value": value }),
            Err(error) => json!({ "t": "result", "id": id, "ok": false, "error": error }),
        };
        let _ = out.send(reply.to_string());
    });
}

/// The engine commands a joined app may run. Anything that would act on this Mac itself (sign out, switch storage,
/// show the renderer, dev eval, calls, screen capture, settings of this app) is refused.
async fn dispatch(remote: &Remote, cmd: &str, args: &Value) -> Result<Value, String> {
    let engine = remote.engine().ok_or("engine not running")?;
    let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let list = |k: &str| args.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    match cmd {
        "engine_phase" => serde_json::to_value(engine.phase()).map_err(|e| e.to_string()),
        "engine_info" => Ok(engine.info()),
        "engine_replay" => Ok(Value::Array(engine.replay())),
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
        _ => Err(format!("Lệnh «{cmd}» không dùng được khi kết nối qua Compola Server.")),
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
