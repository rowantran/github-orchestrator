use std::cell::RefCell;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use github_orchestrator::dashboard::{Backend, DeadlineRunner, HttpServer, Router};
use github_orchestrator::process::{Cmd, Runner};
use github_orchestrator::tailscale::Plan;
use github_orchestrator::{Error, Result};
use serde_json::{Value, json};

#[derive(Default)]
struct Fake {
    reads: usize,
    focuses: Vec<(u64, String)>,
    fail: bool,
}

impl Backend for Fake {
    fn snapshot(&mut self) -> Result<Value> {
        self.reads += 1;
        if self.fail {
            return Err(Error::msg("GitHub unavailable; retry refresh."));
        }
        Ok(json!({"repo":"example/repo", "workstreams":[], "tasks":[]}))
    }

    fn focus(&mut self, issue: u64, pane: &str) -> Result<()> {
        if self.fail {
            return Err(Error::msg("Pane disappeared. Refresh the dashboard."));
        }
        self.focuses.push((issue, pane.into()));
        Ok(())
    }
}

fn headers(router: &Router) -> Vec<(String, String)> {
    headers_for(router, "127.0.0.1:8123")
}

fn headers_for(router: &Router, authority: &str) -> Vec<(String, String)> {
    let host = vec![("Host".into(), authority.into())];
    let index = router.route("GET", "/", &host, b"", &mut Fake::default());
    assert_eq!(index.status, 200);
    assert!(!index.body.contains("__GHO_TOKEN__"));
    let marker = "name=\"gho-token\" content=\"";
    let token = index.body.split(marker).nth(1).expect("token meta tag").split('"').next().unwrap();
    vec![
        ("Host".into(), authority.into()),
        ("Content-Type".into(), "application/json".into()),
        ("X-GHO-Token".into(), token.into()),
        ("Origin".into(), format!("http://{authority}")),
    ]
}

#[test]
fn static_assets_and_snapshot_are_served_but_filesystem_paths_are_not() {
    let router = Router::new("127.0.0.1:8123");
    let headers = headers(&router);
    let mut fake = Fake::default();
    for path in ["/", "/?workstream=project-a", "/app.js", "/style.css"] {
        assert_eq!(router.route("GET", path, &headers, b"", &mut fake).status, 200, "{path}");
    }
    for path in ["/../Cargo.toml", "/src/config.rs", "/%2e%2e/config.toml"] {
        assert_eq!(router.route("GET", path, &headers, b"", &mut fake).status, 404);
    }
    let reply = router.route("GET", "/api/snapshot", &headers, b"", &mut fake);
    assert_eq!(reply.status, 200);
    assert_eq!(serde_json::from_str::<Value>(&reply.body).unwrap()["repo"], "example/repo");
    assert_eq!(fake.reads, 1);
}

#[test]
fn foreign_hosts_origins_missing_and_duplicate_tokens_cannot_read_or_focus() {
    let router = Router::new("127.0.0.1:8123");
    let valid = headers(&router);
    let mut invalid = Vec::new();
    for (header, value) in [
        ("Host", "attacker.example:8123"),
        ("Origin", "https://evil.example"),
        ("Origin", "null"),
        ("X-GHO-Token", "bad"),
    ] {
        let mut altered = valid.clone();
        altered.iter_mut().find(|(key, _)| key == header).unwrap().1 = value.into();
        invalid.push(altered);
    }
    for header in ["Host", "X-GHO-Token"] {
        invalid.push(valid.iter().filter(|(key, _)| key != header).cloned().collect());
        let mut duplicate = valid.clone();
        duplicate.push(valid.iter().find(|(key, _)| key == header).unwrap().clone());
        invalid.push(duplicate);
    }
    let mut fake = Fake::default();
    for headers in invalid {
        for (method, path, body) in [("GET", "/api/snapshot", ""), ("POST", "/api/focus", r#"{"issue":1,"pane":"%1"}"#)]
        {
            assert_eq!(router.route(method, path, &headers, body.as_bytes(), &mut fake).status, 403, "{headers:?}");
        }
    }
    assert_eq!(fake.reads, 0);
    assert!(fake.focuses.is_empty());
}

struct TailscaleStatus;

impl Runner for TailscaleStatus {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        match cmd.argv.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["tailscale", "status", "--json", "--peers=false"] => Ok(json!({
                "BackendState":"Running",
                "Self":{"DNSName":"rowan-v2-dev.example.ts.net."},
                "CurrentTailnet":{"MagicDNSSuffix":"example.ts.net", "MagicDNSEnabled":true}
            })
            .to_string()),
            ["tailscale", "serve", "status", "--json"] => Ok("{}".into()),
            _ => panic!("Unexpected command; no real Tailscale calls are allowed: {:?}", cmd.argv),
        }
    }
}

fn tailscale_router(port: u16) -> Router {
    let plan = Plan::prepare(&TailscaleStatus, port).unwrap();
    Router::with_tailscale("127.0.0.1:8123", &plan)
}

fn assert_access_denied(router: &Router, headers: &[(String, String)]) {
    let mut fake = Fake::default();
    for (method, path, body) in [
        ("GET", "/", ""),
        ("GET", "/app.js", ""),
        ("GET", "/style.css", ""),
        ("GET", "/api/snapshot", ""),
        ("POST", "/api/focus", r#"{"issue":42,"pane":"%9"}"#),
    ] {
        assert_eq!(
            router.route(method, path, headers, body.as_bytes(), &mut fake).status,
            403,
            "{method} {path}: {headers:?}"
        );
    }
    assert_eq!(fake.reads, 0);
    assert!(fake.focuses.is_empty());
}

#[test]
fn tailscale_allows_only_configured_short_and_fqdn_authorities_and_keeps_loopback_access() {
    for (port, suffix) in [(0, ":8080"), (80, ""), (8080, ":8080"), (9080, ":9080")] {
        let router = tailscale_router(port);
        for authority in [
            "127.0.0.1:8123".to_string(),
            format!("rowan-v2-dev{suffix}"),
            format!("rowan-v2-dev.example.ts.net{suffix}"),
        ] {
            let headers = headers_for(&router, &authority);
            let mut fake = Fake::default();
            for path in ["/", "/?workstream=project-a", "/app.js", "/style.css"] {
                assert_eq!(router.route("GET", path, &headers, b"", &mut fake).status, 200, "{authority} {path}");
            }
            let snapshot = router.route("GET", "/api/snapshot", &headers, b"", &mut fake);
            assert_eq!(snapshot.status, 200, "{authority}");
            assert_eq!(serde_json::from_str::<Value>(&snapshot.body).unwrap()["repo"], "example/repo");
            assert_eq!(
                router.route("POST", "/api/focus", &headers, br#"{"issue":42,"pane":"%9"}"#, &mut fake).status,
                200,
                "{authority}"
            );
            assert_eq!(fake.reads, 1);
            assert_eq!(fake.focuses, [(42, "%9".into())]);
            // The additional authorities do not create a CORS preflight endpoint.
            assert_eq!(router.route("OPTIONS", "/api/focus", &headers, b"", &mut fake).status, 405);
        }
    }
}

#[test]
fn tailscale_rejects_foreign_missing_and_duplicate_hosts_and_foreign_or_duplicate_origins() {
    let router = tailscale_router(8080);
    let valid = headers_for(&router, "rowan-v2-dev.example.ts.net:8080");
    for (header, value) in [
        ("Host", "attacker.example:8080"),
        ("Host", "other.example.ts.net:8080"),
        ("Host", "child.rowan-v2-dev.example.ts.net:8080"),
        ("Host", "rowan-v2-dev.example.ts.net.attacker.example:8080"),
        ("Host", "rowan-v2-dev:8081"),
        ("Host", "rowan-v2-dev.example.ts.net:8123"),
        ("Host", "rowan-v2-dev"),
        ("Host", "*.example.ts.net:8080"),
        ("Origin", "http://attacker.example:8080"),
        ("Origin", "http://other.example.ts.net:8080"),
        ("Origin", "http://child.rowan-v2-dev.example.ts.net:8080"),
        ("Origin", "http://rowan-v2-dev.example.ts.net.attacker.example:8080"),
        ("Origin", "http://rowan-v2-dev:8081"),
        ("Origin", "https://rowan-v2-dev.example.ts.net:8080"),
        ("Origin", "http://rowan-v2-dev.example.ts.net:8080/path"),
        ("Origin", "null"),
        ("Origin", "*"),
    ] {
        let mut altered = valid.clone();
        altered.iter_mut().find(|(key, _)| key == header).unwrap().1 = value.into();
        assert_access_denied(&router, &altered);
    }
    let missing_host: Vec<_> = valid.iter().filter(|(key, _)| key != "Host").cloned().collect();
    assert_access_denied(&router, &missing_host);
    for header in ["Host", "Origin"] {
        for value in [
            valid.iter().find(|(key, _)| key == header).unwrap().1.clone(),
            if header == "Host" { "rowan-v2-dev:8080" } else { "http://rowan-v2-dev:8080" }.into(),
        ] {
            let mut duplicate = valid.clone();
            // Header names are case-insensitive, even when both values would be allowed alone.
            duplicate.push((header.to_ascii_lowercase(), value));
            assert_access_denied(&router, &duplicate);
        }
    }
}

#[test]
fn tailscale_api_still_requires_one_valid_process_token() {
    let router = tailscale_router(8080);
    let other = tailscale_router(8080);
    let mut fake = Fake::default();
    for authority in ["rowan-v2-dev:8080", "rowan-v2-dev.example.ts.net:8080"] {
        let valid = headers_for(&router, authority);
        let mut wrong = valid.clone();
        wrong.iter_mut().find(|(key, _)| key == "X-GHO-Token").unwrap().1 = "bad".into();
        let missing = valid.iter().filter(|(key, _)| key != "X-GHO-Token").cloned().collect();
        let mut duplicate = valid.clone();
        let token = valid.iter().find(|(key, _)| key == "X-GHO-Token").unwrap().1.clone();
        duplicate.push(("x-gho-token".into(), token));
        for headers in [wrong, missing, duplicate, headers_for(&other, authority)] {
            for (method, path, body) in
                [("GET", "/api/snapshot", ""), ("POST", "/api/focus", r#"{"issue":42,"pane":"%9"}"#)]
            {
                assert_eq!(router.route(method, path, &headers, body.as_bytes(), &mut fake).status, 403);
            }
        }
    }
    assert_eq!(fake.reads, 0);
    assert!(fake.focuses.is_empty());
}

#[test]
fn forwarded_headers_never_allow_foreign_or_missing_hosts_and_local_mode_rejects_tailscale() {
    for router in [Router::new("127.0.0.1:8123"), tailscale_router(8080)] {
        let valid = headers(&router);
        for authority in ["127.0.0.1:8123", "rowan-v2-dev:8080", "rowan-v2-dev.example.ts.net:8080"] {
            for foreign in [Some("attacker.example:8080"), None] {
                for forwarded in [
                    vec![("Forwarded".into(), format!("for=100.64.0.1;host=\"{authority}\";proto=http"))],
                    vec![("X-Forwarded-Host".into(), authority.into())],
                    vec![
                        ("Forwarded".into(), format!("host=\"{authority}\";proto=http")),
                        ("X-Forwarded-Host".into(), authority.into()),
                        ("X-Forwarded-Proto".into(), "http".into()),
                    ],
                ] {
                    let mut altered: Vec<_> = valid.iter().filter(|(key, _)| key != "Host").cloned().collect();
                    if let Some(host) = foreign {
                        altered.push(("Host".into(), host.into()));
                    }
                    altered.extend(forwarded);
                    assert_access_denied(&router, &altered);
                }
            }
        }
    }
    let local = Router::new("127.0.0.1:8123");
    for authority in ["rowan-v2-dev:8080", "rowan-v2-dev.example.ts.net:8080"] {
        for header in ["Host", "Origin"] {
            let mut altered = headers(&local);
            altered.iter_mut().find(|(key, _)| key == header).unwrap().1 =
                if header == "Host" { authority.into() } else { format!("http://{authority}") };
            assert_access_denied(&local, &altered);
        }
    }
}

#[test]
fn focus_requires_post_json_and_valid_fixed_shape_not_shell_commands() {
    let router = Router::new("127.0.0.1:8123");
    let headers = headers(&router);
    let mut fake = Fake::default();
    for body in [
        r#"{"issue":0,"pane":"%1"}"#,
        r#"{"issue":1,"pane":"1; touch /tmp/pwn"}"#,
        r#"{"issue":1,"pane":"%"}"#,
        r#"{"issue":1,"pane":"%1","command":"anything"}"#,
        "not json",
    ] {
        assert_eq!(router.route("POST", "/api/focus", &headers, body.as_bytes(), &mut fake).status, 400, "{body}");
    }
    assert_eq!(router.route("GET", "/api/focus", &headers, b"", &mut fake).status, 405);
    assert_eq!(router.route("OPTIONS", "/api/focus", &headers, b"", &mut fake).status, 405);
    assert_eq!(router.route("POST", "/api/snapshot", &headers, b"", &mut fake).status, 405);
    let mut wrong_type = headers.clone();
    wrong_type.iter_mut().find(|(key, _)| key == "Content-Type").unwrap().1 = "text/plain".into();
    assert_eq!(router.route("POST", "/api/focus", &wrong_type, b"{}", &mut fake).status, 415);
    assert_eq!(router.route("POST", "/api/focus", &headers, &vec![b' '; 4097], &mut fake).status, 413);
    assert!(fake.focuses.is_empty());
    assert_eq!(router.route("POST", "/api/focus", &headers, br#"{"issue":42,"pane":"%9"}"#, &mut fake).status, 200);
    assert_eq!(fake.focuses, vec![(42, "%9".into())]);
}

#[test]
fn failures_are_not_empty_successes_and_tokens_change_per_server() {
    let router = Router::new("127.0.0.1:8123");
    let headers = headers(&router);
    let other = Router::new("127.0.0.1:8123");
    assert_eq!(other.route("GET", "/api/snapshot", &headers, b"", &mut Fake::default()).status, 403);
    let mut fake = Fake { fail: true, ..Fake::default() };
    let reply = router.route("GET", "/api/snapshot", &headers, b"", &mut fake);
    assert_eq!(reply.status, 502);
    assert!(reply.body.contains("GitHub unavailable"));
    let reply = router.route("POST", "/api/focus", &headers, br#"{"issue":42,"pane":"%9"}"#, &mut fake);
    assert_eq!(reply.status, 409);
    assert!(reply.body.contains("Pane disappeared"));
}

struct Running {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<Result<()>>>,
}

impl Running {
    fn new<B: Backend + 'static>(factory: impl FnOnce() -> B + Send + 'static) -> Self {
        let server = HttpServer::bind(0).unwrap();
        let address = server.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        // B intentionally has no Send/Sync bound: it is constructed and used on this thread.
        let thread = thread::spawn(move || server.run(&mut factory(), &stopping));
        Self { address, stop, thread: Some(thread) }
    }

    fn connect(&self, request: &str) -> TcpStream {
        let mut stream = TcpStream::connect(self.address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        stream
    }

    fn get(&self, path: &str) -> String {
        let mut stream = self.connect(&format!("GET {path} HTTP/1.1\r\nHost: {}\r\n\r\n", self.address));
        // Well below the two-second request deadline: a stalled peer must not serialize reads.
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        response(&mut stream)
    }

    fn token(&self) -> String {
        let page = self.get("/");
        page.split("name=\"gho-token\" content=\"").nth(1).unwrap().split('"').next().unwrap().into()
    }

    fn authenticated(&self, method: &str, path: &str, token: &str, extra: &str) -> TcpStream {
        self.connect(&format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nX-GHO-Token: {token}\r\n{extra}", self.address))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap().unwrap();
        }
    }
}

fn response(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    // Closing a rejected request with unread input can produce a TCP reset after its response.
    if let Err(error) = stream.read_to_end(&mut bytes) {
        assert!(error.kind() == std::io::ErrorKind::ConnectionReset && !bytes.is_empty(), "{error}");
    }
    String::from_utf8(bytes).unwrap()
}

fn assert_status(response: &str, status: u16) {
    assert!(response.starts_with(&format!("HTTP/1.1 {status} ")), "{response}");
    assert!(response.contains("\r\nConnection: close\r\n"), "{response}");
}

// Rc makes this backend genuinely non-Send and non-Sync, just like existing Runner fixtures.
struct LocalFake {
    fake: Fake,
    _local: Rc<()>,
}

impl Backend for LocalFake {
    fn snapshot(&mut self) -> Result<Value> {
        self.fake.snapshot()
    }
    fn focus(&mut self, issue: u64, pane: &str) -> Result<()> {
        self.fake.focus(issue, pane)
    }
}

#[test]
fn sockets_serve_assets_and_authenticated_api_with_security_headers_and_local_backend() {
    let server = Running::new(|| LocalFake { fake: Fake::default(), _local: Rc::new(()) });
    let token = server.token();
    for path in ["/", "/app.js", "/style.css"] {
        let reply = server.get(path);
        assert_status(&reply, 200);
        for field in [
            "Cache-Control: no-store",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: no-referrer",
            "X-Frame-Options: DENY",
            "Content-Security-Policy:",
        ] {
            assert!(reply.contains(field), "{field}");
        }
        assert!(!reply.contains("Access-Control-Allow-Origin"));
    }
    let mut snapshot = server.authenticated("GET", "/api/snapshot", &token, "\r\n");
    let reply = response(&mut snapshot);
    assert_status(&reply, 200);
    assert!(reply.contains("\"repo\":\"example/repo\""));
    assert!(!reply.contains("Access-Control-Allow-"));
    let body = r#"{"issue":42,"pane":"%9"}"#;
    let mut focus = server.authenticated(
        "POST",
        "/api/focus",
        &token,
        &format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()),
    );
    let reply = response(&mut focus);
    assert_status(&reply, 200);
    assert!(!reply.contains("Access-Control-Allow-"));
    let mut wrong = server.authenticated("GET", "/api/focus", &token, "\r\n");
    assert_status(&response(&mut wrong), 405);
    let mut preflight = server.authenticated(
        "OPTIONS",
        "/api/focus",
        &token,
        &format!("Origin: http://{}\r\nAccess-Control-Request-Method: POST\r\n\r\n", server.address),
    );
    let reply = response(&mut preflight);
    assert_status(&reply, 405);
    assert!(!reply.contains("Access-Control-Allow-"));
}

#[test]
fn sockets_reject_unauthorized_headers_before_waiting_for_any_body() {
    let server = Running::new(Fake::default);
    let token = server.token();
    for extra in [
        String::new(),
        "X-GHO-Token: wrong\r\n".into(),
        format!("X-GHO-Token: {token}\r\nOrigin: https://attacker.invalid\r\n"),
        format!("X-GHO-Token: {token}\r\nOrigin: http://{}\r\norigin: http://{}\r\n", server.address, server.address),
        format!("X-GHO-Token: {token}\r\nHost: attacker.invalid\r\n"),
        format!("X-GHO-Token: {token}\r\nX-GHO-Token: {token}\r\n"),
    ] {
        let mut stream = server.connect(&format!(
            "POST /api/focus HTTP/1.1\r\nHost: {}\r\n{extra}Content-Type: application/json\r\nContent-Length: 2048\r\n\r\n",
            server.address
        ));
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        // No body is ever sent, not even after rejection.
        assert_status(&response(&mut stream), 403);
        assert_status(&server.get("/"), 200);
    }
}

#[test]
fn sockets_reject_oversized_and_ambiguous_framing_without_allocating_or_draining_body() {
    let server = Running::new(Fake::default);
    let token = server.token();
    for (headers, status) in [
        ("Content-Length: 4097\r\n", 413),
        ("Content-Length: 18446744073709551615\r\n", 413),
        ("Content-Length: 999999999999999999999999999999999999999999999999999\r\n", 413),
        ("Content-Length: -1\r\n", 400),
        ("Content-Length: 3\r\nContent-Length: 3\r\n", 400),
        ("Content-Length: 3\r\nTransfer-Encoding: chunked\r\n", 400),
        ("Transfer-Encoding: chunked\r\n", 400),
        ("Content-Length: 3\r\nExpect: 100-continue\r\n", 417),
        ("", 411),
    ] {
        let mut stream = server.authenticated(
            "POST",
            "/api/focus",
            &token,
            &format!("Content-Type: application/json\r\n{headers}\r\n"),
        );
        stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        assert_status(&response(&mut stream), status);
        assert_status(&server.get("/"), 200);
    }
    let mut nonpost = server.authenticated("GET", "/api/snapshot", &token, "Content-Length: 2048\r\n\r\n");
    assert_status(&response(&mut nonpost), 400);
    let mut oversized = server.connect(&format!("GET / HTTP/1.1\r\nX-Large: {}", "a".repeat(16 * 1024)));
    assert_status(&response(&mut oversized), 431);
    let mut many_headers = server.connect(&format!("GET / HTTP/1.1\r\n{}\r\n", "X-A: a\r\n".repeat(65)));
    assert_status(&response(&mut many_headers), 431);
    assert_status(&server.get("/"), 200);
}

#[test]
fn sockets_incomplete_headers_and_authenticated_body_do_not_block_other_requests() {
    let server = Running::new(Fake::default);
    let token = server.token();
    let mut headers = server.connect("GET / HTTP/1.1\r\nHost:");
    let mut body = server.authenticated(
        "POST",
        "/api/focus",
        &token,
        "Content-Type: application/json\r\nContent-Length: 2048\r\n\r\n{",
    );
    assert_status(&server.get("/app.js"), 200);
    let mut snapshot = server.authenticated("GET", "/api/snapshot", &token, "\r\n");
    snapshot.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_status(&response(&mut snapshot), 200);
    assert_status(&response(&mut headers), 408);
    assert_status(&response(&mut body), 408);
    assert_status(&server.get("/"), 200);
}

#[test]
fn sockets_share_one_absolute_read_deadline_across_headers_and_body() {
    let server = Running::new(Fake::default);
    let token = server.token();
    let started = Instant::now();
    let mut stream = server.connect("POST /api/focus HTTP/1.1\r\n");
    thread::sleep(Duration::from_millis(1200));
    stream
        .write_all(
            format!(
                "Host: {}\r\nX-GHO-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: 2048\r\n\r\n{{",
                server.address
            )
            .as_bytes(),
        )
        .unwrap();
    stream.set_read_timeout(Some(Duration::from_millis(1300))).unwrap();
    assert_status(&response(&mut stream), 408);
    assert!(started.elapsed() < Duration::from_millis(2700));
}

struct Paused {
    started: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
    focuses: Arc<AtomicUsize>,
}

impl Backend for Paused {
    fn snapshot(&mut self) -> Result<Value> {
        self.started.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(15)).map_err(|error| Error::msg(error.to_string()))?;
        Fake::default().snapshot()
    }
    fn focus(&mut self, _: u64, _: &str) -> Result<()> {
        self.focuses.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[test]
fn sockets_serve_static_files_during_snapshot_and_discard_expired_focus_before_side_effects() {
    let (started_tx, started) = mpsc::sync_channel(1);
    let (release, release_rx) = mpsc::channel();
    let focuses = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&focuses);
    let server = Running::new(move || Paused { started: started_tx, release: release_rx, focuses: count });
    let token = server.token();
    let mut snapshot = server.authenticated("GET", "/api/snapshot", &token, "\r\n");
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let body = r#"{"issue":42,"pane":"%9"}"#;
    let request = format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let mut stale = server.authenticated("POST", "/api/focus", &token, &request);
    assert_status(&server.get("/"), 200);
    assert_status(&server.get("/style.css"), 200);
    thread::sleep(Duration::from_millis(5300));
    release.send(()).unwrap();
    assert_status(&response(&mut snapshot), 200);
    assert_status(&response(&mut stale), 503);
    assert_eq!(focuses.load(Ordering::Relaxed), 0);
    let mut fresh = server.authenticated("POST", "/api/focus", &token, &request);
    assert_status(&response(&mut fresh), 200);
    assert_eq!(focuses.load(Ordering::Relaxed), 1);
}

#[test]
fn shutdown_during_health_check_discards_queued_requests_before_backend_dispatch() {
    for (method, path, body) in [("GET", "/api/snapshot", ""), ("POST", "/api/focus", r#"{"issue":42,"pane":"%9"}"#)] {
        let http = HttpServer::bind(0).unwrap();
        let address = http.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let (entered_tx, entered) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::channel();
        let (finished_tx, finished) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            let mut backend = Fake::default();
            let result = http.run_checked(&mut backend, &stopping, || {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).map_err(|error| Error::msg(error.to_string()))?;
                Ok(())
            });
            finished_tx.send(backend).unwrap();
            result
        });
        let server = Running { address, stop, thread: Some(thread) };
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let token = server.token();
        let extra = format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let mut queued = Vec::new();
        let mut full = false;
        // A 503 while dispatch is paused proves the bounded queue contains complete,
        // authenticated requests. A sleep alone would not prove a request reached the queue.
        for _ in 0..32 {
            let mut stream = server.authenticated(method, path, &token, &extra);
            stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
            match stream.peek(&mut [0; 1]) {
                Ok(0) => {} // The connection limit can close an excess connection before parsing.
                Ok(_) => {
                    stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                    assert_status(&response(&mut stream), 503);
                    full = true;
                    break;
                }
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    queued.push(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                Err(error) => panic!("{method} {path}: {error}"),
            }
        }
        assert!(full, "{method} {path}: requests did not fill the queue while the health check was paused");
        server.stop.store(true, Ordering::Relaxed);
        release.send(()).unwrap();
        drop(server); // Joins the server; Running also provides cleanup on assertion failure.
        let backend = finished.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(backend.reads, 0, "a snapshot started after shutdown was requested");
        assert!(backend.focuses.is_empty(), "a pane was focused after shutdown was requested");
        drop(queued);
    }
}

#[test]
fn server_health_error_stops_an_idle_server_promptly_and_preserves_the_error() {
    let server = HttpServer::bind(0).unwrap();
    assert!(server.local_addr().unwrap().ip().is_loopback());
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = Arc::clone(&stop);
    let (finished_tx, finished) = mpsc::sync_channel(1);
    let thread = thread::spawn(move || {
        let mut checks = 0;
        let mut backend = LocalFake { fake: Fake::default(), _local: Rc::new(()) };
        let result = server.run_checked(&mut backend, &stopping, || {
            checks += 1;
            if checks == 1 { Ok(()) } else { Err(Error::msg("Tailscale Serve stopped unexpectedly.")) }
        });
        finished_tx.send((result, checks, backend.fake.reads, backend.fake.focuses)).unwrap();
    });
    let result = finished.recv_timeout(Duration::from_secs(2));
    // Make even the failure path shut down cleanly instead of leaving a background server alive.
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    let (result, checks, reads, focuses) = result.expect("health failure must stop the idle server within two seconds");
    assert_eq!(result.unwrap_err().to_string(), "Tailscale Serve stopped unexpectedly.");
    assert_eq!(checks, 2);
    assert_eq!(reads, 0);
    assert!(focuses.is_empty());
}

struct Recorded {
    calls: RefCell<Vec<Cmd>>,
    delay: Duration,
    fail: bool,
}

impl Recorded {
    fn new(delay: Duration, fail: bool) -> Self {
        Self { calls: RefCell::new(Vec::new()), delay, fail }
    }
}

impl Runner for Recorded {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        self.calls.borrow_mut().push(cmd.clone());
        thread::sleep(self.delay.min(cmd.timeout));
        if self.fail { Err(Error::msg("subprocess failure")) } else { Ok("ok".into()) }
    }
}

#[test]
fn deadline_runner_caps_each_command_and_preserves_shorter_timeouts_and_arguments() {
    let inner = Recorded::new(Duration::ZERO, false);
    let runner = DeadlineRunner::new(&inner, Duration::from_secs(1));
    let mut short = Cmd::new(["gh", "api", "graphql"]);
    short.timeout = Duration::from_millis(5);
    short.env.push(("GH_HOST".into(), "github.com".into()));
    runner.run(&short).unwrap();
    runner.run(&Cmd::new(["git", "status"])).unwrap();
    let calls = inner.calls.borrow();
    assert_eq!(calls[0].timeout, short.timeout);
    assert_eq!(calls[0].argv, short.argv);
    assert_eq!(calls[0].env, short.env);
    assert!(calls[1].timeout <= Duration::from_secs(1));
    assert!(calls[1].timeout > Duration::ZERO);
}

#[test]
fn deadline_runner_spends_one_budget_across_commands_and_rejects_late_success_or_error() {
    for fail in [false, true] {
        let inner = Recorded::new(Duration::from_millis(40), fail);
        let runner = DeadlineRunner::new(&inner, Duration::from_millis(70));
        let first = runner.run(&Cmd::new(["gh", "first"]));
        if fail {
            assert!(first.unwrap_err().to_string().contains("subprocess failure"));
        } else {
            assert_eq!(first.unwrap(), "ok");
        }
        let error = runner.run(&Cmd::new(["gh", "second"])).unwrap_err().to_string();
        assert!(error.contains("Dashboard snapshot timed out"), "{error}");
        assert!(error.contains("Retry Refresh"));
        let calls = inner.calls.borrow();
        assert!(calls[1].timeout < calls[0].timeout);
        assert!(calls[1].timeout <= Duration::from_millis(40));
        drop(calls);
        assert!(runner.run(&Cmd::new(["gh", "never-run"])).is_err());
        assert_eq!(inner.calls.borrow().len(), 2);
    }
}

#[test]
fn expired_snapshot_budget_returns_502_without_running_commands_or_returning_empty_tasks() {
    struct Expired(Recorded);
    impl Backend for Expired {
        fn snapshot(&mut self) -> Result<Value> {
            DeadlineRunner::new(&self.0, Duration::ZERO).run(&Cmd::new(["gh", "never-run"]))?;
            Ok(json!({"tasks": []}))
        }
        fn focus(&mut self, _: u64, _: &str) -> Result<()> {
            unreachable!()
        }
    }
    let router = Router::new("127.0.0.1:8123");
    let mut backend = Expired(Recorded::new(Duration::ZERO, false));
    let reply = router.route("GET", "/api/snapshot", &headers(&router), b"", &mut backend);
    assert_eq!(reply.status, 502);
    assert!(reply.body.contains("snapshot timed out"));
    assert!(serde_json::from_str::<Value>(&reply.body).unwrap().get("tasks").is_none());
    assert!(backend.0.calls.borrow().is_empty());
}
