import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { ensureFree, parseServeConfig, prepareTailscale } from "../orchestrator/tailscale.js";
import { startServer, type ServiceAPI } from "../orchestrator/http.js";

const proxy = (port: number, target: string) => ({ TCP: { [port]: { HTTP: true } }, Web: { [`test-node.example.ts.net:${port}`]: { Handlers: { "/": { Proxy: target } } } } });

test("Tailscale Serve parsing fails closed on unknown, malformed and incomplete settings", () => {
  for (const value of [
    [], true, "", { tcp: {} }, { TCP: null }, { Foreground: [] }, { Foreground: { x: {} } },
    { TCP: { 8080: null } }, { TCP: { 8080: {} } }, { TCP: { 8080: { HTTP: true } } },
    { Web: { "node:8080": { Handlers: { "/": { Proxy: "http://localhost:1" } } } } },
    { AllowFunnel: { "node:nope": true } }, { AllowFunnel: { "node:8080": "true" } },
    { Services: { invalid: {} } }, { Services: { "svc:test": { Tun: "yes" } } },
    { Foreground: { session: { ...proxy(8080, "http://127.0.0.1:4444"), Foreground: { another: {} } } } },
  ]) assert.throws(() => parseServeConfig(value), Error, JSON.stringify(value));
  assert.doesNotThrow(() => parseServeConfig(null));
  assert.doesNotThrow(() => parseServeConfig({}));
  const foreground = parseServeConfig({ Foreground: { session: proxy(8080, "http://127.0.0.1:4444") } });
  assert.throws(() => ensureFree(foreground, 8080), /already in use/);
  assert.doesNotThrow(() => ensureFree(foreground, 8081));
  const funnel = parseServeConfig({ AllowFunnel: { "other.example.ts.net:8080": true } });
  assert.throws(() => ensureFree(funnel, 8080), /Funnel/);
  assert.doesNotThrow(() => ensureFree(funnel, 8081));
});

test("Tailscale uses only owned foreground Serve, validates exact hosts, and preserves existing mappings", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "gho-http-tailscale-"));
  const originalPath = process.env.PATH;
  const originalDir = process.env.GHO_HTTP_TAILSCALE_FIXTURE;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (originalDir === undefined) delete process.env.GHO_HTTP_TAILSCALE_FIXTURE; else process.env.GHO_HTTP_TAILSCALE_FIXTURE = originalDir;
    await rm(dir, { recursive: true, force: true });
  });
  const unrelated = proxy(8099, "http://127.0.0.1:5555");
  await writeFile(path.join(dir, "config.json"), JSON.stringify(unrelated));
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ BackendState: "Running", Self: { DNSName: "test-node.example.ts.net." }, CurrentTailnet: { MagicDNSSuffix: "example.ts.net", MagicDNSEnabled: true } }));
  const executable = path.join(dir, "tailscale");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.GHO_HTTP_TAILSCALE_FIXTURE;
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(args) + '\\n');
const read = name => JSON.parse(fs.readFileSync(dir + '/' + name + '.json', 'utf8'));
if (args[0] === 'status') console.log(JSON.stringify(read('status')));
else if (args[0] === 'serve' && args[1] === 'status') console.log(JSON.stringify(read('config')));
else if (args[0] === 'serve' && args[1] === '--bg=false') {
 const port = Number(args[2].split('=')[1]); const target = args[3]; const config = read('config');
 config.Foreground = { owned: { TCP: { [port]: { HTTP: true } }, Web: { ['test-node.example.ts.net:' + port]: { Handlers: { '/': { Proxy: target } } } } } };
 fs.writeFileSync(dir + '/config.json', JSON.stringify(config));
 const timer = setInterval(() => {}, 100);
 process.on('SIGTERM', () => { const config = read('config'); delete config.Foreground; fs.writeFileSync(dir + '/config.json', JSON.stringify(config)); clearInterval(timer); process.exit(0); });
} else { console.error('forbidden command'); process.exit(2); }
`);
  await chmod(executable, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  process.env.GHO_HTTP_TAILSCALE_FIXTURE = dir;
  const plan = await prepareTailscale(0);
  assert.equal(plan.port, 8080); assert.deepEqual(plan.authorities, ["test-node:8080", "test-node.example.ts.net:8080"]);
  const api: ServiceAPI = {
    snapshot: async () => ({}), runs: () => [], getRun: async () => undefined,
    start: async () => ({}), approve: async () => ({}), pause: async () => ({}), resume: async () => ({}),
    message: async () => ({}), agent: async () => ({}), respond: async () => ({}),
  };
  const server = await startServer(api, { tailscaleServe: true }); t.after(() => server.close());
  assert.equal(server.url, "http://test-node:8080/"); assert.notEqual(server.port, 8080);
  const get = (host: string, origin?: string) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.port}/api/runs`, { headers: { host, ...(origin ? { origin } : {}), "x-gho-token": server.token } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end();
  });
  for (const host of ["test-node:8080", "test-node.example.ts.net:8080"]) {
    assert.equal(await get(host, `http://${host}`), 200);
  }
  for (const host of ["test-node:8081", "other.example.ts.net:8080", "test-node.example.ts.net.evil:8080"]) {
    assert.equal(await get(host), 403);
  }
  await server.close();
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")), unrelated);
  const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  assert(calls.some(args => args[0] === "serve" && args[1] === "--bg=false"));
  assert(!calls.some(args => args.some(arg => ["reset", "off", "--bg", "funnel", "sudo", "up"].includes(arg))));
  await writeFile(path.join(dir, "config.json"), JSON.stringify(proxy(8080, "http://127.0.0.1:7777")));
  await assert.rejects(prepareTailscale(8080), /already in use/);
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ BackendState: "Running", Self: { DNSName: "localhost.example.ts.net." }, CurrentTailnet: { MagicDNSSuffix: "example.ts.net", MagicDNSEnabled: true } }));
  await assert.rejects(prepareTailscale(8080), /MagicDNS/);
});
