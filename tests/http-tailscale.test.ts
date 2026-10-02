import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { prepareTailscale } from "../orchestrator/tailscale.js";
import { startServer, type DashboardServer, type ServiceAPI } from "../orchestrator/http.js";

const dns = "test-node.example.ts.net";
const nodeStatus = (name = `${dns}.`, suffix = "example.ts.net", enabled = true) => ({
  BackendState: "Running", Self: { DNSName: name }, CurrentTailnet: { MagicDNSSuffix: suffix, MagicDNSEnabled: enabled },
});
const proxy = (port: number, target: string) => ({ TCP: { [port]: { HTTP: true } }, Web: { [`${dns}:${port}`]: { Handlers: { "/": { Proxy: target } } } } });
const unrelated = { ...proxy(8099, "http://127.0.0.1:5555"), Foreground: { existing: proxy(8098, "http://127.0.0.1:5556") } };
const api = (): ServiceAPI => ({
  snapshot: async () => ({}), runs: () => [], getRun: async () => undefined,
  start: async () => ({}), approve: async () => ({}), pause: async () => ({}), resume: async () => ({}),
  message: async () => ({}), agent: async () => ({}), respond: async () => ({}),
});

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await check()) { assert(Date.now() < deadline, message); await delay(10); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

// Tests in this file run serially. PATH contains only this fake, with an absolute Node shebang:
// even a missing executable cannot fall through to a real Tailscale command.
async function fixture(t: TestContext, mode = "ready") {
  const dir = await mkdtemp(path.join(tmpdir(), "gho-http-tailscale-"));
  const originalPath = process.env.PATH;
  const cleanup: Array<() => Promise<void>> = [];
  const file = (name: string) => path.join(dir, name);
  const put = (name: string, value: unknown) => writeFile(file(name), JSON.stringify(value));
  const read = async (name: string) => JSON.parse(await readFile(file(name), "utf8"));
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      // Also reap a leaked fake if an assertion fails before it can register normal cleanup.
      try {
        const { pid } = await read("child.json") as { pid: number };
        if (alive(pid)) { process.kill(pid, "SIGKILL"); await until(async () => !alive(pid), "fake did not exit"); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally {
        if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  await put("config.json", unrelated);
  await put("status.json", nodeStatus());
  await writeFile(file("tailscale"), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)}, mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(dir + '/' + name + '.json', 'utf8'));
const exists = name => fs.existsSync(dir + '/' + name);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(['status', '--json', '--peers=false'])) {
  process.stdout.write(fs.readFileSync(dir + '/status.json'));
} else if (JSON.stringify(args) === JSON.stringify(['serve', 'status', '--json'])) {
  if (mode === 'malformed' && exists('child.json')) { console.log('{"Foreground":[]}'); process.exit(0); }
  const config = read('config');
  if (exists('session.json')) {
    const session = read('session');
    config.Foreground = { ...config.Foreground, owned: session };
    if (mode === 'funnel') config.AllowFunnel = { ['other.example.ts.net:' + read('child').port]: true };
  }
  console.log(JSON.stringify(config));
} else if (args.length === 4 && args[0] === 'serve' && args[1] === '--bg=false' && /^--http=[0-9]+$/.test(args[2]) && /^http:\\/\\/127\\.0\\.0\\.1:[0-9]+$/.test(args[3])) {
  const port = Number(args[2].split('=')[1]), target = args[3];
  const stop = () => { fs.rmSync(dir + '/session.json', { force: true }); process.exit(0); };
  process.on('SIGTERM', mode === 'ignore-term' ? () => {} : stop);
  fs.writeFileSync(dir + '/child.json', JSON.stringify({ pid: process.pid, port, target }));
  if (mode === 'failure') { console.error('Access denied: check operator permission'); process.exit(1); }
  if (mode === 'clean-exit') process.exit(0);
  if (mode === 'chatty') process.stderr.write('x'.repeat(200000));
  const session = { TCP: { [port]: { HTTP: true } }, Web: { [${JSON.stringify(dns)} + ':' + port]: { Handlers: { '/': { Proxy: mode === 'unconfirmed' ? target + '/wrong' : target } } } } };
  fs.writeFileSync(dir + '/session.tmp', JSON.stringify(session));
  fs.renameSync(dir + '/session.tmp', dir + '/session.json');
  setInterval(() => { if (exists('exit')) stop(); }, 10);
  setTimeout(stop, 30000);
} else { console.error('FORBIDDEN COMMAND: ' + JSON.stringify(args)); process.exit(90); }
`);
  await chmod(file("tailscale"), 0o755);
  process.env.PATH = dir;
  const calls = async () => (await readFile(file("calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  return { file, put, read, calls, cleanup,
    stopped: async (expected = unrelated) => {
      const { pid } = await read("child.json") as { pid: number };
      assert.equal(alive(pid), false, "owned Serve child must be reaped");
      assert.equal(await readFile(file("config.json"), "utf8"), JSON.stringify(expected));
      const commands = await calls();
      assert(commands.every(args => JSON.stringify(args) === JSON.stringify(["status", "--json", "--peers=false"])
        || JSON.stringify(args) === JSON.stringify(["serve", "status", "--json"])
        || (args.length === 4 && args[0] === "serve" && args[1] === "--bg=false")));
      assert.equal(commands.filter(args => args[1] === "--bg=false").length, 1);
    },
  };
}

function query(server: Pick<DashboardServer, "url" | "port" | "token">, headers: Record<string, string> = {}, mutation = false): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.port}${mutation ? "/api/runs/42/pause" : "/api/runs"}`, {
      method: mutation ? "POST" : "GET",
      headers: { host: new URL(server.url).host, "x-gho-token": server.token, ...(mutation ? { "content-type": "application/json" } : {}), ...headers },
    }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.setTimeout(2_000, () => req.destroy(new Error("request timed out"))); req.end(mutation ? "{}" : undefined);
  });
}

test("Tailscale preflight is read-only and normalizes only valid exact node identities", async t => {
  const f = await fixture(t);
  await f.put("status.json", nodeStatus("TEST-NODE.EXAMPLE.TS.NET.", "EXAMPLE.TS.NET"));
  for (const [port, suffix] of [[0, ":8080"], [80, ""], [8181, ":8181"]] as const) {
    const plan = await prepareTailscale(port);
    assert.equal(plan.port, port || 8080);
    assert.deepEqual(plan.authorities, [`test-node${suffix}`, `${dns}${suffix}`]);
    assert.equal(plan.url, `http://test-node${suffix}/`);
  }
  for (const value of [
    {}, { BackendState: "NeedsLogin" }, { BackendState: "Running" }, nodeStatus(dns, "example.ts.net", false),
    ...["", "node", "node.other.net", "child.node.example.ts.net", "-node.example.ts.net", "node..example.ts.net",
      "node.example.ts.net..", "http://node.example.ts.net", "node@.example.ts.net", "nöde.example.ts.net",
      "localhost.example.ts.net", "123.example.ts.net", "0x7f000001.example.ts.net", "node\n.example.ts.net",
      "K.example.ts.net"].map(name => nodeStatus(name)),
    nodeStatus("node.example.ts.net\n", "example.ts.net\n"), nodeStatus("node.K.ts.net", "K.ts.net"),
  ]) {
    await f.put("status.json", value);
    await assert.rejects(prepareTailscale(8080), Error, JSON.stringify(value));
  }
  await f.put("status.json", nodeStatus());
  for (const port of [-1, 65536, 1.5, NaN]) await assert.rejects(prepareTailscale(port), /port/);
  assert((await f.calls()).every(args => args[0] === "status" || args[1] === "status"));
});

test("invalid status JSON and a missing executable fail without falling through to real Tailscale", async t => {
  const f = await fixture(t);
  await writeFile(f.file("status.json"), "{");
  await assert.rejects(prepareTailscale(8080), /Cannot inspect Tailscale:.*Check tailscaled/);
  await rm(f.file("tailscale"));
  await assert.rejects(prepareTailscale(8080), /Cannot inspect Tailscale:.*ENOENT/);
  await assert.rejects(readFile(f.file("child.json")), { code: "ENOENT" });
});

test("occupied ports, Funnel and changed preflight refuse startup without touching other mappings", async t => {
  const f = await fixture(t);
  const plan = await prepareTailscale(8080);
  for (const config of [
    proxy(8080, "http://127.0.0.1:7777"),
    { Foreground: { existing: { TCP: { 8080: { TCPForward: "127.0.0.1:7777" } } } } },
    { AllowFunnel: { "other.example.ts.net:8080": true } },
    { Foreground: { existing: { ...proxy(9000, "http://127.0.0.1:7777"), AllowFunnel: { "other:8080": true } } } },
    { Foreground: [] },
  ]) {
    await f.put("config.json", config);
    await assert.rejects(prepareTailscale(8080), /already in use|Funnel|Invalid/);
    await assert.rejects(plan.start(4321), /already in use|Funnel|Invalid/);
    assert.deepEqual(await f.read("config.json"), config);
  }
  await f.put("config.json", unrelated);
  for (const backend of [0, -1, 65536, 1.5, NaN, 8080]) await assert.rejects(plan.start(backend), /port/);
  assert((await f.calls()).every(args => args[0] === "status" || args[1] === "status"));
});

test("tailnet HTTP requires exact Host/Origin and a token before reads or mutations", async t => {
  const f = await fixture(t);
  let reads = 0, mutations = 0;
  const service = api(); service.runs = () => { reads++; return []; }; service.pause = async () => { mutations++; return {}; };
  const server = await startServer(service, { tailscaleServe: true }); f.cleanup.push(() => server.close());
  assert.equal(server.url, "http://test-node:8080/"); assert.notEqual(server.port, 8080);
  const child = await f.read("child.json") as { target: string };
  assert.equal(child.target, `http://127.0.0.1:${server.port}`);
  for (const host of ["test-node:8080", `${dns}:8080`, `127.0.0.1:${server.port}`]) {
    for (const mutation of [false, true]) assert.equal(await query(server, { host, origin: `http://${host}` }, mutation), 200);
  }
  const invalid: Array<Record<string, string>> = [
    ...["test-node:8081", "test-node", "other.example.ts.net:8080", `child.${dns}:8080`, `${dns}.evil:8080`, "*.example.ts.net:8080"].map(host => ({ host })),
    { host: "attacker.invalid", "x-forwarded-host": "test-node:8080", forwarded: 'host="test-node:8080";proto=http' },
    ...["null", "http://other.example.ts.net:8080", "https://test-node:8080", "http://test-node:8081", "http://test-node:8080/"].map(origin => ({ origin })),
    { "x-gho-token": "" }, { "x-gho-token": "wrong" }, { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of invalid) {
    for (const mutation of [false, true]) assert.equal(await query(server, headers, mutation), 403, JSON.stringify(headers));
  }
  assert.equal(reads, 3); assert.equal(mutations, 3);
  // A second dashboard cannot displace this foreground session.
  const session = await readFile(f.file("session.json"), "utf8");
  await assert.rejects(startServer(api(), { tailscaleServe: true }), /already in use/);
  assert.equal(await readFile(f.file("session.json"), "utf8"), session);
  assert.equal(await query(server), 200);
  // Other mappings added after startup also remain untouched by shutdown.
  const updated = { ...unrelated, Foreground: { ...unrelated.Foreground, later: proxy(8097, "http://127.0.0.1:5557") } };
  await f.put("config.json", updated);
  await Promise.all([server.close(), server.close()]);
  assert.deepEqual(await f.read("config.json"), updated);
  await assert.rejects(readFile(f.file("session.json")), { code: "ENOENT" });
  await assert.rejects(query(server), { code: "ECONNREFUSED" });
  await f.stopped(updated);
});

test("startup failures close the backend, reap Serve and preserve unrelated mappings", async t => {
  for (const [mode, error] of [["failure", /Access denied/], ["clean-exit", /exited/], ["malformed", /Invalid/], ["funnel", /Funnel/], ["unconfirmed", /did not confirm/]] as const) {
    await t.test(mode, async t => {
      const f = await fixture(t, mode);
      await assert.rejects(startServer(api(), { tailscaleServe: true }), error);
      await f.stopped();
      const { target } = await f.read("child.json") as { target: string };
      await assert.rejects(query({ url: target, port: Number(new URL(target).port), token: "unused" }), { code: "ECONNREFUSED" });
      await assert.rejects(readFile(f.file("session.json")), { code: "ENOENT" });
    });
  }
});

test("Serve exit stops an idle HTTP server and calls service shutdown", async t => {
  const f = await fixture(t);
  let shutdowns = 0;
  const service = api(); service.shutdown = async () => { shutdowns++; };
  const server = await startServer(service, { tailscaleServe: true }); f.cleanup.push(() => server.close());
  await writeFile(f.file("exit"), "");
  await until(async () => shutdowns === 1, "Serve exit did not stop the dashboard");
  await assert.rejects(query(server), { code: "ECONNREFUSED" });
  await server.close();
  await f.stopped();
});

test("closing owned Serve drains noisy stderr, escalates ignored SIGTERM and does not report unexpected exit", async t => {
  for (const mode of ["chatty", "ignore-term"]) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    const session = await (await prepareTailscale(8080)).start(4321); f.cleanup.push(() => session.close());
    let exits = 0; session.onExit(() => { exits++; });
    await Promise.all([session.close(), session.close()]);
    session.onExit(() => { exits++; });
    assert.equal(exits, 0);
    await f.stopped();
  });
});
