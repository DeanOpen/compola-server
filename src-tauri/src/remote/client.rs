//! The joined side of Compola Server (see `super`): one WebSocket to the host with reconnects, the UI's commands as
//! `invoke` messages, the host's events re-emitted to this app's UI window, and media / files over HTTP.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest};

use super::{DEFAULT_PORT, EVENT, JoinConfig, NOTIFICATION_EVENT};

const NOT_CONNECTED: &str = "Chưa kết nối được tới Compola Server.";
const CONNECTION_LOST: &str = "Mất kết nối tới Compola Server.";
/// Upload chunk (the server takes up to 32 MB).
const CHUNK: usize = 8 << 20;

// ---- URLs ----

/// What the user typed → the server's base URL (`http(s)://host:port/<prefix>/`). A bare address gets `http://` and the
/// default port; `ws(s)://` is taken as `http(s)://`.
pub fn normalize_url(input: &str) -> Result<url::Url, String> {
    let t = input.trim();
    if t.is_empty() {
        return Err("Nhập địa chỉ của Compola Server.".into());
    }
    let bare = !t.contains("://");
    let with_scheme = if bare { format!("http://{t}") } else { t.to_owned() };
    let mut u = url::Url::parse(&with_scheme).map_err(|_| format!("Địa chỉ không hợp lệ: {t}"))?;
    let scheme = match u.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        other => return Err(format!("Không hỗ trợ giao thức {other}://")),
    };
    u.set_scheme(scheme).map_err(|_| format!("Địa chỉ không hợp lệ: {t}"))?;
    if u.host_str().is_none_or(str::is_empty) {
        return Err(format!("Địa chỉ không hợp lệ: {t}"));
    }
    if bare && u.port().is_none() {
        let _ = u.set_port(Some(DEFAULT_PORT));
    }
    u.set_query(None);
    u.set_fragment(None);
    let _ = u.set_username("");
    let _ = u.set_password(None);
    // A trailing `/ws` (copied from somewhere) is not part of the base.
    let path = u.path().trim_end_matches('/').trim_end_matches("/ws").to_owned();
    u.set_path(&format!("{path}/"));
    Ok(u)
}

fn endpoint(base: &url::Url, path: &str) -> String {
    format!("{}{path}", base.as_str())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap_or_default()
}

/// What `GET /auth` answered.
pub struct ServerInfo {
    pub name: String,
    pub instance: String,
}

fn describe(e: &reqwest::Error, base: &url::Url) -> String {
    let host = base.host_str().unwrap_or_default();
    if e.is_timeout() {
        format!("{host} không phản hồi. Kiểm tra địa chỉ, và máy chủ đang bật Compola Server.")
    } else if e.is_connect() {
        format!("Không kết nối được tới {host}. Kiểm tra địa chỉ, cổng và mạng (LAN / Tailscale).")
    } else {
        format!("Không kết nối được tới {host}: {e}")
    }
}

/// Checks that `base` is a Compola Server and `code` opens it.
pub async fn probe(base: &url::Url, code: &str) -> Result<ServerInfo, String> {
    let response = http_client()
        .get(endpoint(base, "auth"))
        .bearer_auth(code)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| describe(&e, base))?;
    let status = response.status().as_u16();
    let body: Value = response.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    if status == 401 {
        return Err("Mã truy cập không đúng.".into());
    }
    if status != 200 || body.get("app").and_then(Value::as_str) != Some("compola-server") {
        return Err("Địa chỉ này không phải Compola Server.".into());
    }
    let text = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    Ok(ServerInfo { name: text("name"), instance: text("instance") })
}

// ---- client ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// connecting | connected | disconnected
    pub state: &'static str,
    pub error: Option<String>,
    pub server_name: String,
    pub url: String,
    pub device_name: String,
    /// Was connected at least once since launch (a drop then means "reconnecting", not "cannot connect").
    pub ever_connected: bool,
    /// Next automatic attempt, epoch ms.
    pub retry_at: Option<i64>,
}

pub struct Client {
    app: AppHandle,
    join: JoinConfig,
    base: url::Url,
    http: reqwest::Client,
    status: Mutex<Status>,
    connected: watch::Sender<bool>,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    wake: Notify,
}

enum Failure {
    Auth,
    Other(String),
}

impl Client {
    pub fn new(app: AppHandle, join: JoinConfig) -> Result<Arc<Self>, String> {
        let base = normalize_url(&join.url)?;
        let status = Status {
            state: "connecting",
            error: None,
            server_name: join.server_name.clone(),
            url: base.to_string(),
            device_name: join.device_name.clone(),
            ever_connected: false,
            retry_at: None,
        };
        Ok(Arc::new(Self {
            app,
            join,
            base,
            http: http_client(),
            status: Mutex::new(status),
            connected: watch::channel(false).0,
            out: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            wake: Notify::new(),
        }))
    }

    pub fn start(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move { this.run().await });
    }

    pub fn status_json(&self) -> Value {
        serde_json::to_value(self.status.lock().clone()).unwrap_or(Value::Null)
    }

    pub fn retry_now(&self) {
        self.wake.notify_one();
    }

    fn update(&self, f: impl FnOnce(&mut Status)) {
        let status = {
            let mut s = self.status.lock();
            f(&mut s);
            s.clone()
        };
        let mut payload = serde_json::to_value(status).unwrap_or_default();
        payload["kind"] = json!("connection");
        let _ = self.app.emit_to("main", EVENT, payload);
    }

    async fn run(self: Arc<Self>) {
        let mut attempt: u32 = 0;
        loop {
            self.update(|s| {
                s.state = "connecting";
                s.retry_at = None;
            });
            let failure = match self.connect().await {
                Ok(ws) => {
                    attempt = 0;
                    self.session(ws).await
                }
                Err(f) => Some(f),
            };
            *self.out.lock() = None;
            self.connected.send_replace(false);
            for (_, tx) in self.pending.lock().drain() {
                let _ = tx.send(Err(CONNECTION_LOST.into()));
            }
            attempt = attempt.saturating_add(1);
            let delay = match &failure {
                Some(Failure::Auth) => Duration::from_secs(60),
                _ => Duration::from_secs((1u64 << attempt.min(5)).min(30)),
            };
            let error = match failure {
                Some(Failure::Auth) => Some("Mã truy cập không còn đúng (máy chủ đã đổi mã). Rời máy chủ rồi tham gia lại với mã mới.".to_owned()),
                Some(Failure::Other(e)) => Some(e),
                None => None,
            };
            let retry_at = chrono::Utc::now().timestamp_millis() + delay.as_millis() as i64;
            self.update(|s| {
                s.state = "disconnected";
                s.error = error.or_else(|| Some(CONNECTION_LOST.into()));
                s.retry_at = Some(retry_at);
            });
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.wake.notified() => {}
            }
        }
    }

    async fn connect(&self) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Failure> {
        let mut ws_url = self.base.join("ws").map_err(|e| Failure::Other(e.to_string()))?;
        let scheme = if ws_url.scheme() == "https" { "wss" } else { "ws" };
        let _ = ws_url.set_scheme(scheme);
        let mut request = ws_url.as_str().into_client_request().map_err(|e| Failure::Other(e.to_string()))?;
        let headers = request.headers_mut();
        let auth = format!("Bearer {}", self.join.code);
        let device: String = url::form_urlencoded::byte_serialize(self.join.device_name.as_bytes()).collect();
        for (k, v) in [("authorization", auth), ("x-compola-device", device)] {
            if let Ok(v) = http::HeaderValue::from_str(&v) {
                headers.insert(k, v);
            }
        }
        let connect = tokio_tungstenite::connect_async_with_config(request, Some(super::server::ws_config()), true);
        match tokio::time::timeout(Duration::from_secs(20), connect).await {
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(tungstenite::Error::Http(response))) if response.status() == 401 => Err(Failure::Auth),
            Ok(Err(tungstenite::Error::Http(response))) => Err(Failure::Other(format!("Máy chủ trả lời HTTP {}.", response.status().as_u16()))),
            Ok(Err(tungstenite::Error::Io(e))) => {
                Err(Failure::Other(format!("Không kết nối được tới {}: {e}", self.base.host_str().unwrap_or_default())))
            }
            Ok(Err(e)) => Err(Failure::Other(e.to_string())),
            Err(_) => Err(Failure::Other(format!("{} không phản hồi.", self.base.host_str().unwrap_or_default()))),
        }
    }

    /// Runs until the connection ends; the reason when the server gave one.
    async fn session(&self, ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> Option<Failure> {
        let (mut sink, mut source) = ws.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        *self.out.lock() = Some(out_tx);
        let mut ping = tokio::time::interval(Duration::from_secs(20));
        let mut last_seen = Instant::now();
        loop {
            tokio::select! {
                incoming = source.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        if let Some(reason) = self.handle(text.as_str()) {
                            return Some(Failure::Other(reason));
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return None,
                    Some(Err(e)) => return Some(Failure::Other(format!("{CONNECTION_LOST} ({e})"))),
                    Some(Ok(_)) => last_seen = Instant::now(),
                },
                Some(out) = out_rx.recv() => {
                    if sink.send(Message::text(out)).await.is_err() {
                        return None;
                    }
                }
                _ = ping.tick() => {
                    if last_seen.elapsed() > Duration::from_secs(60) {
                        return Some(Failure::Other("Máy chủ không phản hồi.".into()));
                    }
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        return None;
                    }
                }
            }
        }
    }

    /// One message from the server; Some(reason) when it said goodbye.
    fn handle(&self, text: &str) -> Option<String> {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return None };
        match msg.get("t").and_then(Value::as_str) {
            Some("hello") => {
                let name = msg.pointer("/server/name").and_then(Value::as_str).unwrap_or_default().to_owned();
                self.update(|s| {
                    s.state = "connected";
                    s.error = None;
                    s.ever_connected = true;
                    s.retry_at = None;
                    if !name.is_empty() {
                        s.server_name = name;
                    }
                });
                self.connected.send_replace(true);
            }
            Some("result") => {
                let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                if let Some(tx) = self.pending.lock().remove(&id) {
                    let result = if msg.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(msg.get("value").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(msg.get("error").and_then(Value::as_str).unwrap_or("Lỗi không rõ").to_owned())
                    };
                    let _ = tx.send(result);
                }
            }
            Some("event") => {
                let event = msg.get("event").and_then(Value::as_str).unwrap_or_default();
                let payload = msg.get("payload").cloned().unwrap_or(Value::Null);
                if event == NOTIFICATION_EVENT {
                    self.notify(&payload);
                } else if event.starts_with("compola://") {
                    let _ = self.app.emit_to("main", event, payload);
                }
            }
            Some("bye") => {
                return Some(match msg.get("reason").and_then(Value::as_str) {
                    Some("kicked") => "Máy chủ đã ngắt kết nối thiết bị này.".into(),
                    Some("codeChanged") => "Máy chủ đã đổi mã truy cập.".into(),
                    Some("restarted") => "Compola Server vừa khởi động lại.".into(),
                    Some("lagged") => "Kết nối quá chậm, đang kết nối lại.".into(),
                    _ => CONNECTION_LOST.into(),
                });
            }
            _ => {}
        }
        None
    }

    fn notify(&self, payload: &Value) {
        use base64::Engine as _;
        let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let image = payload.get("image").and_then(Value::as_str).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
        let silent = payload.get("silent").and_then(Value::as_bool).unwrap_or(false);
        crate::notifications::deliver_remote(&self.app, text("title"), text("body"), text("tag"), silent, image);
    }

    pub async fn wait_connected(&self, limit: Option<Duration>) -> Result<(), String> {
        let mut rx = self.connected.subscribe();
        let wait = async {
            rx.wait_for(|c| *c).await.map(|_| ()).map_err(|_| NOT_CONNECTED.to_owned())
        };
        match limit {
            Some(d) => tokio::time::timeout(d, wait).await.map_err(|_| NOT_CONNECTED.to_owned())?,
            None => wait.await,
        }
    }

    pub async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.wait_connected(Some(Duration::from_secs(20))).await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let message = json!({ "t": "invoke", "id": id, "cmd": cmd, "args": args }).to_string();
        let sent = self.out.lock().as_ref().is_some_and(|out| out.send(message).is_ok());
        if !sent {
            self.pending.lock().remove(&id);
            return Err(NOT_CONNECTED.into());
        }
        match tokio::time::timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CONNECTION_LOST.into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err("Compola Server không trả lời kịp.".into())
            }
        }
    }

    // ---- media ----

    /// A `compola-media` request answered by the host.
    pub async fn forward_media(&self, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let url = endpoint(&self.base, &format!("media/load?{}", request.uri().query().unwrap_or_default()));
        let method = if request.method() == http::Method::HEAD { reqwest::Method::HEAD } else { reqwest::Method::GET };
        let mut req = self.http.request(method, url).bearer_auth(&self.join.code).timeout(Duration::from_secs(120));
        if let Some(range) = request.headers().get(http::header::RANGE) {
            req = req.header(reqwest::header::RANGE, range.as_bytes());
        }
        let failure = |status: u16, class: &str| {
            http::Response::builder()
                .status(status)
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Compola-Error", class)
                .body(Vec::new())
                .unwrap_or_default()
        };
        let response = match req.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => return failure(504, "timeout"),
            Err(_) => return failure(502, "offline"),
        };
        let mut builder = http::Response::builder().status(response.status().as_u16());
        for (k, v) in response.headers() {
            let name = k.as_str();
            if !matches!(name, "connection" | "content-length" | "transfer-encoding" | "keep-alive" | "content-encoding") {
                builder = builder.header(name, v.as_bytes());
            }
        }
        match response.bytes().await {
            Ok(body) => builder.body(body.to_vec()).unwrap_or_default(),
            Err(_) => failure(502, "offline"),
        }
    }

    /// Downloads a media URL (CDN or one of the host's `file://` URLs) through the host into `dest`.
    async fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("url", url).append_pair("flavour", "cors").finish();
        let target = endpoint(&self.base, &format!("media/load?{query}"));
        let dir = dest.parent().ok_or("bad destination")?;
        let temp = dir.join(format!(".{}.compola-part", uuid::Uuid::new_v4().simple()));
        let result = async {
            let mut file = tokio::fs::File::create(&temp).await.map_err(|e| e.to_string())?;
            let mut offset: u64 = 0;
            loop {
                let response = self
                    .http
                    .get(&target)
                    .bearer_auth(&self.join.code)
                    .header(reqwest::header::RANGE, format!("bytes={offset}-"))
                    .timeout(Duration::from_secs(300))
                    .send()
                    .await
                    .map_err(|e| describe(&e, &self.base))?;
                let status = response.status().as_u16();
                let content_range = response.headers().get("content-range").and_then(|v| v.to_str().ok()).map(str::to_owned);
                let error_class = response.headers().get("x-compola-error").and_then(|v| v.to_str().ok()).map(str::to_owned);
                match status {
                    200 => {
                        let body = response.bytes().await.map_err(|e| e.to_string())?;
                        if offset > 0 {
                            file.set_len(0).await.map_err(|e| e.to_string())?;
                            file = tokio::fs::File::create(&temp).await.map_err(|e| e.to_string())?;
                        }
                        file.write_all(&body).await.map_err(|e| e.to_string())?;
                        break;
                    }
                    206 => {
                        let body = response.bytes().await.map_err(|e| e.to_string())?;
                        if body.is_empty() {
                            return Err("Tải tệp bị gián đoạn.".to_owned());
                        }
                        file.write_all(&body).await.map_err(|e| e.to_string())?;
                        offset += body.len() as u64;
                        let total = content_range.as_deref().and_then(|r| r.rsplit('/').next()).and_then(|t| t.parse::<u64>().ok());
                        if total.is_some_and(|t| offset >= t) {
                            break;
                        }
                    }
                    416 if offset > 0 => break,
                    _ => return Err(format!("Không tải được tệp (HTTP {status}{}).", error_class.map(|c| format!(", {c}")).unwrap_or_default())),
                }
            }
            file.flush().await.map_err(|e| e.to_string())?;
            tokio::fs::rename(&temp, dest).await.map_err(|e| e.to_string())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        result
    }

    pub async fn media_save(&self, url: &str, dest_path: &str) -> Result<String, String> {
        let dest = PathBuf::from(dest_path);
        if !dest.is_absolute() || dest.file_name().is_none() || !dest.parent().is_some_and(Path::is_dir) {
            return Err("Đường dẫn lưu không hợp lệ.".into());
        }
        self.download(url, &dest).await?;
        Ok(dest_path.to_owned())
    }

    pub async fn media_open_file(&self, url: &str, name: &str) -> Result<Value, String> {
        use sha2::Digest;
        let from_url = url::Url::parse(url).ok().and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_owned)));
        let file_name = super::server::safe_file_name(name)
            .or_else(|| from_url.and_then(|n| super::server::safe_file_name(&n)))
            .unwrap_or_else(|| "tệp".into());
        let key = hex::encode(&sha2::Sha256::digest(url.as_bytes())[..8]);
        let dir = std::env::temp_dir().join("Compola").join("remote-downloads").join(key);
        let file = dir.join(&file_name);
        if !file.is_file() {
            tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
            self.download(url, &file).await?;
        }
        let check = file.clone();
        let display = name.to_owned();
        let revealed = tokio::task::spawn_blocking(move || crate::media::open::may_execute(&check, &display)).await.map_err(|e| e.to_string())?;
        if revealed {
            tauri_plugin_opener::reveal_item_in_dir(&file).map_err(|e| e.to_string())?;
        } else {
            tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|e| e.to_string())?;
        }
        Ok(json!({ "path": file.to_string_lossy(), "revealed": revealed }))
    }

    // ---- files to send ----

    /// Uploads a local file in chunks → the host's reference to it (`<id>/<name>`).
    async fn upload(&self, path: &Path) -> Result<String, String> {
        use tokio::io::AsyncReadExt;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let name = super::server::safe_file_name(&name).unwrap_or_else(|| "tệp".into());
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut file = tokio::fs::File::open(path).await.map_err(|e| format!("Không đọc được {name}: {e}"))?;
        let mut offset: u64 = 0;
        let mut reference = None;
        loop {
            let mut chunk = Vec::with_capacity(CHUNK);
            (&mut file).take(CHUNK as u64).read_to_end(&mut chunk).await.map_err(|e| format!("Không đọc được {name}: {e}"))?;
            if chunk.is_empty() && reference.is_some() {
                break;
            }
            let len = chunk.len() as u64;
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("id", &id)
                .append_pair("name", &name)
                .append_pair("offset", &offset.to_string())
                .finish();
            let response = self
                .http
                .post(endpoint(&self.base, &format!("upload?{query}")))
                .bearer_auth(&self.join.code)
                .body(chunk)
                .timeout(Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| describe(&e, &self.base))?;
            let status = response.status().as_u16();
            let body: Value = response.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            if status != 200 {
                let reason = body.get("error").and_then(Value::as_str).unwrap_or_default();
                return Err(format!("Không gửi được {name} lên máy chủ (HTTP {status}) {reason}").trim().to_owned());
            }
            reference = body.get("path").and_then(Value::as_str).map(str::to_owned);
            offset += len;
            if len < CHUNK as u64 {
                break;
            }
        }
        reference.ok_or_else(|| "Máy chủ không nhận tệp.".into())
    }

    pub async fn call_with_files(
        &self,
        target: String,
        method: String,
        args: Vec<Value>,
        files: Option<Vec<String>>,
        pick: Option<String>,
    ) -> Result<Value, String> {
        let paths = match files {
            Some(f) => f,
            None => match crate::engine::pick_files(&self.app, pick.as_deref()).await {
                Some(p) => p,
                None => return Ok(Value::Null),
            },
        };
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        let mut references = Vec::with_capacity(paths.len());
        for p in &paths {
            references.push(self.upload(Path::new(p)).await?);
        }
        self.invoke("engine_call_with_files", json!({ "target": target, "method": method, "args": args, "files": references })).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_normalized_to_a_base_url() {
        let n = |s: &str| normalize_url(s).map(|u| u.to_string());
        assert_eq!(n("192.168.1.5").unwrap(), "http://192.168.1.5:39218/");
        assert_eq!(n(" 192.168.1.5:4000 ").unwrap(), "http://192.168.1.5:4000/");
        assert_eq!(n("mac-mini.tail1234.ts.net").unwrap(), "http://mac-mini.tail1234.ts.net:39218/");
        assert_eq!(n("https://compola.example.com").unwrap(), "https://compola.example.com/");
        assert_eq!(n("wss://compola.example.com/zalo/ws").unwrap(), "https://compola.example.com/zalo/");
        assert_eq!(n("http://10.0.0.2:39218/?x=1#y").unwrap(), "http://10.0.0.2:39218/");
        assert!(n("").is_err());
        assert!(n("ftp://x").is_err());
    }
}
