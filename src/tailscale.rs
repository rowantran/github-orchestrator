//! An owned, foreground Tailscale Serve session. Never reset or disable shared Serve settings.

use std::collections::BTreeMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::process::{Cmd, Runner};
use crate::{Error, Result, ensure};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 8192;

/// Validated public authorities and the node-level HTTP port to claim.
#[derive(Debug)]
pub struct Plan {
    port: u16,
    dns_name: String,
    authorities: Vec<String>,
}

impl Plan {
    /// Read-only preflight. Port zero selects 8080, not a random tailnet port.
    pub fn prepare(runner: &dyn Runner, port: u16) -> Result<Self> {
        let port = if port == 0 { 8080 } else { port };
        let output = inspect(runner, &["status", "--json", "--peers=false"])?;
        let status: Status = serde_json::from_str(&output)
            .map_err(|error| Error::msg(format!("Invalid Tailscale status JSON: {error}")))?;
        ensure!(
            status.backend_state == "Running",
            "Tailscale is not running ({}); start tailscaled and authenticate with `tailscale up` first.",
            status.backend_state
        );
        let node = status.self_node.ok_or_else(|| Error::msg("Tailscale status is missing Self.DNSName."))?;
        let tailnet =
            status.current_tailnet.ok_or_else(|| Error::msg("Tailscale status is missing CurrentTailnet."))?;
        let dns_name = node.dns_name.strip_suffix('.').unwrap_or(&node.dns_name).to_ascii_lowercase();
        let suffix = tailnet.magic_dns_suffix.to_ascii_lowercase();
        ensure!(
            valid_dns(&dns_name) && valid_dns(&suffix),
            "Tailscale returned an invalid DNS name or MagicDNS suffix; refusing to expose the dashboard."
        );
        let short = dns_name.strip_suffix(&format!(".{suffix}")).unwrap_or("");
        ensure!(
            !short.is_empty()
                && !short.contains('.')
                && short != "localhost"
                && !short.bytes().all(|byte| byte.is_ascii_digit())
                && !short.strip_prefix("0x").is_some_and(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
                && tailnet.magic_dns_enabled,
            "Enable MagicDNS and check this node's DNSName before using Tailscale Serve."
        );
        let authority = |host: &str| if port == 80 { host.to_owned() } else { format!("{host}:{port}") };
        let authorities = vec![authority(short), authority(&dns_name)];
        let plan = Self { port, dns_name, authorities };
        read_config(runner)?.ensure_free(port)?;
        Ok(plan)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn authorities(&self) -> &[String] {
        &self.authorities
    }

    pub fn url(&self) -> String {
        format!("http://{}/", self.authorities[0])
    }

    /// Claim only a new foreground session, then confirm its exact proxy in daemon status.
    /// The caller must keep the backend listening and drop Serve on shutdown.
    pub fn start(&self, runner: &dyn Runner, backend: SocketAddr, stop: &AtomicBool) -> Result<Serve> {
        self.start_with_timeout(runner, backend, stop, START_TIMEOUT)
    }

    fn start_with_timeout(
        &self,
        runner: &dyn Runner,
        backend: SocketAddr,
        stop: &AtomicBool,
        timeout: Duration,
    ) -> Result<Serve> {
        ensure!(
            backend.ip() == Ipv4Addr::LOCALHOST && backend.port() != 0,
            "Tailscale Serve requires a listening backend on 127.0.0.1 with a nonzero port."
        );
        check_stop(stop)?;
        // Repeat preflight immediately before spawning. The daemon also rejects concurrent port
        // claims, using an ETag plus foreground-listener validation in Tailscale 1.102.2.
        read_config(runner)?.ensure_free(self.port)?;
        check_stop(stop)?;
        let target = format!("http://{backend}");
        let child = Command::new("tailscale")
            .args(["serve", "--bg=false", &format!("--http={}", self.port), &target])
            // HTTP setup has no prompts; --yes is unnecessary and does not bypass collisions.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                Error::msg(format!(
                    "Cannot start Tailscale Serve: {error}; install tailscale and check executable permissions."
                ))
            })?;
        let mut serve = Serve::new(child, self.port);
        let deadline = Instant::now() + timeout;
        loop {
            check_stop(stop)?;
            serve.check()?;
            let config = read_config(runner)?;
            config.ensure_no_funnel(self.port)?;
            check_stop(stop)?;
            serve.check()?;
            if config.foreground.values().any(|config| config.matches(self, &target)) {
                return Ok(serve);
            }
            ensure!(
                Instant::now() < deadline,
                "Tailscale Serve did not confirm its foreground proxy before the startup deadline; check `tailscale serve status --json`, operator permissions, and port {}. {}",
                self.port,
                serve.diagnostic()
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Killing this CLI closes its IPN session; tailscaled removes only that foreground config.
/// A parent process killed with SIGKILL cannot run Drop: callers must handle termination signals.
pub struct Serve {
    child: Child,
    port: u16,
    stderr: Arc<Mutex<Vec<u8>>>,
    reader: Option<JoinHandle<()>>,
}

impl Serve {
    fn new(mut child: Child, port: u16) -> Self {
        let mut pipe = child.stderr.take().expect("piped stderr");
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&stderr);
        let reader = thread::spawn(move || {
            let mut chunk = [0; 1024];
            while let Ok(count) = pipe.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let mut bytes = output.lock().unwrap_or_else(|error| error.into_inner());
                bytes.extend_from_slice(&chunk[..count]);
                let excess = bytes.len().saturating_sub(OUTPUT_LIMIT);
                bytes.drain(..excess);
            }
        });
        Self { child, port, stderr, reader: Some(reader) }
    }

    /// Even exit code zero is unexpected while the dashboard owns this session.
    pub fn check(&mut self) -> Result<()> {
        if let Some(status) = self.child.try_wait()? {
            self.join_reader();
            return Err(Error::msg(format!(
                "Tailscale Serve exited unexpectedly ({status}); check tailscaled, operator permissions, and whether port {} is already in use. {}",
                self.port,
                self.diagnostic()
            )));
        }
        Ok(())
    }

    fn join_reader(&mut self) {
        if let Some(reader) = self.reader.take() {
            // Normal tailscale exits close the pipe. Do not hang shutdown if a wrapper or a
            // future CLI descendant inherits it; the detached reader retains only bounded output.
            let deadline = Instant::now() + Duration::from_millis(100);
            while !reader.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(2));
            }
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
    }

    fn diagnostic(&self) -> String {
        let bytes = self.stderr.lock().unwrap_or_else(|error| error.into_inner());
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        // Never use serve off/reset: those commands can remove somebody else's configuration.
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.join_reader();
    }
}

fn check_stop(stop: &AtomicBool) -> Result<()> {
    ensure!(!stop.load(Ordering::Relaxed), "Tailscale Serve startup cancelled.");
    Ok(())
}

fn inspect(runner: &dyn Runner, args: &[&str]) -> Result<String> {
    runner.run(&Cmd::new(["tailscale"].into_iter().chain(args.iter().copied())).timeout(2)).map_err(|error| {
        Error::msg(format!(
            "Cannot inspect Tailscale: {error}. Check that tailscale is installed, tailscaled is running, and this user has Tailscale operator permission."
        ))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Status {
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: Option<Node>,
    current_tailnet: Option<Tailnet>,
}

#[derive(Deserialize)]
struct Node {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

#[derive(Deserialize)]
struct Tailnet {
    #[serde(rename = "MagicDNSSuffix")]
    magic_dns_suffix: String,
    #[serde(rename = "MagicDNSEnabled")]
    magic_dns_enabled: bool,
}

// The raw ServeConfig schema is unversioned. Fail closed on unknown fields rather than silently
// treating a changed schema as an empty/free port. Empty {} and top-level null are valid states.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase", deny_unknown_fields)]
struct ServeConfig {
    #[serde(rename = "TCP")]
    tcp: BTreeMap<u16, TcpHandler>,
    web: BTreeMap<String, WebConfig>,
    allow_funnel: BTreeMap<String, bool>,
    foreground: BTreeMap<String, ServeConfig>,
    services: BTreeMap<String, ServiceConfig>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase", deny_unknown_fields)]
struct ServiceConfig {
    #[serde(rename = "TCP")]
    tcp: BTreeMap<u16, TcpHandler>,
    web: BTreeMap<String, WebConfig>,
    tun: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase", deny_unknown_fields)]
struct TcpHandler {
    #[serde(rename = "HTTP")]
    http: bool,
    #[serde(rename = "HTTPS")]
    https: bool,
    #[serde(rename = "TCPForward")]
    tcp_forward: String,
    #[serde(rename = "TerminateTLS")]
    terminate_tls: String,
    proxy_protocol: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct WebConfig {
    handlers: BTreeMap<String, HttpHandler>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase", deny_unknown_fields)]
struct HttpHandler {
    proxy: String,
    path: String,
    text: String,
    redirect: String,
    accept_app_caps: Vec<String>,
}

fn read_config(runner: &dyn Runner) -> Result<ServeConfig> {
    parse_config(&inspect(runner, &["serve", "status", "--json"])?)
}

fn parse_config(output: &str) -> Result<ServeConfig> {
    // Serde structs can otherwise accept positional JSON arrays, including [] for a defaulted
    // struct. Serve emits objects, never positional records. Only AcceptAppCaps is an array.
    fn object_shape(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(fields) => fields.iter().all(|(key, value)| {
                (key == "AcceptAppCaps" && value.as_array().is_some_and(|caps| caps.iter().all(|cap| cap.is_string())))
                    || object_shape(value)
            }),
            serde_json::Value::Array(_) => false,
            _ => true,
        }
    }
    let value: serde_json::Value = serde_json::from_str(output)
        .map_err(|error| Error::msg(format!("Invalid Tailscale Serve status JSON: {error}")))?;
    ensure!(
        (value.is_null() || value.is_object()) && object_shape(&value),
        "Invalid Tailscale Serve status shape; refusing to assume a free port."
    );
    let config = serde_json::from_str::<Option<ServeConfig>>(output)
        .map_err(|error| {
            Error::msg(format!("Invalid Tailscale Serve status JSON; refusing to assume a free port: {error}"))
        })?
        .unwrap_or_default();
    config.validate(false)?;
    Ok(config)
}

impl ServeConfig {
    fn validate(&self, nested: bool) -> Result<()> {
        ensure!(
            !nested || (self.foreground.is_empty() && self.services.is_empty() && !self.tcp.is_empty()),
            "Incomplete or nested Tailscale foreground configuration; refusing to assume a free port."
        );
        validate_handlers(&self.tcp, &self.web)?;
        for key in self.allow_funnel.keys() {
            host_port(key)?;
        }
        for (session, config) in &self.foreground {
            ensure!(!session.is_empty(), "Invalid Tailscale foreground session ID.");
            config.validate(true)?;
        }
        for (name, service) in &self.services {
            ensure!(name.starts_with("svc:") && name.len() > 4, "Invalid Tailscale service name.");
            ensure!(
                !service.tun || (service.tcp.is_empty() && service.web.is_empty()),
                "Invalid Tailscale service configuration."
            );
            validate_handlers(&service.tcp, &service.web)?;
        }
        Ok(())
    }

    fn ensure_no_funnel(&self, port: u16) -> Result<()> {
        for (target, enabled) in &self.allow_funnel {
            ensure!(
                !enabled || host_port(target)? != port,
                "Tailscale Funnel is enabled on port {port}; choose another --tailscale-serve port. No settings were changed."
            );
        }
        for config in self.foreground.values() {
            config.ensure_no_funnel(port)?;
        }
        Ok(())
    }

    fn ensure_free(&self, port: u16) -> Result<()> {
        self.ensure_no_funnel(port)?;
        ensure!(
            !self.tcp.contains_key(&port),
            "Tailscale Serve port {port} is already in use; choose another --tailscale-serve port. Existing settings were not changed."
        );
        for config in self.foreground.values() {
            config.ensure_free(port)?;
        }
        Ok(())
    }

    fn matches(&self, plan: &Plan, target: &str) -> bool {
        self.tcp.get(&plan.port).is_some_and(|handler| handler.http)
            && self
                .web
                .get(&format!("{}:{}", plan.dns_name, plan.port))
                .and_then(|web| web.handlers.get("/"))
                .is_some_and(|handler| handler.proxy == target)
    }
}

fn validate_handlers(tcp: &BTreeMap<u16, TcpHandler>, web: &BTreeMap<String, WebConfig>) -> Result<()> {
    for (port, handler) in tcp {
        ensure!(
            *port != 0
                && usize::from(handler.http)
                    + usize::from(handler.https)
                    + usize::from(!handler.tcp_forward.is_empty())
                    == 1
                && (handler.terminate_tls.is_empty() || !handler.tcp_forward.is_empty())
                && handler.proxy_protocol <= 2,
            "Invalid Tailscale TCP handler; refusing to assume a free port."
        );
        if handler.http || handler.https {
            ensure!(
                web.keys().any(|key| host_port(key).ok() == Some(*port)),
                "Incomplete Tailscale web configuration; refusing to assume a free port."
            );
        }
    }
    for (key, config) in web {
        let port = host_port(key)?;
        ensure!(
            tcp.get(&port).is_some_and(|handler| handler.http || handler.https) && !config.handlers.is_empty(),
            "Incomplete Tailscale web configuration; refusing to assume a free port."
        );
        for (mount, handler) in &config.handlers {
            ensure!(
                mount.starts_with('/')
                    && [&handler.proxy, &handler.path, &handler.text, &handler.redirect]
                        .into_iter()
                        .filter(|value| !value.is_empty())
                        .count()
                        == 1
                    && handler.accept_app_caps.iter().all(|cap| !cap.is_empty()),
                "Invalid Tailscale HTTP handler; refusing to assume a free port."
            );
        }
    }
    Ok(())
}

fn host_port(value: &str) -> Result<u16> {
    let valid = value
        .rsplit_once(':')
        .and_then(|(host, port)| port.parse::<u16>().ok().filter(|port| *port != 0 && valid_dns(host)));
    valid.ok_or_else(|| Error::msg("Invalid Tailscale host:port in Serve status; refusing to assume a free port."))
}

fn valid_dns(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_status_schema_includes_foreground() {
        let config = parse_config(
            r#"{"Foreground":{"session":{"TCP":{"8080":{"HTTP":true}},"Web":{"node.tail.ts.net:8080":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4321"}}}}}}}"#,
        )
        .unwrap();
        assert!(config.ensure_free(8080).is_err());
        assert!(config.ensure_free(8081).is_ok());
    }

    #[test]
    fn malformed_or_incomplete_status_is_not_a_free_port() {
        for json in [
            "",
            "[]",
            "true",
            r#"{"tcp":{}}"#,
            r#"{"TCP":null}"#,
            r#"{"Foreground":[]}"#,
            r#"{"Foreground":{"x":{}}}"#,
            r#"{"TCP":{"8080":null}}"#,
            r#"{"TCP":{"8080":{}}}"#,
            r#"{"TCP":{"8080":{"HTTP":true}}}"#,
            r#"{"Web":{"node:8080":{"Handlers":{"/":{"Proxy":"http://localhost:1"}}}}}"#,
            r#"{"AllowFunnel":{"node:nope":true}}"#,
            r#"{"AllowFunnel":{"node:8080":"true"}}"#,
        ] {
            assert!(parse_config(json).is_err(), "accepted {json}");
        }
        assert!(parse_config("null").is_ok());
        assert!(parse_config("{}").is_ok());
    }

    #[test]
    fn dormant_funnel_on_target_port_is_still_a_risk() {
        let config = parse_config(r#"{"AllowFunnel":{"another.tail.ts.net:8080":true}}"#).unwrap();
        assert!(config.ensure_free(8080).unwrap_err().to_string().contains("Funnel"));
        assert!(config.ensure_free(8081).is_ok());
    }
}
