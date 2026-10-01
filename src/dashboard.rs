//! Loopback-only dashboard. GitHub remains the task store; only a live view is held in memory.
//! No agent launching, command execution endpoint, or filesystem serving.

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Config;
use crate::github::GitHub;
use crate::process::{Cmd, Runner};
use crate::tmux::Tmux;
use crate::workspace::Workspace;
use crate::{Error, Result, ensure, workstreams};

const INDEX: &str = include_str!("../dashboard/index.html");
const APP: &str = include_str!("../dashboard/app.js");
const STYLE: &str = include_str!("../dashboard/style.css");
const MAX_BODY: usize = 4096;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 8;
const READ_BUDGET: Duration = Duration::from_secs(2);
const WRITE_BUDGET: Duration = Duration::from_secs(5);
const SNAPSHOT_BUDGET: Duration = Duration::from_secs(90);
const MAX_QUEUE_WAIT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// One aggregate subprocess budget, rather than a fresh timeout for each GitHub request.
/// This adapter also works with non-Send runners such as the RefCell-backed test fixtures.
pub struct DeadlineRunner<'a> {
    runner: &'a dyn Runner,
    deadline: Instant,
}

impl<'a> DeadlineRunner<'a> {
    pub fn new(runner: &'a dyn Runner, budget: Duration) -> Self {
        Self { runner, deadline: Instant::now() + budget }
    }

    fn remaining(&self) -> Result<Duration> {
        self.deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()).ok_or_else(|| {
            Error::msg(
                "Dashboard snapshot timed out. Retry Refresh; check GitHub connectivity or reduce the Project size.",
            )
        })
    }
}

impl Runner for DeadlineRunner<'_> {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        let mut bounded = cmd.clone();
        bounded.timeout = bounded.timeout.min(self.remaining()?);
        let result = self.runner.run(&bounded);
        // Do not accept a late success or return an opaque last-command timeout as the snapshot.
        self.remaining()?;
        result
    }
}

/// Narrow server port, also used by HTTP tests without GitHub or tmux side effects.
pub trait Backend {
    fn snapshot(&mut self) -> Result<Value>;
    fn focus(&mut self, issue: u64, pane: &str) -> Result<()>;
}

struct Live<'a> {
    config: &'a Config,
    runner: &'a dyn Runner,
    session: Option<&'a str>,
    visible: HashSet<u64>,
}

impl Backend for Live<'_> {
    fn snapshot(&mut self) -> Result<Value> {
        // A new adapter on each refresh avoids retaining stale GitHub metadata. All subprocesses
        // share one budget, leaving time to report a 502 before the browser's 120-second timeout.
        let runner = DeadlineRunner::new(self.runner, SNAPSHOT_BUDGET);
        let github = GitHub::new(&self.config.repo, &self.config.project_url, &self.config.owner, &runner)?;
        let workspace = Workspace::new(self.config, &runner);
        let snapshot = workstreams::snapshot(self.config, &github, &workspace)?;
        let mut value = serde_json::to_value(&snapshot).map_err(|e| Error::msg(e.to_string()))?;
        // One tmux call for the whole view. Missing tmux must not hide the graph.
        let panes = Tmux::new(&runner, self.session).snapshot();
        runner.remaining()?; // An expired snapshot is an error, not an optional tmux warning.
        for (task, view) in snapshot.tasks.iter().zip(value["tasks"].as_array_mut().expect("serialized tasks")) {
            let matches = panes
                .as_ref()
                .map(|panes| panes.panes(&self.config.repo, task.entry.worktree.as_deref(), task.entry.number))
                .unwrap_or_default();
            view["panes"] = serde_json::to_value(matches).map_err(|e| Error::msg(e.to_string()))?;
        }
        if let Err(error) = panes {
            value["tmux_warning"] = Value::String(error.to_string());
        }
        runner.remaining()?;
        self.visible = snapshot.tasks.iter().map(|task| task.entry.number).collect();
        Ok(value)
    }

    fn focus(&mut self, issue: u64, pane: &str) -> Result<()> {
        ensure!(self.visible.contains(&issue), "Task is not in the loaded Project. Refresh the dashboard first.");
        let workspace = Workspace::new(self.config, self.runner);
        let worktrees = workspace.worktrees()?;
        let path = worktrees.get(&self.config.branch(issue)).map(String::as_str);
        // Discover and validate again on every click; never trust a browser's pane-to-task mapping.
        Tmux::new(self.runner, self.session).focus(&self.config.repo, path, issue, pane)
    }
}

/// Start an HTTP server bound strictly to IPv4 loopback. Port zero asks the OS for a free port.
pub fn serve(
    config: &Config,
    runner: &dyn Runner,
    port: u16,
    session: Option<&str>,
    out: &mut dyn Write,
) -> Result<()> {
    let server = HttpServer::bind(port)?;
    let authority = server.local_addr()?;
    writeln!(out, "Dashboard: http://{authority}/")?;
    writeln!(out, "Repository: {} · Project: {}", config.repo, config.project_url)?;
    writeln!(out, "Local access only. Press Ctrl-C to stop.")?;
    out.flush()?;
    let mut backend = Live { config, runner, session, visible: HashSet::new() };
    server.run(&mut backend, &AtomicBool::new(false))
}

/// HTTP routing is separate from the live adapters so security checks are testable in isolation.
pub struct Router {
    authority: String,
    origin: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Focus {
    issue: u64,
    pane: String,
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
}

impl Reply {
    fn json(status: u16, value: Value) -> Self {
        Self { status, content_type: "application/json; charset=utf-8", body: value.to_string() }
    }

    fn error(status: u16, message: impl ToString) -> Self {
        Self::json(status, json!({"error": message.to_string()}))
    }

    fn asset(content_type: &'static str, body: impl Into<String>) -> Self {
        Self { status: 200, content_type, body: body.into() }
    }
}

impl Router {
    pub fn new(authority: &str) -> Self {
        Self { authority: authority.into(), origin: format!("http://{authority}"), token: Uuid::new_v4().to_string() }
    }

    /// Reject foreign hosts (DNS rebinding), foreign origins and unauthenticated API requests.
    /// Do not enable CORS: a website must not be able to read private tasks or select a local pane.
    pub fn route(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
        backend: &mut dyn Backend,
    ) -> Reply {
        if let Some(error) = self.authorize(url, headers) {
            return error;
        }
        if body.len() > MAX_BODY {
            return Reply::error(413, "Request body is too large.");
        }
        if let Some(reply) = self.asset(method, url) {
            return reply;
        }
        match (method, url.split('?').next().unwrap_or(url)) {
            ("GET", "/api/snapshot") => match backend.snapshot() {
                Ok(snapshot) => Reply::json(200, snapshot),
                Err(error) => Reply::error(502, error),
            },
            ("POST", "/api/focus") => {
                if header(headers, "content-type").and_then(|v| v.split(';').next()) != Some("application/json") {
                    return Reply::error(415, "Expected application/json.");
                }
                let focus: Focus = match serde_json::from_slice(body) {
                    Ok(focus) => focus,
                    Err(_) => return Reply::error(400, "Expected an issue number and pane ID."),
                };
                if focus.issue == 0 || !valid_pane_id(&focus.pane) {
                    return Reply::error(400, "Invalid issue number or pane ID.");
                }
                match backend.focus(focus.issue, &focus.pane) {
                    Ok(()) => Reply::json(200, json!({"message":"Agent pane selected in tmux."})),
                    Err(error) => Reply::error(409, error),
                }
            }
            (_, "/api/focus" | "/api/snapshot") => Reply::error(405, "Method not allowed."),
            _ => Reply::error(404, "Not found."),
        }
    }

    fn authorize(&self, url: &str, headers: &[(String, String)]) -> Option<Reply> {
        if header(headers, "host") != Some(self.authority.as_str()) {
            return Some(Reply::error(403, "Unexpected Host. Open the printed loopback URL."));
        }
        if headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("origin") && value != &self.origin) {
            return Some(Reply::error(403, "Cross-origin requests are not allowed."));
        }
        if url.split('?').next().unwrap_or(url).starts_with("/api/")
            && header(headers, "x-gho-token") != Some(self.token.as_str())
        {
            return Some(Reply::error(403, "Dashboard session expired. Reload this page."));
        }
        None
    }

    fn asset(&self, method: &str, url: &str) -> Option<Reply> {
        match (method, url.split('?').next().unwrap_or(url)) {
            ("GET", "/") => Some(Reply::asset("text/html; charset=utf-8", INDEX.replace("__GHO_TOKEN__", &self.token))),
            ("GET", "/app.js") => Some(Reply::asset("text/javascript; charset=utf-8", APP)),
            ("GET", "/style.css") => Some(Reply::asset("text/css; charset=utf-8", STYLE)),
            _ => None,
        }
    }
}

/// Bounded HTTP/1 transport. Parsing/static responses run in at most eight workers; the backend
/// stays on the calling thread and needs neither Send nor Sync. A separate bounded queue holds
/// complete requests only. Slow or oversized clients never require draining their unread bodies.
pub struct HttpServer {
    listener: TcpListener,
    router: Router,
}

struct Request {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Pending {
    stream: TcpStream,
    request: Request,
    queued: Instant,
}

struct ConnectionSlot(Arc<AtomicUsize>);

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct StopOnDrop<'a>(&'a AtomicBool);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl HttpServer {
    pub fn bind(port: u16) -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .map_err(|error| Error::msg(format!("Cannot start dashboard: {error}")))?;
        listener.set_nonblocking(true)?;
        let router = Router::new(&listener.local_addr()?.to_string());
        Ok(Self { listener, router })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Serve until `stop` is set. The stop flag also gives socket tests a clean shutdown without
    /// a public shutdown endpoint. Production uses the process's normal Ctrl-C handling.
    pub fn run(&self, backend: &mut dyn Backend, stop: &AtomicBool) -> Result<()> {
        let stopping = AtomicBool::new(false);
        thread::scope(|scope| {
            let shutdown = StopOnDrop(&stopping);
            let stopping = &stopping;
            let (sender, receiver) = mpsc::sync_channel::<Pending>(MAX_CONNECTIONS);
            let acceptor = scope.spawn(move || -> io::Result<()> {
                let active = Arc::new(AtomicUsize::new(0));
                while !stop.load(Ordering::Relaxed) && !stopping.load(Ordering::Relaxed) {
                    let (mut stream, _) = match self.listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(POLL_INTERVAL);
                            continue;
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(error),
                    };
                    // Accepted sockets must be blocking for the per-operation deadlines on every OS.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    // Do not spawn unbounded threads or block the acceptor writing an overload
                    // response. Excess connections are closed; capacity recovers within the budget.
                    if active.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                        continue;
                    }
                    let deadline = Instant::now() + READ_BUDGET;
                    active.fetch_add(1, Ordering::Relaxed);
                    let slot = ConnectionSlot(Arc::clone(&active));
                    let sender = sender.clone();
                    scope.spawn(move || {
                        let _slot = slot;
                        let request = match read_request(&mut stream, &self.router, deadline) {
                            Ok(request) => request,
                            Err(reply) => {
                                let _ = write_reply(&mut stream, reply);
                                return;
                            }
                        };
                        if let Some(reply) = self.router.asset(&request.method, &request.url) {
                            let _ = write_reply(&mut stream, reply);
                            return;
                        }
                        let pending = Pending { stream, request, queued: Instant::now() };
                        if let Err(error) = sender.try_send(pending) {
                            let mut pending = match error {
                                mpsc::TrySendError::Full(pending) | mpsc::TrySendError::Disconnected(pending) => {
                                    pending
                                }
                            };
                            let _ = write_reply(&mut pending.stream, busy());
                        }
                    });
                }
                Ok(())
            });
            while !stop.load(Ordering::Relaxed) {
                let mut pending = match receiver.recv_timeout(POLL_INTERVAL) {
                    Ok(pending) => pending,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                // Do not start another 90-second snapshot for a tab that already spent most of
                // its browser deadline waiting behind a previous refresh.
                let reply = if pending.queued.elapsed() > MAX_QUEUE_WAIT {
                    busy()
                } else {
                    let request = pending.request;
                    self.router.route(&request.method, &request.url, &request.headers, &request.body, backend)
                };
                // A disconnected or slow reader must not stop the dashboard or hold it forever.
                let _ = write_reply(&mut pending.stream, reply);
            }
            drop(shutdown);
            acceptor.join().map_err(|_| Error::msg("Dashboard listener stopped unexpectedly."))??;
            Ok(())
        })
    }
}

fn busy() -> Reply {
    Reply::error(503, "Dashboard is busy. Wait for the current refresh, then retry.")
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let mut values = headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str());
    let first = values.next();
    if values.next().is_some() { None } else { first }
}

fn read_request(stream: &mut TcpStream, router: &Router, deadline: Instant) -> std::result::Result<Request, Reply> {
    let mut bytes = [0; MAX_HEADER_BYTES];
    let mut used = 0;
    let (method, url, headers, body_start) = loop {
        let mut raw_headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut request = httparse::Request::new(&mut raw_headers);
        match request.parse(&bytes[..used]) {
            Ok(httparse::Status::Complete(body_start)) => {
                let headers = request
                    .headers
                    .iter()
                    .map(|field| {
                        let value = std::str::from_utf8(field.value)
                            .map_err(|_| Reply::error(400, "Invalid HTTP header value."))?;
                        Ok((field.name.to_owned(), value.to_owned()))
                    })
                    .collect::<std::result::Result<Vec<_>, Reply>>()?;
                break (request.method.unwrap().to_owned(), request.path.unwrap().to_owned(), headers, body_start);
            }
            Ok(httparse::Status::Partial) if used < bytes.len() => {
                used += read_before(stream, &mut bytes[used..], deadline)?;
            }
            Ok(httparse::Status::Partial) | Err(httparse::Error::TooManyHeaders) => {
                return Err(Reply::error(431, "Request headers are too large."));
            }
            Err(_) => return Err(Reply::error(400, "Malformed HTTP request.")),
        }
    };
    // Authenticate after bounded header parsing, before reading or allocating the declared body.
    // A rejected request is closed immediately, never drained by a reader destructor.
    if let Some(error) = router.authorize(&url, &headers) {
        return Err(error);
    }
    if headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("transfer-encoding")) {
        return Err(Reply::error(400, "Transfer-Encoding is not supported; send Content-Length."));
    }
    if headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("expect")) {
        return Err(Reply::error(417, "Expect is not supported."));
    }
    if headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case("content-length")).count() > 1 {
        return Err(Reply::error(400, "Duplicate Content-Length."));
    }
    let length = match header(&headers, "content-length") {
        Some(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => value
            .parse::<usize>()
            .ok()
            .filter(|length| *length <= MAX_BODY)
            .ok_or_else(|| Reply::error(413, "Request body is too large."))?,
        Some(_) => return Err(Reply::error(400, "Invalid Content-Length.")),
        None if method == "POST" => return Err(Reply::error(411, "Content-Length is required.")),
        None => 0,
    };
    if method != "POST" && length != 0 {
        return Err(Reply::error(400, "A request body is only supported for POST."));
    }
    if method == "POST"
        && url.split('?').next() == Some("/api/focus")
        && header(&headers, "content-type").and_then(|value| value.split(';').next()) != Some("application/json")
    {
        return Err(Reply::error(415, "Expected application/json."));
    }
    let mut body = vec![0; length];
    let buffered = (used - body_start).min(length);
    body[..buffered].copy_from_slice(&bytes[body_start..body_start + buffered]);
    let mut used = buffered;
    while used < length {
        used += read_before(stream, &mut body[used..], deadline)?;
    }
    if Instant::now() >= deadline {
        return Err(Reply::error(408, "Request timed out; retry with a complete request."));
    }
    Ok(Request { method, url, headers, body })
}

fn read_before(stream: &mut TcpStream, bytes: &mut [u8], deadline: Instant) -> std::result::Result<usize, Reply> {
    let mut read = || -> io::Result<usize> {
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
            stream.set_read_timeout(Some(left))?;
            match stream.read(bytes) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    };
    match read() {
        Ok(0) => Err(Reply::error(400, "Incomplete HTTP request.")),
        Ok(count) => Ok(count),
        Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => {
            Err(Reply::error(408, "Request timed out; retry with a complete request."))
        }
        Err(_) => Err(Reply::error(400, "Cannot read HTTP request.")),
    }
}

fn write_reply(stream: &mut TcpStream, reply: Reply) -> io::Result<()> {
    let deadline = Instant::now() + WRITE_BUDGET;
    let reason = match reply.status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        417 => "Expectation Failed",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\
         X-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; \
         frame-ancestors 'none'; form-action 'none'\r\n\r\n",
        reply.status,
        reply.content_type,
        reply.body.len()
    );
    for mut bytes in [head.as_bytes(), reply.body.as_bytes()] {
        while !bytes.is_empty() {
            let left = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
            stream.set_write_timeout(Some(left))?;
            match stream.write(bytes) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => bytes = &bytes[count..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

fn valid_pane_id(pane: &str) -> bool {
    pane.strip_prefix('%').is_some_and(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
}
