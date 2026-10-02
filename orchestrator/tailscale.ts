import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
type ObjectMap = Record<string, unknown>;
interface Config { TCP: ObjectMap; Web: ObjectMap; AllowFunnel: ObjectMap; Foreground: Record<string, Config> }
export interface TailscaleSession { close(): Promise<void>; onExit(callback: () => void): void }
export interface TailscalePlan { port: number; authorities: string[]; url: string; start(backendPort: number): Promise<TailscaleSession> }

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function obj(value: unknown): ObjectMap {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid Tailscale status object; refusing to assume a free port.");
  return value as ObjectMap;
}
function fields(value: unknown, allowed: string[]): ObjectMap {
  const item = obj(value);
  ensure(Object.keys(item).every(key => allowed.includes(key)), "Unknown Tailscale Serve status field; refusing to assume a free port. Check the installed Tailscale version.");
  return item;
}
function map(value: ObjectMap, key: string): ObjectMap { return Object.hasOwn(value, key) ? obj(value[key]) : {}; }
function bool(value: ObjectMap, key: string): boolean {
  if (!Object.hasOwn(value, key)) return false;
  ensure(typeof value[key] === "boolean", "Invalid Tailscale boolean setting.");
  return value[key];
}
function str(value: ObjectMap, key: string): string {
  if (!Object.hasOwn(value, key)) return "";
  ensure(typeof value[key] === "string", "Invalid Tailscale string setting.");
  return value[key];
}
function dns(value: string): boolean {
  return value.length > 0 && value.length <= 253 && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
function port(value: string): number {
  ensure(/^[1-9]\d*$/.test(value) && Number(value) <= 65535, "Invalid Tailscale port; refusing to assume a free port.");
  return Number(value);
}
function hostPort(value: string): number {
  const split = value.lastIndexOf(":");
  ensure(split > 0 && dns(value.slice(0, split)), "Invalid Tailscale host:port setting.");
  return port(value.slice(split + 1));
}
function handlers(tcp: ObjectMap, web: ObjectMap): void {
  for (const [key, raw] of Object.entries(tcp)) {
    const tcpPort = port(key);
    const handler = fields(raw, ["HTTP", "HTTPS", "TCPForward", "TerminateTLS", "ProxyProtocol"]);
    const http = bool(handler, "HTTP"), https = bool(handler, "HTTPS"), forward = str(handler, "TCPForward");
    const protocol = Object.hasOwn(handler, "ProxyProtocol") ? handler.ProxyProtocol : 0;
    ensure(Number.isInteger(protocol) && Number(protocol) >= 0 && Number(protocol) <= 2, "Invalid Tailscale proxy protocol.");
    ensure(Number(http) + Number(https) + Number(Boolean(forward)) === 1 && (!str(handler, "TerminateTLS") || forward), "Invalid Tailscale TCP handler.");
    if (http || https) ensure(Object.keys(web).some(key => hostPort(key) === tcpPort), "Incomplete Tailscale web configuration.");
  }
  for (const [key, raw] of Object.entries(web)) {
    const webPort = hostPort(key);
    const tcpHandler = obj(tcp[String(webPort)]);
    ensure(tcpHandler.HTTP === true || tcpHandler.HTTPS === true, "Incomplete Tailscale web configuration.");
    const config = fields(raw, ["Handlers"]);
    const mounts = obj(config.Handlers);
    ensure(Object.keys(mounts).length > 0, "Empty Tailscale web handlers.");
    for (const [mount, rawHandler] of Object.entries(mounts)) {
      const handler = fields(rawHandler, ["Proxy", "Path", "Text", "Redirect", "AcceptAppCaps"]);
      ensure(mount.startsWith("/") && ["Proxy", "Path", "Text", "Redirect"].filter(key => str(handler, key)).length === 1, "Invalid Tailscale HTTP handler.");
      if (Object.hasOwn(handler, "AcceptAppCaps")) ensure(Array.isArray(handler.AcceptAppCaps) && handler.AcceptAppCaps.every(cap => typeof cap === "string" && cap.length > 0), "Invalid Tailscale application capabilities.");
    }
  }
}

/** Parse the closed Serve schema. Unknown shapes fail closed. */
export function parseServeConfig(value: unknown, nested = false): Config {
  const raw = fields(value === null && !nested ? {} : value, ["TCP", "Web", "AllowFunnel", "Foreground", "Services"]);
  const TCP = map(raw, "TCP"), Web = map(raw, "Web"), AllowFunnel = map(raw, "AllowFunnel");
  const foreground = map(raw, "Foreground"), services = map(raw, "Services");
  ensure(!nested || (Object.keys(foreground).length === 0 && Object.keys(services).length === 0 && Object.keys(TCP).length > 0), "Incomplete or nested Tailscale foreground configuration.");
  handlers(TCP, Web);
  for (const [key, enabled] of Object.entries(AllowFunnel)) { hostPort(key); ensure(typeof enabled === "boolean", "Invalid Tailscale Funnel setting."); }
  const Foreground: Record<string, Config> = Object.create(null) as Record<string, Config>;
  for (const [id, config] of Object.entries(foreground)) { ensure(id.length > 0, "Invalid Tailscale foreground session id."); Foreground[id] = parseServeConfig(config, true); }
  for (const [name, config] of Object.entries(services)) {
    ensure(name.startsWith("svc:") && name.length > 4, "Invalid Tailscale service name.");
    const service = fields(config, ["TCP", "Web", "Tun"]), tcp = map(service, "TCP"), web = map(service, "Web");
    ensure(!bool(service, "Tun") || (!Object.keys(tcp).length && !Object.keys(web).length), "Invalid Tailscale service configuration.");
    handlers(tcp, web);
  }
  return { TCP, Web, AllowFunnel, Foreground };
}

export function ensureFree(config: Config, targetPort: number): void {
  noFunnel(config, targetPort);
  ensure(!Object.hasOwn(config.TCP, String(targetPort)), `Tailscale Serve port ${targetPort} is already in use. Choose another port; existing settings were not changed.`);
  for (const child of Object.values(config.Foreground)) ensureFree(child, targetPort);
}
function noFunnel(config: Config, targetPort: number): void {
  for (const [target, enabled] of Object.entries(config.AllowFunnel)) ensure(!enabled || hostPort(target) !== targetPort, `Tailscale Funnel is enabled on port ${targetPort}. Choose another port; no settings were changed.`);
  for (const child of Object.values(config.Foreground)) noFunnel(child, targetPort);
}
async function inspect(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec("tailscale", args, { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`Cannot inspect Tailscale: ${error instanceof Error ? error.message : String(error)}. Check tailscaled, authentication, and this user's operator permission.`);
  }
}
async function config(): Promise<Config> { return parseServeConfig(await inspect(["serve", "status", "--json"])); }

export async function prepareTailscale(requestedPort: number): Promise<TailscalePlan> {
  const targetPort = requestedPort === 0 ? 8080 : requestedPort;
  port(String(targetPort));
  const status = obj(await inspect(["status", "--json", "--peers=false"]));
  ensure(status.BackendState === "Running", "Tailscale is not running. Start tailscaled and authenticate with tailscale up first.");
  const self = obj(status.Self), tailnet = obj(status.CurrentTailnet);
  // Validate ASCII DNS before lowercasing can turn Unicode characters into accepted names.
  const rawName = str(self, "DNSName").replace(/\.$/, ""), rawSuffix = str(tailnet, "MagicDNSSuffix");
  ensure(dns(rawName) && dns(rawSuffix), "Invalid Tailscale DNS name or MagicDNS suffix; refusing to expose the dashboard.");
  const name = rawName.toLowerCase(), suffix = rawSuffix.toLowerCase();
  const short = name.endsWith(`.${suffix}`) ? name.slice(0, -suffix.length - 1) : "";
  ensure(short && !short.includes(".") && short !== "localhost" && !/^\d+$/.test(short) && !/^0x[\da-f]*$/i.test(short) && tailnet.MagicDNSEnabled === true, "Enable MagicDNS and check this node's DNSName before using Tailscale Serve.");
  const authorities = [short, name].map(host => targetPort === 80 ? host : `${host}:${targetPort}`);
  await config().then(value => ensureFree(value, targetPort));
  return {
    port: targetPort, authorities, url: `http://${authorities[0]}/`,
    async start(backendPort) {
      port(String(backendPort));
      ensure(backendPort !== targetPort, "Tailscale's public port must differ from the private backend port.");
      await config().then(value => ensureFree(value, targetPort));
      const target = `http://127.0.0.1:${backendPort}`;
      const child = spawn("tailscale", ["serve", "--bg=false", `--http=${targetPort}`, target], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "", failure: Error | undefined, exited = false, closing = false;
      const listeners = new Set<() => void>();
      const exitedPromise = new Promise<void>(resolve => {
        child.once("error", error => { failure = error; exited = true; resolve(); for (const listener of listeners) listener(); });
        child.once("exit", (code, signal) => { exited = true; failure ??= new Error(`Tailscale Serve exited (${code ?? signal}). ${stderr}`); resolve(); for (const listener of listeners) listener(); });
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
      const session: TailscaleSession = {
        async close() {
          if (closing) { await exitedPromise; return; }
          closing = true;
          if (!exited) child.kill("SIGTERM");
          const kill = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1_000);
          try { await exitedPromise; } finally { clearTimeout(kill); child.stderr?.destroy(); }
        },
        onExit(callback) { listeners.add(() => { if (!closing) callback(); }); if (exited && !closing) callback(); },
      };
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (failure) throw failure;
          const current = await config();
          noFunnel(current, targetPort);
          if (failure) throw failure;
          const match = Object.values(current.Foreground).some(value => {
            const tcp = value.TCP[String(targetPort)] as ObjectMap | undefined;
            const web = value.Web[`${name}:${targetPort}`] as ObjectMap | undefined;
            const mounts = web?.Handlers as ObjectMap | undefined;
            const root = mounts?.["/"] as ObjectMap | undefined;
            return tcp?.HTTP === true && root?.Proxy === target;
          });
          if (match) return session;
          await delay(50);
        }
        throw new Error(`Tailscale Serve did not confirm its foreground mapping. Check tailscale serve status --json, operator permission, and port ${targetPort}. ${stderr}`);
      } catch (error) { await session.close(); throw error; }
    },
  };
}
