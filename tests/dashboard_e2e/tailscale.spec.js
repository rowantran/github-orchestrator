import { request } from "node:http";
import { connect } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, processAlive, TAILSCALE_HOST, TAILSCALE_DNS } from "./fixture.js";

test.use({ dashboardMode: "tailscale" });

function proxyRequest(app, { path = "/api/focus", method = "POST", headers = {}, data } = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  // Node's HTTP client does not use Chromium resolver rules. Dial only loopback,
  // but send the real public Host/Origin unchanged through the fake Serve proxy.
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port: app.port, path, method,
      headers: {
        Host: new URL(app.url).host, Origin: new URL(app.url).origin,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Loopback fake Serve request timed out")));
    req.end(body);
  });
}

function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve(true) : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

const serveCalls = (app) => app.calls("tailscale").filter((args) => args[0] === "serve" && args[1] !== "status");
const selections = (app) => app.calls("tmux").filter((args) => args[1].startsWith("select-"));

test("Tailscale short-name URL loads the graph and focuses a real private tmux pane through Serve", async ({ page, app }) => {
  expect(app.url).toBe(`http://${TAILSCALE_HOST}:${app.port}/`);
  const snapshot = await app.open(page);
  await expect(page).toHaveURL(app.url);
  await expect(page.locator("#graph-nodes [data-issue]")).toHaveCount(6);
  expect(snapshot.tasks.map(({ number }) => number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(snapshot.tasks.find(({ number }) => number === 3).panes.map(({ id }) => id).sort())
    .toEqual([app.firstPane, app.secondPane].sort());

  const session = app.serveSession();
  const backend = new URL(session.target);
  expect(backend.hostname).toBe("127.0.0.1");
  expect(Number(backend.port)).toBeGreaterThan(0);
  expect(Number(backend.port)).not.toBe(app.port);
  expect(session.port).toBe(app.port);
  expect(processAlive(session.pid)).toBe(true);
  expect(app.serveStatus()).toEqual({ Foreground: { [session.session]: {
    TCP: { [app.port]: { HTTP: true } },
    Web: { [`${TAILSCALE_DNS}:${app.port}`]: { Handlers: { "/": { Proxy: session.target } } } },
  } } });
  expect(serveCalls(app)).toEqual([["serve", "--bg=false", `--http=${app.port}`, session.target]]);
  expect(app.calls("tailscale")[0]).toEqual(["status", "--json", "--peers=false"]);

  expect(app.activePane()).toBe(app.firstPane);
  const task = page.locator('#graph-nodes [data-issue="3"]');
  await task.focus();
  await task.press("Enter");
  await page.getByLabel("Choose a pane").selectOption(app.secondPane);
  const focused = page.waitForResponse((response) => response.url() === `${app.url}api/focus`);
  await page.getByRole("button", { name: "Focus task pane" }).click();
  const response = await focused;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ issue: 3, pane: app.secondPane });
  expect((await response.request().allHeaders()).origin).toBe(new URL(app.url).origin);
  await expect(page.locator("#focus-result")).toHaveText("Agent pane selected in tmux.");
  expect(app.activePane()).toBe(app.secondPane);
  expect(selections(app).at(-1)).toEqual(["-N", "select-pane", "-t", app.secondPane]);
  expect(app.proxyRequests()).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "GET", path: "/api/snapshot", host: `${TAILSCALE_HOST}:${app.port}`, target: session.target }),
    expect.objectContaining({ method: "POST", path: "/api/focus", host: `${TAILSCALE_HOST}:${app.port}`, origin: new URL(app.url).origin, target: session.target }),
  ]));
});

test("Serve preserves Host and Origin so foreign authorities and missing tokens cannot focus panes", async ({ page, app }) => {
  await app.open(page);
  const token = await page.locator('meta[name="gho-token"]').getAttribute("content");
  const data = { issue: 3, pane: app.secondPane };
  const headers = { "X-GHO-Token": token };
  const attacks = [
    { Host: "attacker.invalid", "X-Forwarded-Host": new URL(app.url).host },
    { Host: `${TAILSCALE_HOST}.attacker.invalid:${app.port}` },
    { Origin: "https://attacker.invalid" },
    { Origin: "null" },
    { Origin: `https://${TAILSCALE_HOST}:${app.port}` },
    { Origin: `http://${TAILSCALE_HOST}:${app.port === 65535 ? 65534 : app.port + 1}` },
  ];
  for (const attack of attacks) {
    const response = await proxyRequest(app, { data, headers: { ...headers, ...attack } });
    expect(response.status, JSON.stringify({ attack, response })).toBe(403);
    const forwarded = app.proxyRequests().at(-1);
    expect(forwarded.host).toBe(attack.Host || new URL(app.url).host);
    expect(forwarded.origin).toBe(attack.Origin || new URL(app.url).origin);
  }
  expect((await proxyRequest(app, { data })).status).toBe(403);
  expect((await proxyRequest(app, { data, headers: { "X-GHO-Token": "wrong" } })).status).toBe(403);
  expect((await proxyRequest(app, { method: "GET", path: "/api/snapshot" })).status).toBe(403);
  expect(selections(app)).toEqual([]);
  expect(app.activePane()).toBe(app.firstPane);

  // The exact validated full node name is also allowed, not a wildcard suffix.
  const fqdn = `${TAILSCALE_DNS}:${app.port}`;
  const accepted = await proxyRequest(app, {
    method: "GET", path: "/api/snapshot", headers: { ...headers, Host: fqdn, Origin: `http://${fqdn}` },
  });
  expect(accepted.status, accepted.text).toBe(200);
  expect(JSON.parse(accepted.text).tasks).toHaveLength(6);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} removes only the owned Serve session and preserves unrelated persistent and foreground mappings`, async ({ page, app }) => {
    await app.open(page);
    const session = app.serveSession();
    const backendPort = Number(new URL(session.target).port);
    const [persistentPort, otherForegroundPort] = [19080, 19081, 19082, 19083]
      .filter((port) => port !== app.port && port !== backendPort);
    const mapping = (port, text) => ({
      TCP: { [port]: { HTTP: true } },
      Web: { [`${TAILSCALE_DNS}:${port}`]: { Handlers: { "/": { Text: text } } } },
    });
    // Simulate other services appearing after startup. Only temporary fixture JSON
    // changes; these unrelated mappings do not create real listeners or CLI sessions.
    const unrelated = {
      ...mapping(persistentPort, "Unrelated persistent service"),
      Foreground: { "other-session": mapping(otherForegroundPort, "Unrelated foreground service") },
    };
    const configPath = join(app.root, "tailscale-config.json");
    const configBytes = JSON.stringify(unrelated, null, 2) + "\n";
    writeFileSync(configPath, configBytes);
    expect(processAlive(app.pid)).toBe(true);
    expect(processAlive(session.pid)).toBe(true);
    expect(app.serveStatus()).toEqual({
      ...unrelated,
      Foreground: { ...unrelated.Foreground, [session.session]: session.config },
    });

    expect(await app.terminate(signal)).toEqual({ code: 0, signal: null });
    await expect.poll(() => processAlive(app.pid)).toBe(false);
    await expect.poll(() => processAlive(session.pid)).toBe(false);
    expect(app.serveStatus()).toEqual(unrelated);
    await expect.poll(() => portClosed(app.port)).toBe(true);
    await expect.poll(() => portClosed(backendPort)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(configBytes);
    expect(serveCalls(app)).toHaveLength(1); // No serve off/reset or persistent mutation.
  });
}

test("an occupied Serve port is refused without replacing another dashboard's foreground session", async ({ page, app }) => {
  await app.open(page);
  const session = app.serveSession();
  const original = app.serveStatus();
  const sessionBytes = readFileSync(join(app.root, "tailscale-session.json"), "utf8");
  const persistentConfig = readFileSync(join(app.root, "tailscale-config.json"), "utf8");
  expect(() => app.cli("dashboard", "--tailscale-serve", "--port", String(app.port)))
    .toThrow(/already in use|occupied/i);
  expect(app.serveStatus()).toEqual(original);
  expect(readFileSync(join(app.root, "tailscale-session.json"), "utf8")).toBe(sessionBytes);
  expect(readFileSync(join(app.root, "tailscale-config.json"), "utf8")).toBe(persistentConfig);
  expect(processAlive(session.pid)).toBe(true);
  expect(serveCalls(app)).toHaveLength(1); // Refusal happens before another Serve child starts.
  expect(selections(app)).toEqual([]);
  await app.open(page); // The first dashboard and proxy remain usable.
});
