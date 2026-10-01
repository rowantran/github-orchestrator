#!/usr/bin/env python3
"""Strict, loopback-only Serve simulator. Never invoke tailscale or contact tailscaled."""
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import sys
import uuid


root = Path(os.environ["GHO_E2E_FIXTURE"])
args = sys.argv[1:]
dns_name = "rowan-v2-dev.example.ts.net"
session_path = root / "tailscale-session.json"
config_path = root / "tailscale-config.json"


def record(name, value):
    # One append write also works when proxy requests run in different threads.
    with (root / name).open("a") as stream:
        stream.write(json.dumps(value) + "\n")


def reject(message):
    record("rejected.jsonl", {"tailscale": args, "error": message})
    print(f"Rejected unexpected tailscale command: {message}", file=sys.stderr)
    sys.exit(87)


def process_identity(pid):
    """Treat dead/zombie owners and reused PIDs as disconnected IPN sessions."""
    try:
        os.kill(pid, 0)
        stat = Path(f"/proc/{pid}/stat")
        if stat.exists():
            fields = stat.read_text().rsplit(")", 1)[1].split()
            if fields[0] in ("Z", "X"):
                return None
            return fields[19]  # Linux process start time, not the reused PID alone.
        return str(pid)
    except (ProcessLookupError, FileNotFoundError):
        return None


def status():
    config = json.loads(config_path.read_text())
    if session_path.exists():
        session = json.loads(session_path.read_text())
        if process_identity(session["pid"]) == session["identity"]:
            config.setdefault("Foreground", {})[session["session"]] = session["config"]
    return config


def occupied(config, port):
    return str(port) in config.get("TCP", {}) or any(
        occupied(child, port) for child in config.get("Foreground", {}).values()
    )


record("tailscale-calls.jsonl", args)
if args == ["status", "--json", "--peers=false"]:
    print(json.dumps({
        "BackendState": "Running",
        "Self": {"DNSName": dns_name + "."},
        "CurrentTailnet": {"MagicDNSSuffix": "example.ts.net", "MagicDNSEnabled": True},
    }))
    sys.exit(0)
if args == ["serve", "status", "--json"]:
    print(json.dumps(status()))
    sys.exit(0)

# No persistent --bg, reset, off, funnel, configuration writes, or arbitrary targets.
serve_args = args.copy()
if len(serve_args) == 5 and serve_args[3] == "--yes":
    serve_args.pop(3)
if len(serve_args) != 4 or serve_args[:2] != ["serve", "--bg=false"]:
    reject("only status and a foreground HTTP proxy are permitted")
port_match = re.fullmatch(r"--http=([1-9][0-9]*)", serve_args[2])
target_match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]*)", serve_args[3])
if not port_match or not target_match:
    reject("expected --http=PORT and an exact loopback backend URL")
port, backend_port = int(port_match[1]), int(target_match[1])
if not (0 < port <= 65535 and 0 < backend_port <= 65535) or port == backend_port:
    reject("the external and backend ports must be distinct and nonzero")
if occupied(status(), port):
    print(f"Serve port {port} is already in use; configuration unchanged", file=sys.stderr)
    sys.exit(1)

# Strip only hop-by-hop headers. In particular, never rewrite Host or Origin.
hop_headers = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}


class Proxy(BaseHTTPRequestHandler):
    def proxy(self):
        record("tailscale-requests.jsonl", {
            "method": self.command, "path": self.path,
            "host": self.headers.get("Host"), "origin": self.headers.get("Origin"),
            "target": serve_args[3],
        })
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        upstream = HTTPConnection("127.0.0.1", backend_port, timeout=95)
        try:
            upstream.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for name, value in self.headers.raw_items():
                if name.lower() not in hop_headers:
                    upstream.putheader(name, value)
            upstream.putheader("Connection", "close")
            upstream.endheaders(body)
            response = upstream.getresponse()
            payload = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in hop_headers | {"content-length"}:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (ConnectionError, OSError) as error:
            self.send_error(502, str(error))
        finally:
            upstream.close()

    do_GET = proxy
    do_POST = proxy

    def log_message(self, *_args):
        pass


# Bind before writing the session: an occupied OS port must not change config either.
try:
    server = ThreadingHTTPServer(("127.0.0.1", port), Proxy)
except OSError as error:
    print(f"Cannot bind fake Serve proxy: {error}", file=sys.stderr)
    sys.exit(1)
server.daemon_threads = True
server.timeout = 0.2
session = {
    "pid": os.getpid(), "identity": process_identity(os.getpid()),
    "session": "fixture-" + uuid.uuid4().hex,
    "port": port, "target": serve_args[3],
    "config": {
        "TCP": {str(port): {"HTTP": True}},
        "Web": {f"{dns_name}:{port}": {"Handlers": {"/": {"Proxy": serve_args[3]}}}},
    },
}
temporary = session_path.with_suffix(".new")
temporary.write_text(json.dumps(session))
temporary.replace(session_path)
stopping = False


def terminate(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    while not stopping:
        server.handle_request()
finally:
    server.server_close()
# Keep the session record for assertions. status() drops dead owners even after SIGKILL,
# when Python cannot run cleanup. This models daemon removal on IPN disconnect.
