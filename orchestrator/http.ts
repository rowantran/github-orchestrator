import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Mode, Role } from "./types.js";
import { prepareTailscale, type TailscaleSession } from "./tailscale.js";

export type AgentRole = Role;

/** The HTTP layer never opens sessions, executes commands, or reads worktree paths. */
export interface ServiceAPI {
  snapshot(): Promise<unknown>;
  /** Optional service shutdown. Invoked only after the acknowledgement reaches the client. */
  shutdown?(): Promise<unknown>;
  runs(): unknown[] | Promise<unknown[]>;
  getRun(issue: number): unknown | Promise<unknown>;
  start(issue: number, options: { mode?: Mode }): Promise<unknown>;
  approve(issue: number, sha: string, actor?: string): Promise<unknown>;
  pause(issue: number): Promise<unknown>;
  resume(issue: number): Promise<unknown>;
  message(issue: number, role: AgentRole, text: string): Promise<unknown>;
  agent(issue: number, role: AgentRole): Promise<unknown>;
  respond(issue: number, role: AgentRole, response: Record<string, unknown>): Promise<unknown>;
}

export interface ServerOptions {
  /** Local port; in Tailscale mode this is the tailnet port (default 8080). */
  port?: number;
  tailscaleServe?: boolean;
  bodyLimit?: number;
  bodyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface DashboardServer {
  url: string;
  token: string;
  /** The private loopback listener's port, including in Tailscale mode. */
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function header(request: IncomingMessage, name: string): string | undefined {
  // Node can discard duplicate Host values. Inspect raw headers before trusting any singleton.
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
  }
  if (values.length > 1) throw new HttpError(400, `Duplicate ${name} header is not allowed.`);
  return values[0];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function keys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    throw new HttpError(400, `Unknown request field. Allowed fields: ${allowed.join(", ") || "none"}.`);
  }
}

function jsonBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<Record<string, unknown>> {
  if (header(request, "content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Send this request with Content-Type: application/json.");
  }
  const length = header(request, "content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new HttpError(413, `Request body exceeds the ${limit}-byte limit.`);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new HttpError(408, "Request body timed out. Send a complete JSON request and retry.")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
    };
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
    const aborted = () => fail(new HttpError(400, "Request body was interrupted. Retry the request."));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { fail(new HttpError(413, `Request body exceeds the ${limit}-byte limit.`)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(object(JSON.parse(source)));
      } catch { reject(new HttpError(400, "Invalid JSON body. Send a UTF-8 JSON object.")); }
    };
    request.on("data", data).once("end", end).once("error", fail).once("aborted", aborted);
  });
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
};
function securityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}
function transportError(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) return;
  const body = JSON.stringify({ error: message });
  const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`).join("\r\n");
  socket.end(`HTTP/1.1 ${status} ${status === 408 ? "Request Timeout" : "Bad Request"}\r\n${headers}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
}

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  if (response.destroyed || response.writableEnded) return;
  const data = contentType.startsWith("application/json") ? JSON.stringify(body ?? null) : String(body);
  const writeTimer = setTimeout(() => response.destroy(), 5_000);
  response.once("close", () => clearTimeout(writeTimer));
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(data), "Connection": "close" });
  response.end(data);
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/** Start a token-protected loopback server. Only fixed, bundled assets are served. */
export async function startServer(api: ServiceAPI, options: ServerOptions = {}): Promise<DashboardServer> {
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("port must be between 0 and 65535.");
  const bodyLimit = positiveOption(options.bodyLimit, 64 * 1024, "bodyLimit");
  const bodyTimeout = positiveOption(options.bodyTimeoutMs, 2_000, "bodyTimeoutMs");
  const requestTimeout = positiveOption(options.requestTimeoutMs, 95_000, "requestTimeoutMs");
  const token = randomBytes(32).toString("hex");
  // Resolves in both source (orchestrator/) and compiled (dist/orchestrator/) trees.
  let assetRoot = new URL("../dashboard/", import.meta.url);
  let index: string;
  try { index = await readFile(new URL("index.html", assetRoot), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    assetRoot = new URL("../../dashboard/", import.meta.url);
    index = await readFile(new URL("index.html", assetRoot), "utf8");
  }
  const assets = new Map<string, [string, string]>([
    ["/", ["text/html; charset=utf-8", index.replaceAll("__GHO_TOKEN__", token)]],
    ["/app.js", ["text/javascript; charset=utf-8", await readFile(new URL("app.js", assetRoot), "utf8")]],
    ["/style.css", ["text/css; charset=utf-8", await readFile(new URL("style.css", assetRoot), "utf8")]],
  ]);
  const plan = options.tailscaleServe ? await prepareTailscale(requestedPort) : undefined;
  const authorities = new Set<string>();
  const origins = new Set<string>();
  let snapshotPending: Promise<unknown> | undefined;
  let pendingCalls = 0;
  let shutdownRequested = false;
  const maxPending = 32;
  const sockets = new Set<Socket>();
  const headerTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  let proxy: TailscaleSession | undefined;
  let closing: Promise<void> | undefined;

  const dispatch = async (request: IncomingMessage): Promise<unknown> => {
    const target = request.url ?? "";
    // Do not normalize paths: encoded slashes, dot segments and absolute-form requests must fail.
    if (!target.startsWith("/") || target.startsWith("//") || target.includes("#")) throw new HttpError(400, "Use a dashboard API path, not a URL or filesystem path.");
    const path = target.split("?")[0] ?? "";
    const method = request.method;
    const host = header(request, "host");
    if (!host || !authorities.has(host)) throw new HttpError(403, "Unexpected Host. Open the printed dashboard URL.");
    const origin = header(request, "origin");
    if (origin !== undefined && !origins.has(origin)) throw new HttpError(403, "Cross-origin requests are not allowed. Open the printed dashboard URL.");
    const site = header(request, "sec-fetch-site");
    if (site === "cross-site") throw new HttpError(403, "Cross-site requests are not allowed. Open the dashboard directly.");
    if (path.startsWith("/api/")) {
      const supplied = header(request, "x-gho-token") ?? "";
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        throw new HttpError(403, "Dashboard session expired or token missing. Reload the dashboard page.");
      }
    }
    const asset = assets.get(path);
    if (asset) {
      if (method !== "GET") throw new HttpError(405, "Use GET for dashboard assets.");
      return { asset };
    }
    const route = /^\/api\/runs\/([1-9]\d*)(?:\/(start|approve|pause|resume)|\/agents\/(implementer|reviewer)(?:\/(messages|responses))?)?$/.exec(path);
    if (!["/api/snapshot", "/api/runs", "/api/health", "/api/shutdown"].includes(path) && !route) throw new HttpError(404, "Unknown dashboard endpoint. Check the issue number and agent role.");
    const action = route?.[2];
    const role = route?.[3] as AgentRole | undefined;
    const agentAction = route?.[4];
    const expectedMethod = action || agentAction || path === "/api/shutdown" ? "POST" : "GET";
    if (method !== expectedMethod) throw new HttpError(405, `Use ${expectedMethod} for this endpoint.`);
    const issue = Number(route?.[1]);
    if (route && !Number.isSafeInteger(issue)) throw new HttpError(400, "Issue number must be a positive safe integer.");
    const body = expectedMethod === "POST" ? await jsonBody(request, bodyLimit, bodyTimeout) : {};
    if (expectedMethod === "GET" && (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0)) throw new HttpError(400, "GET requests must not contain a body.");
    if (path === "/api/health") return { data: { ok: true } };
    if (path === "/api/shutdown") {
      keys(body, []);
      if (!api.shutdown) throw new HttpError(404, "Shutdown is not enabled. Stop the service from its terminal.");
      if (shutdownRequested) return { data: { ok: true } };
      shutdownRequested = true;
      return { data: { ok: true }, afterResponse: () => api.shutdown?.() };
    }
    if (pendingCalls >= maxPending) throw new HttpError(503, "The dashboard is busy. Wait for pending operations before retrying.");
    pendingCalls++;
    try {
      if (path === "/api/snapshot") {
        // Concurrent refreshes share one GitHub read. Run/agent polling never calls this method.
        snapshotPending ??= Promise.resolve().then(() => api.snapshot()).finally(() => { snapshotPending = undefined; });
        return { data: await snapshotPending };
      }
      if (path === "/api/runs") return { data: await api.runs() };
      if (action === "start") {
        keys(body, ["mode"]);
        if (body.mode !== undefined && body.mode !== "supervised" && body.mode !== "unsupervised") throw new HttpError(400, "mode must be supervised or unsupervised.");
        return { data: await api.start(issue, { mode: body.mode as "supervised" | "unsupervised" | undefined }) };
      }
      if (action === "approve") {
        keys(body, ["sha", "actor"]);
        if (typeof body.sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(body.sha)) throw new HttpError(400, "Approval requires the full skeleton commit SHA. Refresh the task before approving.");
        if (body.actor !== undefined && (typeof body.actor !== "string" || !body.actor.trim() || body.actor.length > 200)) throw new HttpError(400, "actor must be a nonempty string of at most 200 characters.");
        return { data: await api.approve(issue, body.sha, body.actor as string | undefined) };
      }
      if (action === "pause" || action === "resume") { keys(body, []); return { data: await api[action](issue) }; }
      if (role && agentAction === "messages") {
        keys(body, ["text"]);
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "Enter a nonempty message for the agent.");
        return { data: await api.message(issue, role, body.text) };
      }
      if (role && agentAction === "responses") {
        // Pi extension UI response fields only; never expose arbitrary RPC commands.
        keys(body, ["id", "value", "confirmed", "cancelled"]);
        if (typeof body.id !== "string" || !body.id || body.id.length > 512) throw new HttpError(400, "A dialog response requires its pending dialog id.");
        if (body.value !== undefined && typeof body.value !== "string") throw new HttpError(400, "Dialog value must be a string.");
        if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw new HttpError(400, "Dialog confirmed must be true or false.");
        if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") throw new HttpError(400, "Dialog cancelled must be true or false.");
        if (!["value", "confirmed", "cancelled"].some(key => Object.hasOwn(body, key))) throw new HttpError(400, "Provide a dialog value, confirmation, or cancellation.");
        return { data: await api.respond(issue, role, body) };
      }
      const data = role ? await api.agent(issue, role) : await api.getRun(issue);
      if (data === undefined || data === null) throw new HttpError(404, role ? "This agent is not running. Start the task first." : "No run exists for this issue. Start the task first.");
      return { data };
    } finally { pendingCalls--; }
  };

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    clearTimeout(headerTimers.get(request.socket));
    securityHeaders(response);
    const timer = setTimeout(() => {
      send(response, 504, { error: "The operation timed out. It may still be running; refresh local state before retrying a mutation." });
    }, requestTimeout);
    response.once("close", () => clearTimeout(timer));
    void dispatch(request).then(result => {
      const reply = result as { asset?: [string, string]; data?: unknown; afterResponse?: () => Promise<unknown> | undefined };
      if (reply.afterResponse) response.once("finish", () => {
        setImmediate(() => { void reply.afterResponse?.()?.catch(error => console.error("Dashboard shutdown failed:", error)); });
      });
      if (reply.asset) send(response, 200, reply.asset[1], reply.asset[0]);
      else send(response, 200, reply.data);
    }).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : request.url?.startsWith("/api/snapshot") ? 502 : 409;
      send(response, status, { error: error instanceof Error ? error.message : "Operation failed. Refresh the dashboard and retry." });
    });
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 64;
  server.headersTimeout = bodyTimeout;
  server.requestTimeout = bodyTimeout;
  server.keepAliveTimeout = 1_000;
  server.on("connection", socket => {
    sockets.add(socket);
    // Absolute header deadline, unlike socket.setTimeout's resettable idle timer.
    const timer = setTimeout(() => transportError(socket, 408, "Request headers timed out. Send a complete request and retry."), bodyTimeout);
    socket.once("close", () => { sockets.delete(socket); clearTimeout(timer); });
    headerTimers.set(socket, timer);
  });
  server.on("clientError", (_error, socket) => {
    transportError(socket, 400, "Malformed HTTP request. Send one valid request and retry.");
  });
  const close = (): Promise<void> => closing ??= (async () => {
    await proxy?.close();
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await stopped;
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(plan ? 0 : requestedPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The loopback listener has no port.");
    const authority = `127.0.0.1:${address.port}`;
    authorities.add(authority);
    for (const allowed of plan?.authorities ?? []) authorities.add(allowed);
    for (const allowed of authorities) origins.add(`http://${allowed}`);
    if (plan) {
      if (address.port === plan.port) throw new Error("The private backend received the tailnet port. Restart the dashboard to select a different backend port.");
      proxy = await plan.start(address.port);
      proxy.onExit(() => {
        console.error("Tailscale Serve exited unexpectedly; stopping the dashboard.");
        void close().then(() => api.shutdown?.()).catch(error => console.error("Dashboard shutdown failed:", error));
      });
    }
    return { url: plan?.url ?? `http://${authority}/`, token, port: address.port, close };
  } catch (error) { await close(); throw error; }
}
