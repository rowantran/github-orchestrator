import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, type OwnedLock } from "../../store.js";
import type { AgentOptions, WorkerAgent } from "../types.js";

type RpcChild = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };

/** Wire records remain open to custom Pi extension events and message roles. */
export interface RpcEvent extends Record<string, unknown> { type: string }
export interface PiModel extends Record<string, unknown> { provider: string; id: string; name?: string }
export interface PiState extends Record<string, unknown> {
  sessionId: string;
  sessionFile?: string;
  model?: PiModel;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
}
export interface PromptAcceptance { disposition: "started" | "queued" | "handled" }
export type DialogResponse = { id: string; type?: "extension_ui_response" } & (
  { value: string } | { confirmed: boolean } | { cancelled: true }
);
/** RPC-specific options on top of the shared dispatch inputs. */
export interface PiAgentOptions extends Omit<AgentOptions, "instructionsPath"> {
  /** Optional here so diagnostics and tests can start Pi without role instructions. */
  instructionsPath?: string;
  /** Pi executable; defaults to `pi` on PATH. */
  command?: string;
  /** Prefix arguments, for example a wrapper script, followed by Pi CLI options. */
  args?: string[];
  onEvent?: (event: RpcEvent) => void;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  maxQueuedWriteBytes?: number;
}
interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  remainingMs: number;
  deadline: number;
  pauseForDialogs: boolean;
}
interface PendingDialog {
  request: RpcEvent;
  commandIds: Set<string>;
  blocksDeadlines: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
type Lifecycle = "new" | "starting" | "ready" | "closing" | "closed";
const activeSessions = new Set<string>();
/** Compiled next to this module; loaded explicitly into every RPC worker. */
const extensionPath = fileURLToPath(new URL("./report-extension.js", import.meta.url));
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const dialogs = new Set(["confirm", "select", "input", "editor"]);
const reservedFlags = new Set([
  "--mode", "--session", "--session-id", "--session-dir", "--no-session", "--continue", "-c",
  "--resume", "-r", "--fork", "--print", "-p", "--export", "--",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("RPC limits must be positive integers");
  return value;
}

/** Owns one normal Pi CLI process, not its durable event journal or task state. */
export class PiAgent implements WorkerAgent {
  readonly options: Readonly<PiAgentOptions>;
  private child: RpcChild | undefined;
  private writerLock: OwnedLock | undefined;
  private lifecycle: Lifecycle = "new";
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private exitPromise: Promise<void> | undefined;
  private sessionKey: string | undefined;
  private exited = false;
  private failure: Error | undefined;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: RpcEvent) => void>();
  private dialogRequests = new Map<string, PendingDialog>();
  private frameParts: Buffer[] = [];
  private frameBytes = 0;
  private stderrTail = Buffer.alloc(0);
  private writeTail: Promise<void> = Promise.resolve();
  private queuedWriteBytes = 0;
  private reportReady = false;
  private idle = true;
  private modelChange: Promise<PiState> | undefined;
  private promptRequests = 0;
  private readonly startupTimeout: number;
  private readonly commandTimeout: number;
  private readonly shutdownTimeout: number;
  private readonly frameLimit: number;
  private readonly pendingLimit: number;
  private readonly writeLimit: number;

  constructor(options: PiAgentOptions) {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(options.sessionId)) {
      throw new Error("Invalid Pi session ID");
    }
    if (!options.phaseToken || options.phaseToken.length > 256 || /[\x00-\x1f]/.test(options.phaseToken)) {
      throw new Error("Invalid phase token");
    }
    if (!options.cwd || !options.sessionDir || !options.reportPath) throw new Error("RPC paths are required");
    if (options.role !== "implementer" && options.role !== "reviewer") throw new Error("Invalid agent role");
    for (const arg of options.args ?? []) {
      if (reservedFlags.has(arg.split("=")[0]!)) throw new Error(`Driver owns Pi option: ${arg}`);
    }
    this.options = Object.freeze({ ...options, args: [...(options.args ?? [])] });
    this.startupTimeout = positive(options.startupTimeoutMs, 30_000);
    this.commandTimeout = positive(options.commandTimeoutMs, 30_000);
    this.shutdownTimeout = positive(options.shutdownTimeoutMs, 3_000);
    this.frameLimit = positive(options.maxFrameBytes, 16 * 1024 * 1024);
    this.pendingLimit = positive(options.maxPendingRequests, 64);
    this.writeLimit = positive(options.maxQueuedWriteBytes, 8 * 1024 * 1024);
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  get pid(): number | undefined { return this.child?.pid; }
  /** agent_end never changes this: only agent_settled ends automatic work. */
  get settled(): boolean { return this.idle; }
  get stderr(): string { return this.stderrTail.toString("utf8"); }
  subscribe(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onEvent(listener: (event: RpcEvent) => void): () => void { return this.subscribe(listener); }

  start(): Promise<void> {
    if (this.lifecycle === "closing" || this.lifecycle === "closed") return Promise.reject(new Error("Pi agent is closed"));
    if (this.startPromise) return this.startPromise;
    this.lifecycle = "starting";
    this.startPromise = this.launch().then(() => {});
    return this.startPromise;
  }

  private async launch(): Promise<PiState> {
    try {
      const cwd = await realpath(this.options.cwd);
      const sessionDir = resolve(this.options.sessionDir);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(resolve(this.options.reportPath)), { recursive: true, mode: 0o700 });
      if (this.options.instructionsPath) await access(resolve(this.options.instructionsPath));
      await access(extensionPath);
      if (this.lifecycle !== "starting") throw new Error("Pi startup cancelled");
      const key = JSON.stringify([cwd, await realpath(sessionDir), this.options.sessionId]);
      if (this.lifecycle !== "starting") throw new Error("Pi startup cancelled");
      if (activeSessions.has(key)) throw new Error("Pi session already has a live driver");
      activeSessions.add(key);
      this.sessionKey = key;
      const lock = await acquireLock(join(cwd, ".gho", "writer"));
      if (this.lifecycle !== "starting") { await lock(); throw new Error("Pi startup cancelled"); }
      this.writerLock = lock;
      const args = [
        ...(this.options.args ?? []), "--mode", "rpc", "--session-id", this.options.sessionId,
        "--session-dir", sessionDir, "--extension", extensionPath,
      ];
      if (this.options.instructionsPath) args.push("--append-system-prompt", resolve(this.options.instructionsPath));
      if (this.options.model) args.push("--model", this.options.model);
      const env = {
        ...process.env,
        GHO_REPORT_PATH: resolve(this.options.reportPath),
        GHO_PHASE_TOKEN: this.options.phaseToken,
        GHO_AGENT_ROLE: this.options.role,
        GHO_LOCK_FD: "3",
        GHO_LOCK_PATH: join(cwd, ".gho", "writer", "service.guard"),
      };
      // Do not inherit shell-tool metadata belonging to the orchestrator's session.
      for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
        delete (env as NodeJS.ProcessEnv)[name];
      }
      const child = spawn(this.options.command ?? "pi", args, {
        // fd 3 shares the parent's locked open-file description before Pi opens a session.
        cwd, env, stdio: ["pipe", "pipe", "pipe", lock.fd], detached: process.platform !== "win32",
      }) as RpcChild;
      this.child = child;
      this.exitPromise = new Promise<void>((done) => {
        child.once("error", (error) => { this.fail(error); done(); });
        child.once("exit", (code, signal) => {
          this.exited = true;
          const expected = this.lifecycle === "closing";
          const error = new Error(`Pi exited (${signal ?? code ?? "unknown"})`);
          this.rejectPending(error);
          this.emit({ type: "process_exit", code, signal, expected });
          // Descendants can keep pipe handles open after the immediate child exits.
          this.signalGroup("SIGKILL");
          if (!expected) this.fail(error);
          done();
        });
      });
      child.stdout.on("data", (data: Buffer) => this.consume(data));
      child.stdout.on("end", () => {
        if (this.frameBytes && this.lifecycle !== "closing") this.fail(new Error("Incomplete Pi RPC record"));
      });
      child.stdout.on("error", (error) => this.fail(error));
      child.stdin.on("error", (error) => this.fail(error));
      child.stderr.on("error", (error) => this.fail(error));
      child.stderr.on("data", (data: Buffer) => {
        this.stderrTail = Buffer.concat([this.stderrTail, data]).subarray(-65_536);
      });
      const state = this.validateState(await this.send("get_state", {}, this.startupTimeout));
      if (!this.reportReady) throw new Error("Pi report extension did not initialize");
      if (this.failure) throw this.failure;
      if (this.lifecycle !== "starting") throw new Error("Pi startup cancelled");
      this.idle = !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
      this.lifecycle = "ready";
      this.emit({ type: "driver_ready", pid: child.pid, state });
      return state;
    } catch (error) {
      this.fail(errorOf(error));
      await this.close();
      throw error;
    }
  }

  private emit(event: RpcEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) {
        // A broken journal/UI consumer cannot safely be treated as successful delivery.
        if (event.type !== "driver_error") this.fail(new Error("Pi event listener failed", { cause: error }));
      }
    }
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.frameBytes += part.length;
      if (this.frameBytes > this.frameLimit) { this.fail(new Error("Pi RPC record exceeds byte limit")); return; }
      if (part.length) this.frameParts.push(part);
      if (end < 0) {
        if (this.frameParts.length > 128) this.frameParts = [Buffer.concat(this.frameParts, this.frameBytes)];
        return;
      }
      const record = Buffer.concat(this.frameParts, this.frameBytes).toString("utf8").replace(/\r$/, "");
      this.frameBytes = 0;
      this.frameParts = [];
      if (record) {
        try {
          const event: unknown = JSON.parse(record);
          if (!object(event) || typeof event.type !== "string") throw new Error("Invalid RPC record");
          this.receive(event as RpcEvent);
        } catch (error) { this.fail(new Error("Invalid Pi RPC output", { cause: error })); return; }
      }
      if (this.failure) return;
      start = end + 1;
    }
  }

  private receive(event: RpcEvent): void {
    if (this.lifecycle === "starting" && event.type === "extension_error"
      && typeof event.extensionPath === "string" && resolve(event.extensionPath) === extensionPath) {
      this.emit(event);
      this.fail(new Error(`Pi orchestration extension failed: ${String(event.error)}`));
      return;
    }
    if (event.type === "response") {
      if (typeof event.id !== "string") {
        if (event.success === false) this.fail(new Error("Uncorrelated Pi RPC error"));
        return;
      }
      const pending = this.pending.get(event.id);
      if (!pending) return; // A late response to a timed-out command cannot resolve another request.
      if (event.command !== pending.command || typeof event.success !== "boolean") {
        this.fail(new Error("Mismatched Pi RPC response"));
        return;
      }
      this.pending.delete(event.id);
      clearTimeout(pending.timer);
      for (const dialog of this.dialogRequests.values()) {
        if (dialog.commandIds.delete(event.id) && dialog.commandIds.size === 0) dialog.blocksDeadlines = false;
      }
      this.updateDeadlines();
      if (event.success) pending.resolve(event.data);
      else pending.reject(new Error(typeof event.error === "string" ? event.error : "Pi RPC command failed"));
      return;
    }
    if (event.type === "agent_start") { this.idle = false; this.clearDialogs(); }
    if (event.type === "agent_settled") { this.idle = true; this.clearDialogs(); }
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus" && event.statusKey === "gho:report") {
        if (typeof event.statusText === "string") {
          const status: unknown = JSON.parse(event.statusText);
          this.reportReady = object(status) && status.phaseToken === this.options.phaseToken
            && status.reportPath === resolve(this.options.reportPath);
        }
      }
      if (typeof event.id === "string" && typeof event.method === "string" && dialogs.has(event.method)) {
        if (this.dialogRequests.size >= this.pendingLimit) throw new Error("Too many Pi dialogs");
        const id = event.id;
        const dialog: PendingDialog = {
          request: event, blocksDeadlines: true,
          commandIds: new Set([...this.pending].filter(([, pending]) => pending.pauseForDialogs).map(([id]) => id)),
        };
        if (typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0) {
          dialog.timer = setTimeout(() => this.finishDialog(id), Math.min(event.timeout, 2_147_483_647));
        }
        clearTimeout(this.dialogRequests.get(id)?.timer);
        this.dialogRequests.set(id, dialog);
        this.updateDeadlines();
      }
    }
    this.emit(event);
  }

  private updateDeadlines(): void {
    for (const [id, pending] of this.pending) {
      const paused = pending.pauseForDialogs && [...this.dialogRequests.values()]
        .some((dialog) => dialog.blocksDeadlines && dialog.commandIds.has(id));
      if (paused) {
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = undefined;
          pending.remainingMs = Math.max(1, pending.deadline - performance.now());
        }
      } else if (!pending.timer) {
        pending.deadline = performance.now() + pending.remainingMs;
        pending.timer = setTimeout(() => {
          // Acceptance is uncertain; never retry a possibly accepted prompt automatically.
          this.fail(new Error(`Pi RPC command timed out: ${pending.command}`));
        }, pending.remainingMs);
      }
    }
  }
  private finishDialog(id: string): void {
    clearTimeout(this.dialogRequests.get(id)?.timer);
    this.dialogRequests.delete(id);
    this.updateDeadlines();
  }
  private clearDialogs(): void {
    for (const dialog of this.dialogRequests.values()) clearTimeout(dialog.timer);
    this.dialogRequests.clear();
    this.updateDeadlines();
  }

  private validateState(data: unknown): PiState {
    if (!object(data) || data.sessionId !== this.options.sessionId || typeof data.sessionFile !== "string"
      || typeof data.isStreaming !== "boolean" || typeof data.isCompacting !== "boolean"
      || typeof data.thinkingLevel !== "string" || typeof data.pendingMessageCount !== "number") {
      throw new Error("Pi returned an invalid state or changed session identity");
    }
    return data as PiState;
  }

  private ready(): void {
    if (this.failure) throw this.failure;
    if (this.lifecycle !== "ready") throw new Error("Pi agent is not ready");
  }

  /** Low-level access for diagnostics. Session-replacing commands are deliberately forbidden. */
  async request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    this.ready();
    if (["new_session", "switch_session", "fork", "clone"].includes(type)) {
      throw new Error("Driver session identity cannot change");
    }
    return this.send(type, fields);
  }

  private send(type: string, fields: Record<string, unknown> = {}, timeout = this.commandTimeout): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child || this.exited || this.lifecycle === "closing" || this.lifecycle === "closed") {
      return Promise.reject(new Error("Pi process is not running"));
    }
    if (this.pending.size >= this.pendingLimit) return Promise.reject(new Error("Too many pending Pi RPC commands"));
    const id = `gho-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const pauseForDialogs = type === "prompt" || type === "steer" || (this.lifecycle === "starting" && type === "get_state");
      this.pending.set(id, { command: type, resolve, reject, remainingMs: timeout, deadline: 0, pauseForDialogs });
      if (pauseForDialogs) {
        for (const dialog of this.dialogRequests.values()) if (dialog.blocksDeadlines) dialog.commandIds.add(id);
      }
      this.updateDeadlines();
      void Promise.resolve().then(() => this.write({ ...fields, id, type }))
        .catch((error: unknown) => this.fail(errorOf(error)));
    });
  }

  private write(record: Record<string, unknown>): Promise<void> {
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (this.queuedWriteBytes + line.length > this.writeLimit) {
      return Promise.reject(new Error("Pi RPC write queue exceeds byte limit"));
    }
    this.queuedWriteBytes += line.length;
    const operation = this.writeTail.then(async () => {
      const child = this.child;
      if (!child || this.exited || child.stdin.destroyed || this.failure) throw this.failure ?? new Error("Pi stdin is closed");
      // Serialize until the write callback fires, not merely until write() returns.
      await new Promise<void>((done, reject) => {
        child.stdin.write(line, (error) => { if (error) reject(error); else done(); });
      });
    });
    this.writeTail = operation.catch(() => {}).finally(() => { this.queuedWriteBytes -= line.length; });
    return operation;
  }

  async prompt(text: string): Promise<PromptAcceptance> {
    this.ready();
    if (this.modelChange) throw new Error("Pi model change is in progress");
    this.promptRequests++;
    try { return this.acceptance(await this.send("prompt", { message: text })); }
    finally { this.promptRequests--; }
  }
  async steer(text: string): Promise<PromptAcceptance> {
    this.ready();
    if (this.modelChange) throw new Error("Pi model change is in progress");
    return this.acceptance(await this.send("steer", { message: text }));
  }
  private acceptance(data: unknown): PromptAcceptance {
    if (!object(data) || !["started", "queued", "handled"].includes(String(data.disposition))) {
      throw new Error("Invalid Pi prompt acceptance");
    }
    return data as unknown as PromptAcceptance;
  }
  async getState(): Promise<PiState> { return this.validateState(await this.request("get_state")); }
  async getMessages(): Promise<unknown[]> {
    const data = await this.request("get_messages");
    if (!object(data) || !Array.isArray(data.messages)) throw new Error("Invalid Pi messages response");
    return data.messages;
  }

  setModel(pattern: string): Promise<PiState> {
    try { this.ready(); } catch (error) { return Promise.reject(error); }
    if (this.modelChange) return Promise.reject(new Error("Pi model change is in progress"));
    if (this.promptRequests) return Promise.reject(new Error("Pi prompt acceptance is pending"));
    this.modelChange = this.changeModel(pattern).finally(() => { this.modelChange = undefined; });
    return this.modelChange;
  }
  private async changeModel(pattern: string): Promise<PiState> {
    const previous = await this.getState();
    if (!this.idle || previous.isStreaming || previous.isCompacting || previous.pendingMessageCount) {
      throw new Error("Pi must be settled before switching models");
    }
    const catalog = await this.request("get_available_models");
    if (!object(catalog) || !Array.isArray(catalog.models)) throw new Error("Invalid Pi model catalog");
    const models = catalog.models.filter((model): model is PiModel =>
      object(model) && typeof model.provider === "string" && typeof model.id === "string");
    let query = pattern.trim();
    let thinking: string | undefined;
    // Check a literal ID first: local model IDs can themselves contain colons.
    if (!models.some((model) => model.id === query || `${model.provider}/${model.id}` === query)) {
      const colon = query.lastIndexOf(":");
      if (colon >= 0 && thinkingLevels.has(query.slice(colon + 1))) {
        thinking = query.slice(colon + 1);
        query = query.slice(0, colon);
      }
    }
    if (!query) throw new Error("Model pattern is empty");
    let matches = models.filter((model) => `${model.provider}/${model.id}` === query || model.id === query);
    if (!matches.length) {
      const slash = query.indexOf("/");
      const provider = slash >= 0 ? query.slice(0, slash).toLowerCase() : undefined;
      const name = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
      matches = models.filter((model) => (!provider || model.provider.toLowerCase() === provider)
        && (model.id.toLowerCase().includes(name) || model.name?.toLowerCase().includes(name)));
    }
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous model pattern: ${pattern}` : `Model not found: ${pattern}`);
    const model = matches[0]!;
    await this.request("set_model", { provider: model.provider, modelId: model.id });
    if (thinking !== undefined) {
      const available = await this.request("get_available_thinking_levels");
      if (!object(available) || !Array.isArray(available.levels) || !available.levels.includes(thinking)) {
        throw new Error(`Thinking level is not supported by ${model.provider}/${model.id}: ${thinking}`);
      }
      await this.request("set_thinking_level", { level: thinking });
    }
    const state = await this.getState();
    if (!object(state.model) || state.model.provider !== model.provider || state.model.id !== model.id
      || (thinking !== undefined && state.thinkingLevel !== thinking)) {
      throw new Error("Pi did not apply the requested model/thinking level");
    }
    return state;
  }

  async respond(response: Record<string, unknown>): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child || this.exited || !["starting", "ready"].includes(this.lifecycle)) throw new Error("Pi process is not running");
    if (typeof response.id !== "string") throw new Error("Invalid Pi dialog ID");
    const dialog = this.dialogRequests.get(response.id)?.request;
    if (!dialog) throw new Error("Unknown Pi dialog");
    let payload: Record<string, unknown>;
    if ("cancelled" in response && response.cancelled === true) payload = { cancelled: true };
    else if (dialog.method === "confirm" && "confirmed" in response && typeof response.confirmed === "boolean") {
      payload = { confirmed: response.confirmed };
    } else if (dialog.method !== "confirm" && "value" in response && typeof response.value === "string") {
      if (dialog.method === "select" && (!Array.isArray(dialog.options) || !dialog.options.includes(response.value))) {
        throw new Error("Invalid Pi dialog selection");
      }
      payload = { value: response.value };
    } else throw new Error("Invalid Pi dialog response");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.write({ ...payload, id: response.id, type: "extension_ui_response" }),
        new Promise<never>((_done, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Pi dialog response write timed out");
            this.fail(error);
            reject(error);
          }, this.commandTimeout);
        }),
      ]);
      this.finishDialog(response.id);
    } finally { if (timer) clearTimeout(timer); }
  }

  async abort(): Promise<void> {
    this.ready();
    await this.send("clear_queue");
    await this.send("abort");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private fail(error: Error): void {
    if (this.failure || this.lifecycle === "closing" || this.lifecycle === "closed") return;
    this.failure = error;
    this.rejectPending(error);
    this.emit({ type: "driver_error", error: error.message });
    void this.close();
  }
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") { if (!this.exited) this.child?.kill(signal); }
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.emit({ type: "driver_shutdown_error", error: errorOf(error).message });
    }
  }
  private async exitedWithin(ms: number): Promise<boolean> {
    if (!this.exitPromise || this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((done) => { timer = setTimeout(() => done(false), ms); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycle = "closing";
    this.closePromise = this.shutdown();
    return this.closePromise;
  }
  private async shutdown(): Promise<void> {
    this.rejectPending(this.failure ?? new Error("Pi agent closed"));
    this.clearDialogs();
    this.child?.stdin.end(); // Documented orderly RPC shutdown; do not issue a new prompt.
    if (!(await this.exitedWithin(this.shutdownTimeout))) {
      this.signalGroup("SIGTERM");
      if (!(await this.exitedWithin(this.shutdownTimeout))) {
        this.signalGroup("SIGKILL");
        await this.exitedWithin(this.shutdownTimeout);
      }
    }
    this.signalGroup("SIGKILL");
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.frameParts = [];
    this.frameBytes = 0;
    const lock = this.writerLock;
    this.writerLock = undefined;
    if (lock) {
      if (!this.child?.pid || this.exited) await lock();
      else void this.exitPromise?.then(() => lock()).catch((error: unknown) => {
        this.emit({ type: "driver_shutdown_error", error: errorOf(error).message });
      });
    }
    if (this.sessionKey) activeSessions.delete(this.sessionKey);
    this.lifecycle = "closed";
  }
}
