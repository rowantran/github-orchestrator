//! All subprocess tests use a private fake tailscale executable, never the real daemon.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use github_orchestrator::process::{Cmd, Runner, System};
use github_orchestrator::tailscale::Plan;
use github_orchestrator::{Error, Result};
use serde_json::{Value, json};
use tempfile::TempDir;

fn status() -> Value {
    json!({
        "BackendState": "Running",
        "Self": {"DNSName": "rowan-v2-dev.tail5601d9.ts.net."},
        "CurrentTailnet": {"MagicDNSSuffix": "tail5601d9.ts.net", "MagicDNSEnabled": true}
    })
}

struct Fixture {
    replies: RefCell<VecDeque<Result<String>>>,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Fixture {
    fn new(status: Value, config: Value) -> Self {
        Self {
            replies: RefCell::new([Ok(status.to_string()), Ok(config.to_string())].into()),
            calls: RefCell::default(),
        }
    }
}

impl Runner for Fixture {
    fn run(&self, cmd: &Cmd) -> Result<String> {
        assert_eq!(cmd.timeout, Duration::from_secs(2));
        self.calls.borrow_mut().push(cmd.argv.clone());
        self.replies.borrow_mut().pop_front().expect("unexpected subprocess")
    }
}

#[test]
fn prepare_is_read_only_and_normalizes_short_and_full_authorities() {
    for (port, expected) in [(0, ":8080"), (8080, ":8080"), (80, ""), (8181, ":8181")] {
        let fixture = Fixture::new(status(), json!({}));
        let plan = Plan::prepare(&fixture, port).unwrap();
        assert_eq!(
            plan.authorities(),
            [format!("rowan-v2-dev{expected}"), format!("rowan-v2-dev.tail5601d9.ts.net{expected}")]
        );
        assert_eq!(plan.url(), format!("http://rowan-v2-dev{expected}/"));
        assert_eq!(
            *fixture.calls.borrow(),
            [vec!["tailscale", "status", "--json", "--peers=false"], vec!["tailscale", "serve", "status", "--json"]]
        );
    }
}

#[test]
fn reject_unsafe_or_incomplete_node_status() {
    for dns in [
        "",
        "node",
        "node.other.net",
        "node..tail5601d9.ts.net",
        "-node.tail5601d9.ts.net",
        "http://node.tail5601d9.ts.net",
        "node:80.tail5601d9.ts.net",
        "node@tail5601d9.ts.net",
        "node.tail5601d9.ts.net..",
        "node\n.tail5601d9.ts.net",
        "nöde.tail5601d9.ts.net",
        "localhost.tail5601d9.ts.net",
        "123.tail5601d9.ts.net",
        "0x7f000001.tail5601d9.ts.net",
    ] {
        let mut value = status();
        value["Self"]["DNSName"] = dns.into();
        assert!(Plan::prepare(&Fixture::new(value, json!({})), 0).is_err(), "accepted {dns:?}");
    }
    for value in [json!({}), json!({"BackendState":"Running"}), json!({"BackendState":"NeedsLogin"})] {
        assert!(Plan::prepare(&Fixture::new(value, json!({})), 0).is_err());
    }
    let mut value = status();
    value["CurrentTailnet"]["MagicDNSEnabled"] = false.into();
    assert!(Plan::prepare(&Fixture::new(value, json!({})), 0).unwrap_err().to_string().contains("MagicDNS"));
}

#[test]
fn status_failures_are_actionable() {
    let fixture = Fixture::new(status(), json!({}));
    *fixture.replies.borrow_mut() = [Err(Error::msg("Required executable not found: tailscale"))].into();
    let error = Plan::prepare(&fixture, 0).unwrap_err().to_string();
    assert!(error.contains("installed") && error.contains("not found"));
    let error =
        Plan::prepare(&Fixture::new(json!({"BackendState":"NeedsLogin"}), json!({})), 0).unwrap_err().to_string();
    assert!(error.contains("tailscale up"));
}

#[test]
fn occupied_foreground_background_and_funnel_ports_are_refused() {
    let listener = json!({"TCP":{"8080":{"TCPForward":"127.0.0.1:4321"}}});
    for config in [
        listener.clone(),
        json!({"Foreground":{"someone-else":listener.clone()}}),
        json!({"AllowFunnel":{"node.tail.ts.net:8080":true}}),
        json!({"Foreground":{"someone-else":{
            "TCP":{"9000":{"TCPForward":"127.0.0.1:4321"}},
            "AllowFunnel":{"node.tail.ts.net:8080":true}
        }}}),
    ] {
        let fixture = Fixture::new(status(), config);
        assert!(Plan::prepare(&fixture, 8080).is_err());
        assert_eq!(fixture.calls.borrow().len(), 2);
    }
    let fixture = Fixture::new(status(), listener);
    assert!(Plan::prepare(&fixture, 8081).is_ok());
}

#[test]
fn virtual_service_ports_are_separate_from_node_ports() {
    let fixture =
        Fixture::new(status(), json!({"Services":{"svc:demo":{"TCP":{"8080":{"TCPForward":"127.0.0.1:4321"}}}}}));
    assert!(Plan::prepare(&fixture, 8080).is_ok());
}

#[test]
fn malformed_serve_status_never_permits_startup() {
    for config in [
        json!([]),
        json!({"Foreground":null}),
        json!({"Foreground":{"session":[]}}),
        json!({"Services":{"svc:demo":[]}}),
        json!({"Unknown":{}}),
        json!({"TCP":{"8080":{"HTTP":true}}}),
        json!({"Web":{"node:8080":{}}}),
        json!({"AllowFunnel":{"node:8080":null}}),
    ] {
        assert!(Plan::prepare(&Fixture::new(status(), config), 8080).is_err());
    }
}

#[test]
fn invalid_backends_and_cancellation_never_spawn() {
    for backend in ["0.0.0.0:4321", "100.64.0.1:4321", "[::1]:4321", "127.0.0.1:0"] {
        let fixture = Fixture::new(status(), json!({}));
        let plan = Plan::prepare(&fixture, 0).unwrap();
        assert!(plan.start(&fixture, backend.parse().unwrap(), &AtomicBool::new(false)).is_err());
        assert_eq!(fixture.calls.borrow().len(), 2);
    }
    let fixture = Fixture::new(status(), json!({}));
    let plan = Plan::prepare(&fixture, 0).unwrap();
    assert!(plan.start(&fixture, "127.0.0.1:4321".parse().unwrap(), &AtomicBool::new(true)).is_err());
    assert_eq!(fixture.calls.borrow().len(), 2);
}

// Each scenario runs in its own test process so setting PATH never races other tests. The fake
// records every invocation; an unrecognised command fails instead of falling through to real CLI.
const FAKE: &str = r#"#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ['GHO_TAILSCALE_TEST'])
args = sys.argv[1:]
with (root / 'calls').open('a') as f:
    f.write(json.dumps(args) + '\n')
mode = os.environ['GHO_TAILSCALE_MODE']
if args == ['status', '--json', '--peers=false']:
    print((root / 'status').read_text())
elif args == ['serve', 'status', '--json']:
    if mode == 'malformed' and (root / 'pid').exists():
        print('{"Foreground":[] }')
    else:
        print((root / 'config').read_text())
elif args == ['serve', '--bg=false', '--http=8080', 'http://127.0.0.1:4321']:
    (root / 'pid').write_text(str(os.getpid()))
    if mode == 'failure':
        print('Access denied: check operator permission', file=sys.stderr)
        sys.exit(1)
    if mode == 'clean-exit':
        sys.exit(0)
    if mode == 'chatty':
        sys.stderr.write('x' * 200000)
        sys.stderr.flush()
    if mode.startswith('descendant-') and os.fork() == 0:
        (root / 'descendant-ready').write_text(str(os.getpid()))
        deadline = time.monotonic() + 3
        while not (root / 'descendant-stop').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        os.close(2)
        (root / 'descendant-done').write_text('')
        os._exit(0)
    if mode not in ['timeout', 'cancel', 'malformed']:
        config = json.loads((root / 'config').read_text())
        config.setdefault('Foreground', {})['owned'] = {
            'TCP': {'8080': {'HTTP': True}},
            'Web': {'rowan-v2-dev.tail5601d9.ts.net:8080': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:4321'}}}}
        }
        pending = root / 'pending'
        pending.write_text(json.dumps(config))
        pending.replace(root / 'config')
    while not (root / 'exit').exists():
        time.sleep(0.01)
else:
    print('FORBIDDEN COMMAND: ' + repr(args), file=sys.stderr)
    sys.exit(90)
"#;

#[test]
fn owned_process_lifecycle() {
    for mode in [
        "ready",
        "failure",
        "clean-exit",
        "timeout",
        "cancel",
        "malformed",
        "chatty",
        "race",
        "pre-cancel",
        "descendant-check",
        "descendant-drop",
    ] {
        let dir = TempDir::new().unwrap();
        let fake = dir.path().join("tailscale");
        fs::write(&fake, FAKE).unwrap();
        fs::set_permissions(fake, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(dir.path().join("status"), status().to_string()).unwrap();
        // Unrelated settings must remain unchanged. Only the private fake writes this fixture.
        fs::write(
            dir.path().join("config"),
            json!({
                "TCP":{"6767":{"TCPForward":"127.0.0.1:6767"}},
                "Foreground":{"existing":{"TCP":{"9090":{"TCPForward":"127.0.0.1:9090"}}}}
            })
            .to_string(),
        )
        .unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "fake_process_worker", "--nocapture"])
            .env("GHO_TAILSCALE_TEST", dir.path())
            .env("GHO_TAILSCALE_MODE", mode)
            .env("PATH", dir.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for line in fs::read_to_string(dir.path().join("calls")).unwrap().lines() {
            let args: Vec<String> = serde_json::from_str(line).unwrap();
            assert!(!args.iter().any(|arg| ["off", "reset", "funnel", "--bg", "--yes"].contains(&arg.as_str())));
        }
    }
}

// Signal the fake descendant to exit even if an assertion panics. Its own three-second watchdog
// also prevents a stuck regression from leaking it; closing stderr precedes the done marker.
struct DescendantCleanup(std::path::PathBuf);

impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        let _ = fs::write(self.0.join("descendant-stop"), "");
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.0.join("descendant-ready").exists()
            && !self.0.join("descendant-done").exists()
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn fake_process_worker() {
    let Some(path) = std::env::var_os("GHO_TAILSCALE_TEST") else { return };
    let root = std::path::PathBuf::from(path);
    // Refuse accidental execution with the real CLI even in an incorrectly configured test run.
    assert_eq!(std::env::var_os("PATH").unwrap(), root.as_os_str());
    assert_eq!(fs::read_to_string(root.join("tailscale")).unwrap(), FAKE);
    let mode = std::env::var("GHO_TAILSCALE_MODE").unwrap();
    let descendant_cleanup = DescendantCleanup(root.clone());
    let plan = Plan::prepare(&System, 8080).unwrap();
    let stop = Arc::new(AtomicBool::new(mode == "pre-cancel"));
    if mode == "race" {
        fs::write(root.join("config"), r#"{"TCP":{"8080":{"TCPForward":"127.0.0.1:9999"}}}"#).unwrap();
    }
    let cancel = if mode == "cancel" {
        let stop = Arc::clone(&stop);
        Some(thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            stop.store(true, Ordering::Relaxed);
        }))
    } else {
        None
    };
    let start = Instant::now();
    let result = plan.start(&System, "127.0.0.1:4321".parse::<SocketAddr>().unwrap(), &stop);
    if let Some(cancel) = cancel {
        cancel.join().unwrap();
    }
    assert!(start.elapsed() < Duration::from_secs(15));
    match mode.as_str() {
        "descendant-check" | "descendant-drop" => {
            let mut serve = result.unwrap_or_else(|error| panic!("{error}"));
            let deadline = Instant::now() + Duration::from_secs(2);
            while !root.join("descendant-ready").exists() {
                assert!(Instant::now() < deadline, "descendant did not start");
                thread::sleep(Duration::from_millis(10));
            }
            let start = Instant::now();
            if mode == "descendant-check" {
                fs::write(root.join("exit"), "").unwrap();
                while serve.check().is_ok() {
                    assert!(start.elapsed() < Duration::from_secs(1), "check did not observe exit promptly");
                    thread::sleep(Duration::from_millis(10));
                }
                assert!(start.elapsed() < Duration::from_secs(1), "check waited for inherited stderr");
            }
            let start = Instant::now();
            drop(serve);
            assert!(start.elapsed() < Duration::from_secs(1), "Drop waited for inherited stderr");
            assert!(!root.join("descendant-done").exists(), "descendant exited before the bounded-join assertion");
        }
        "ready" | "chatty" => {
            let mut serve = result.unwrap_or_else(|error| panic!("{error}"));
            serve.check().unwrap();
            if mode == "ready" {
                fs::write(root.join("exit"), "").unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Err(error) = serve.check() {
                        assert!(error.to_string().contains("exited unexpectedly"));
                        break;
                    }
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(20));
                }
            }
            drop(serve);
            let config: Value = serde_json::from_str(&fs::read_to_string(root.join("config")).unwrap()).unwrap();
            assert_eq!(config["TCP"]["6767"]["TCPForward"], "127.0.0.1:6767");
            assert_eq!(config["Foreground"]["existing"]["TCP"]["9090"]["TCPForward"], "127.0.0.1:9090");
        }
        _ => {
            let error = match result {
                Ok(_) => panic!("unexpected successful {mode}"),
                Err(error) => error.to_string(),
            };
            let expected = match mode.as_str() {
                "failure" => "Access denied",
                "clean-exit" => "exited unexpectedly",
                "timeout" => "did not confirm",
                "cancel" | "pre-cancel" => "cancelled",
                "malformed" => "Invalid Tailscale Serve status",
                "race" => "already in use",
                _ => unreachable!(),
            };
            assert!(error.contains(expected), "{mode}: {error}");
        }
    }
    drop(descendant_cleanup);
    if mode.starts_with("descendant-") {
        assert!(root.join("descendant-done").exists(), "descendant did not stop");
    }
    if mode == "race" || mode == "pre-cancel" {
        assert!(!root.join("pid").exists());
    } else {
        let pid = fs::read_to_string(root.join("pid")).unwrap();
        // Linux test host: no live or zombie owned process remains after either success or error.
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "child {pid} was not reaped");
    }
}
