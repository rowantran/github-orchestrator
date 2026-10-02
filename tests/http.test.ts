import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { startServer, type DashboardServer, type ServiceAPI } from "../orchestrator/http.js";

const sha = "a".repeat(40);
function service(): { api: ServiceAPI; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record = async (...args: unknown[]) => { calls.push(args); return { ok: true }; };
  const api: ServiceAPI = {
    snapshot: async () => { calls.push(["snapshot"]); return { repo: "test/repo", workstreams: [], tasks: [] }; },
    runs: () => { calls.push(["runs"]); return [{ issue: 42, phase: "planning" }]; },
    getRun: async issue => { calls.push(["getRun", issue]); return issue === 42 ? { issue } : undefined; },
    start: (issue, options) => record("start", issue, options),
    approve: (issue, approved, actor) => record("approve", issue, approved, actor),
    pause: issue => record("pause", issue), resume: issue => record("resume", issue),
    message: (issue, role, text) => record("message", issue, role, text),
    agent: async (issue, role) => { calls.push(["agent", issue, role]); return { role, status: "working", messages: [], events: [], dialogs: [] }; },
    respond: (issue, role, response) => record("respond", issue, role, response),
  };
  return { api, calls };
}
async function query(server: DashboardServer, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(`${server.url.slice(0, -1)}${path}`, {
      method, headers: { "x-gho-token": server.token, ...(data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }), ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(new Response(Buffer.concat(chunks).toString(), { status: response.statusCode, headers: response.headers as Record<string, string> })));
      response.on("error", reject);
    });
    req.on("error", reject); req.end(data);
  });
}
async function raw(server: DashboardServer, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1");
    let output = "";
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("raw request timeout")); });
    socket.on("connect", () => socket.write(source));
    socket.on("data", chunk => { output += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => resolve(output));
  });
}

test("HTTP facade serves only bundled assets with token and security headers", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const page = await fetch(server.url); const html = await page.text();
  assert.match(html, new RegExp(server.token)); assert.match(html, /gho-orchestration/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  for (const asset of ["/app.js", "/style.css"]) assert.equal((await query(server, asset)).status, 200);
  for (const path of ["/package.json", "/api/files?path=/etc/passwd", "/.env", "/api/runs/42/agents/planner", "/api/runs/42/agents/implementer/rpc"]) {
    assert.equal((await query(server, path)).status, 404, path);
  }
  assert.equal(calls.length, 0);
});

test("HTTP facade routes each operation and never reads GitHub while polling runs or agents", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  assert.equal((await query(server, "/api/snapshot")).status, 200);
  assert.equal((await query(server, "/api/runs")).status, 200);
  assert.equal((await query(server, "/api/runs/42")).status, 200);
  assert.equal((await query(server, "/api/runs/99")).status, 404);
  assert.equal((await query(server, "/api/runs/42/agents/implementer")).status, 200);
  for (const [path, body] of [
    ["start", { mode: "supervised" }], ["start", { mode: "unsupervised" }], ["start", {}],
    ["approve", { sha, actor: "dashboard-user" }], ["pause", {}], ["resume", {}],
    ["agents/implementer/messages", { text: "Please add a test." }],
    ["agents/reviewer/messages", { text: "Check the failure path." }],
    ["agents/implementer/responses", { id: "dialog-1", confirmed: true }],
    ["agents/reviewer/responses", { id: "dialog-2", value: "continue" }],
    ["agents/reviewer/responses", { id: "dialog-3", cancelled: true }],
  ] as const) assert.equal((await query(server, `/api/runs/42/${path}`, "POST", body)).status, 200, path);
  assert.deepEqual(calls.filter(call => call[0] === "approve"), [["approve", 42, sha, "dashboard-user"]]);
  assert.deepEqual(calls.filter(call => call[0] === "message"), [["message", 42, "implementer", "Please add a test."], ["message", 42, "reviewer", "Check the failure path."]]);
  assert.equal(calls.filter(call => call[0] === "snapshot").length, 1);
});

test("Host, Origin, token and Fetch Metadata checks are exact and do not trust forwarded headers", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  const origin = server.url.slice(0, -1);
  assert.equal((await query(server, "/api/runs", "GET", undefined, { origin })).status, 200);
  const invalidHeaders: Array<Record<string, string>> = [
    { host: "localhost:" + server.port }, { host: "evil.test", "x-forwarded-host": `127.0.0.1:${server.port}` },
    { origin: "http://evil.test" }, { origin: "null" }, { origin: origin + "/" },
    { origin: origin.replace("http:", "https:") }, { "x-gho-token": "" }, { "x-gho-token": "not-the-token" },
    { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of invalidHeaders) assert.equal((await query(server, "/api/runs", "GET", undefined, headers)).status, 403, JSON.stringify(headers));
  assert.equal((await fetch(server.url + "api/runs")).status, 403);
  assert.equal((await query(server, "/", "GET", undefined, { origin: "http://evil.test" })).status, 403);
  assert.equal(calls.length, 1);
});

test("duplicate sensitive headers and path tricks fail without service side effects", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  for (const extra of [`Host: evil.test\r\n`, `Origin: http://evil.test\r\nOrigin: ${server.url.slice(0, -1)}\r\n`, `X-GHO-Token: ${server.token}\r\n`]) {
    const result = await raw(server, `GET /api/runs HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-GHO-Token: ${server.token}\r\n${extra}Connection: close\r\n\r\n`);
    assert.match(result, /^HTTP\/1\.1 400/);
  }
  for (const path of ["/api/runs/0", "/api/runs/-1", "/api/runs/01", "/api/runs/42/../43", "/api/runs/%34%32", "//api/runs", "http://127.0.0.1/api/runs", "/api/runs/42%2Fstart", "/%2e%2e/package.json"]) {
    const result = await raw(server, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-GHO-Token: ${server.token}\r\nConnection: close\r\n\r\n`);
    assert.match(result, /^HTTP\/1\.1 40[04]/, path);
  }
  assert.equal(calls.length, 0);
});

test("request validation rejects arbitrary commands, paths, invalid modes, short SHAs and malformed dialogs", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  for (const [path, body] of [
    ["start", { mode: "automatic" }], ["start", { path: "/tmp/elsewhere" }], ["start", []],
    ["approve", { sha: "abc123" }], ["approve", { sha, actor: 2 }], ["approve", { sha, command: "bash" }],
    ["pause", { force: true }], ["resume", { session: "/tmp/private" }],
    ["agents/implementer/messages", { text: "  " }], ["agents/reviewer/messages", { text: 42 }],
    ["agents/implementer/responses", { id: "d", type: "bash", command: "ls" }],
    ["agents/implementer/responses", { id: "d" }], ["agents/implementer/responses", { id: "d", value: {} }],
    ["agents/implementer/responses", { id: "d", confirmed: "true" }],
    ["agents/implementer/responses", { cancelled: true }],
  ] as const) assert.equal((await query(server, `/api/runs/42/${path}`, "POST", body)).status, 400, path);
  assert.equal((await query(server, "/api/runs/9007199254740992")).status, 400);
  assert.equal((await query(server, "/api/runs/42/start")).status, 405);
  assert.equal((await query(server, "/api/runs", "POST", {})).status, 405);
  assert.equal((await query(server, "/api/runs/42/start", "POST", {}, { "content-type": "text/plain" })).status, 415);
  const malformed = await fetch(server.url + "api/runs/42/start", { method: "POST", headers: { "x-gho-token": server.token, "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 0);
});

test("body byte limits and absolute read deadlines protect the server", async t => {
  const { api, calls } = service(); const server = await startServer(api, { bodyLimit: 100, bodyTimeoutMs: 100 }); t.after(() => server.close());
  assert.equal((await query(server, "/api/runs/42/agents/implementer/messages", "POST", { text: "💛".repeat(40) })).status, 413);
  const chunked = await raw(server, `POST /api/runs/42/start HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-GHO-Token: ${server.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n65\r\n${"a".repeat(101)}\r\n0\r\n\r\n`);
  assert.match(chunked, /^HTTP\/1\.1 413/);
  const slow = await raw(server, `POST /api/runs/42/start HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-GHO-Token: ${server.token}\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{`);
  assert.match(slow, /^HTTP\/1\.1 408/);
  const incomplete = await raw(server, "GET / HTTP/1.1\r\nHost: ");
  assert.match(incomplete, /^HTTP\/1\.1 408/);
  assert.match(incomplete, /Content-Security-Policy:/);
  assert.match(incomplete, /Request headers timed out/);
  assert.equal(calls.length, 0);
  assert.equal((await query(server, "/api/runs")).status, 200);
});

test("service errors are actionable JSON; stale approval is not silently accepted", async t => {
  const { api } = service();
  api.approve = async () => { throw new Error("Skeleton changed. Refresh and approve the new SHA."); };
  api.snapshot = async () => { throw new Error("GitHub is unavailable. Check gh authentication and retry Refresh."); };
  const server = await startServer(api); t.after(() => server.close());
  const approve = await query(server, "/api/runs/42/approve", "POST", { sha });
  assert.equal(approve.status, 409); assert.match((await approve.json() as { error: string }).error, /Skeleton changed/);
  assert.equal((await query(server, "/api/snapshot")).status, 502);
});

test("snapshot refreshes coalesce; hung service calls have a response deadline without blocking assets", async t => {
  const { api, calls } = service(); let release!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  api.snapshot = async () => { calls.push(["snapshot"]); return pending; };
  const server = await startServer(api, { requestTimeoutMs: 60 }); t.after(() => server.close());
  const first = query(server, "/api/snapshot"), second = query(server, "/api/snapshot");
  assert.equal((await query(server, "/app.js")).status, 200);
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status), [504, 504]);
  assert.equal(calls.length, 1);
  release({ tasks: [] });
  await server.close(); await server.close();
});

test("authenticated health stays local and shutdown acknowledges before closing", async t => {
  const { api, calls } = service();
  let acknowledge!: () => void;
  const stopped = new Promise<void>(resolve => { acknowledge = resolve; });
  let count = 0;
  const server = await startServer(api); t.after(() => server.close());
  assert.equal((await fetch(server.url + "api/health")).status, 403);
  const health = await query(server, "/api/health");
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
  assert.equal(calls.length, 0);
  assert.equal((await query(server, "/api/shutdown", "POST", {})).status, 404);
  api.shutdown = async () => { count++; await server.close(); acknowledge(); };
  assert.equal((await query(server, "/api/shutdown")).status, 405);
  assert.equal((await query(server, "/api/shutdown", "POST", { command: "kill" })).status, 400);
  const response = await query(server, "/api/shutdown", "POST", {});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  await stopped;
  assert.equal(count, 1);
});

test("an explicit GET body is rejected and server closes idle sockets", async t => {
  const { api, calls } = service(); const server = await startServer(api); t.after(() => server.close());
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url + "api/runs", { method: "GET", headers: { "x-gho-token": server.token, "content-length": "2" } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end("{}");
  });
  assert.equal(status, 400); assert.equal(calls.length, 0);
  const socket = connect(server.port, "127.0.0.1");
  await new Promise<void>(resolve => socket.once("connect", resolve));
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  await server.close(); await closed;
});
