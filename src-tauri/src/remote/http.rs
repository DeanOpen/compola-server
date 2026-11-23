//! Just enough HTTP/1.1 for the Compola Server: request heads, `Content-Length` bodies, keep-alive, plain responses.

use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_HEAD: usize = 32 * 1024;

pub struct Head {
    pub method: String,
    /// Path and query as sent (`/media/load?url=…`).
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub http10: bool,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn path(&self) -> &str {
        self.target.split_once('?').map_or(self.target.as_str(), |(p, _)| p)
    }

    pub fn query(&self) -> &str {
        self.target.split_once('?').map_or("", |(_, q)| q)
    }

    pub fn param(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.query().as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    }

    /// `Content-Length` (0 when absent); Err for bodies this server does not read (chunked).
    pub fn content_length(&self) -> Result<u64, ()> {
        if self.header("transfer-encoding").is_some_and(|v| !v.eq_ignore_ascii_case("identity")) {
            return Err(());
        }
        match self.header("content-length") {
            Some(v) => v.trim().parse().map_err(|_| ()),
            None => Ok(0),
        }
    }

    pub fn wants_close(&self) -> bool {
        match self.header("connection") {
            Some(v) => v.split(',').any(|t| t.trim().eq_ignore_ascii_case("close")),
            None => self.http10,
        }
    }

    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
            && self.header("connection").is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
    }

    /// The bearer token of `Authorization`.
    pub fn bearer(&self) -> Option<&str> {
        let v = self.header("authorization")?;
        let (scheme, token) = v.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
    }
}

pub struct Conn {
    stream: TcpStream,
    /// Bytes read past the last head (the start of a body or of the next request).
    buf: Vec<u8>,
}

impl Conn {
    pub fn new(stream: TcpStream) -> Self {
        Self { stream, buf: Vec::new() }
    }

    /// The socket, for a WebSocket upgrade (a client sends nothing more before the `101`).
    pub fn into_stream(self) -> TcpStream {
        self.stream
    }

    /// The next request head; None when the peer closed the connection between requests.
    pub async fn read_head(&mut self) -> std::io::Result<Option<Head>> {
        let mut chunk = [0u8; 8192];
        let end = loop {
            if let Some(i) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            if self.buf.len() > MAX_HEAD {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "headers too large"));
            }
            let n = self.stream.read(&mut chunk).await?;
            if n == 0 {
                return if self.buf.is_empty() { Ok(None) } else { Err(std::io::ErrorKind::UnexpectedEof.into()) };
            }
            self.buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&self.buf[..end]).into_owned();
        self.buf.drain(..end + 4);
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or_default().split_whitespace();
        let method = first.next().unwrap_or_default().to_owned();
        let target = first.next().unwrap_or_default().to_owned();
        let http10 = first.next() == Some("HTTP/1.0");
        let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())).collect();
        Ok(Some(Head { method, target, headers, http10 }))
    }

    /// Copies the next `len` body bytes into `sink`.
    pub async fn read_body_into<W: AsyncWrite + Unpin>(&mut self, mut len: u64, sink: &mut W) -> std::io::Result<()> {
        let take = (self.buf.len() as u64).min(len) as usize;
        if take > 0 {
            sink.write_all(&self.buf[..take]).await?;
            self.buf.drain(..take);
            len -= take as u64;
        }
        let mut chunk = vec![0u8; 64 * 1024];
        while len > 0 {
            let want = (chunk.len() as u64).min(len) as usize;
            let n = self.stream.read(&mut chunk[..want]).await?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            sink.write_all(&chunk[..n]).await?;
            len -= n as u64;
        }
        Ok(())
    }

    pub async fn skip_body(&mut self, len: u64) -> std::io::Result<()> {
        self.read_body_into(len, &mut tokio::io::sink()).await
    }

    pub async fn write_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(bytes).await?;
        self.stream.flush().await
    }

    /// Writes a response; `Content-Length` and `Connection` are added here.
    pub async fn respond(&mut self, status: u16, headers: &[(String, String)], body: &[u8], head_only: bool, close: bool) -> std::io::Result<()> {
        let reason = http::StatusCode::from_u16(status).ok().and_then(|s| s.canonical_reason()).unwrap_or("Status");
        let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("connection") || k.eq_ignore_ascii_case("transfer-encoding") {
                continue;
            }
            if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
                continue;
            }
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str(&format!("Content-Length: {}\r\nConnection: {}\r\n\r\n", body.len(), if close { "close" } else { "keep-alive" }));
        self.stream.write_all(out.as_bytes()).await?;
        if !head_only {
            self.stream.write_all(body).await?;
        }
        self.stream.flush().await
    }

    pub async fn respond_json(&mut self, status: u16, body: &serde_json::Value, close: bool) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        self.respond(status, &[("Content-Type".into(), "application/json".into()), ("Cache-Control".into(), "no-store".into())], &bytes, false, close)
            .await
    }
}
