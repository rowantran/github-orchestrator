import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, type Message, type Models, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import {
  createRegistry, defineExtension, defineTool, Harness, section,
  watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type EntryRecord, type Extension,
  type HarnessSettings, type ModelRef, type Submission,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { acquireLock, type OwnedLock } from '../../store.js';
import { buildReport, reportDescription, reportKinds, writeReport } from '../report.js';
import type { AgentOptions, WorkerAgent } from '../types.js';

type OpenHarness = Awaited<ReturnType<typeof Harness.open>>;
type Listener = (event: Record<string, unknown>) => void;
type Lifecycle = 'new' | 'starting' | 'ready' | 'closing' | 'closed';
const context = BACKGROUND_CONTEXT;
const toolNames = ['read', 'bash', 'edit', 'write'] as const;
/** Shell metadata that belongs to whichever Pi session launched the service, not to a worker. */
const inheritedPiMetadata = ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'];

/** A resolved model choice for one conversation. */
export interface ModelChoice { model: ModelRef; thinkingLevel?: ModelThinkingLevel }
/** What a worker inherits from the operator's normal Pi configuration for one worktree. */
export interface WorkerResources {
  /** Ordered system prompt sections, already rendered in Pi's format (tags included). */
  sections: Record<string, string>;
  shellPath?: string;
  commandPrefix?: string;
}
/** Process-wide model access and settings shared by every durable worker of a service. */
export interface DurableRuntime {
  readonly models: Models;
  readonly settings: HarnessSettings;
  /** Resolve a Pi model pattern, or the operator's default model when the pattern is absent. */
  resolveModel(pattern: string | undefined): Promise<ModelChoice | undefined>;
  resources(cwd: string, tools: readonly string[]): Promise<WorkerResources>;
}
export interface DurableAgentOptions extends AgentOptions {
  runtime: DurableRuntime | (() => Promise<DurableRuntime>);
}

function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 32); }
function stripHeader(text: string): string { return text.replace(/^<!--[^]*?-->\s*/, '').trim(); }
const tail = (text: string, limit = 8192) => (text.length > limit ? text.slice(-limit) : text);

/**
 * One task role's conversation on Pi Durable, hosted in the service process. The engine drives it through the shared
 * WorkerAgent contract; the conversation, its tool calls, and its queued input live in `<sessionDir>/<sessionId>.sqlite`.
 */
export class DurableAgent implements WorkerAgent {
  readonly options: Readonly<DurableAgentOptions>;
  private lifecycle: Lifecycle = 'new';
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private harness: OpenHarness | undefined;
  private conversation: Conversation | undefined;
  private stream: AgentEventStream | undefined;
  private lock: OwnedLock | undefined;
  private listeners = new Set<Listener>();
  private outstanding = new Set<Promise<unknown>>();
  private settling: Promise<void> | undefined;
  private busy = false;
  private tools = new Map<string, { output: string; emittedAt: number }>();
  private failure: Error | undefined;
  private resumed = false;
  private databasePath = '';

  constructor(options: DurableAgentOptions) {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(options.sessionId)) throw new Error('Invalid Pi session ID');
    if (!options.phaseToken || options.phaseToken.length > 256 || /[\x00-\x1f]/.test(options.phaseToken)) throw new Error('Invalid phase token');
    if (!options.cwd || !options.sessionDir || !options.reportPath) throw new Error('Agent paths are required');
    if (options.role !== 'implementer' && options.role !== 'reviewer') throw new Error('Invalid agent role');
    this.options = Object.freeze({ ...options });
  }

  /** The service process hosts every durable worker. */
  get pid(): number { return process.pid; }
  /** True when opening the conversation found an interrupted run, which continues without a new prompt. */
  get resumedWork(): boolean { return this.resumed; }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): Promise<void> {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') return Promise.reject(new Error('Agent is closed'));
    this.startPromise ??= this.open();
    return this.startPromise;
  }

  private async open(): Promise<void> {
    this.lifecycle = 'starting';
    try {
      const runtime = typeof this.options.runtime === 'function' ? await this.options.runtime() : this.options.runtime;
      const cwd = await realpath(this.options.cwd);
      const sessionDir = resolve(this.options.sessionDir);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(resolve(this.options.reportPath)), { recursive: true, mode: 0o700 });
      const instructions = stripHeader(await readFile(resolve(this.options.instructionsPath), 'utf8'));
      this.cancelled();
      // Same worktree-wide writer lock as RPC workers: one writer per worktree, across services.
      this.lock = await acquireLock(join(cwd, '.gho', 'writer'));
      this.cancelled();
      const resources = await runtime.resources(cwd, toolNames);
      const extension = await this.workerExtension(resources);
      const registry = createRegistry();
      registry.install(extension);
      const env = new NodeExecutionEnv({ cwd, ...(resources.shellPath ? { shellPath: resources.shellPath } : {}) });
      this.databasePath = join(sessionDir, `${this.options.sessionId}.sqlite`);
      this.harness = await Harness.open(await openNodeSqliteStorage(this.databasePath), {
        models: runtime.models, registry, settings: runtime.settings, env: () => env,
        onReport: error => this.emit({ type: 'harness_report', error: errorOf(error).message }),
      }, context);
      this.cancelled();
      this.conversation = await this.harness.root(context);
      const current = await this.conversation.agent(context);
      // Planner and implementer share a conversation; an absent model pattern keeps the conversation's model.
      const choice = this.options.model || !current.model ? await runtime.resolveModel(this.options.model) : undefined;
      if (this.options.model && !choice) throw new Error(`Model not found: ${this.options.model}`);
      await this.conversation.configure({
        cwd, instructions, tools: null,
        ...(choice ? { model: choice.model, ...(choice.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}) } : {}),
      }, context);
      const agent = await this.conversation.agent(context);
      if (!agent.model) throw new Error('No model is available. Configure a default Pi model or set an agents model pattern.');
      this.stream = await watchEvents(this.harness, this.conversation.id, context);
      const snapshot = this.stream.snapshot;
      this.resumed = !!snapshot.run || !!snapshot.generation || snapshot.tools.length > 0 || snapshot.inbox.length > 0;
      this.stream.start(async events => {
        for (const event of events) for (const translated of this.translate(event)) this.emit(translated);
      });
      void this.stream.closed.then(end => {
        if (this.lifecycle === 'ready' || this.lifecycle === 'starting') this.fail(new Error(`Durable event stream ended: ${end.reason}`));
      });
      this.cancelled();
      this.lifecycle = 'ready';
      this.emit({ type: 'driver_ready', pid: process.pid, runtime: 'durable', state: this.state(agent.model, agent.thinkingLevel) });
      if (this.resumed) {
        this.busy = true;
        this.harness.resume();
        this.watchSettlement();
      }
    } catch (error) {
      // close() may already have run while startup was opening resources; release whatever startup still holds.
      await this.close();
      await this.release();
      throw error;
    }
  }

  private cancelled(): void {
    if (this.lifecycle !== 'starting') throw new Error('Agent startup cancelled');
  }

  private async workerExtension(resources: WorkerResources): Promise<Extension> {
    const { role, phaseToken, reportPath, sessionId } = this.options;
    const report = defineTool({
      name: 'gho_report',
      description: await reportDescription(),
      parameters: Type.Object({
        kind: Type.Union(reportKinds.map(kind => Type.Literal(kind))),
        summary: Type.String({ minLength: 1, maxLength: 16384 }),
        findings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 100 })),
      }, { additionalProperties: false }),
      // Writing the same report twice is idempotent; a conflicting report is rejected by writeReport.
      replay: 'safe',
      executionMode: 'sequential',
      execute: async params => {
        const result = buildReport(params, role, phaseToken);
        await writeReport(resolve(reportPath), result);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { ...result }, control: { terminate: true } };
      },
    });
    const bash = createBashTool({
      ...(resources.commandPrefix ? { commandPrefix: resources.commandPrefix } : {}),
      prepare: async (execution, api, callContext) => {
        const agent = await api.agent(callContext);
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !inheritedPiMetadata.includes(key)) env[key] = value;
        env.PI_SESSION_ID = sessionId;
        if (agent.model) { env.PI_PROVIDER = agent.model.provider; env.PI_MODEL = agent.model.modelId; }
        env.PI_REASONING_LEVEL = agent.thinkingLevel;
        Object.assign(env, execution.env);
        execution.env = env;
        execution.inheritEnv = false;
      },
    });
    return defineExtension({
      name: 'gho-worker',
      tools: [createReadTool(), bash, createEditTool(), createWriteTool(), report],
      // Pi's prompt sections are already wrapped in their tags; the conversation's instructions render last.
      sections: Object.entries(resources.sections).map(([key, text]) => section(key, () => text, { tag: false })),
    });
  }

  private translate(event: AgentEvent): Record<string, unknown>[] {
    switch (event.type) {
      case 'snapshot': return [];
      case 'run_start': return [{ type: 'agent_start' }];
      case 'run_end': return [{ type: 'agent_end' }];
      case 'turn_start': case 'turn_end': return [{ type: event.type }];
      case 'message_start':
        return event.message.role === 'system' ? [] : [{ type: 'message_start', message: event.message }];
      case 'message_update':
        return event.changes.flatMap(change => change.type === 'text_delta'
          ? [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: change.delta } }] : []);
      case 'message_end': {
        const message = event.entry.model?.[0];
        return !message || message.role === 'system' ? [] : [{ type: 'message_end', message }];
      }
      case 'tool_execution_start':
        this.tools.set(event.toolCallId, { output: '', emittedAt: 0 });
        return [{ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
      case 'tool_execution_update': {
        const tool = this.tools.get(event.toolCallId) ?? { output: '', emittedAt: 0 };
        if (event.output && 'set' in event.output) tool.output = event.output.set;
        else if (event.output) tool.output = tail(tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? ''), 65_536);
        this.tools.set(event.toolCallId, tool);
        // The journal keeps a bounded, throttled tail; the final result is recorded at tool_execution_end.
        if (Date.now() - tool.emittedAt < 500) return [];
        tool.emittedAt = Date.now();
        return [{ type: 'tool_execution_update', toolCallId: event.toolCallId, toolName: event.toolName,
          partialResult: { content: [{ type: 'text', text: tail(tool.output) }] } }];
      }
      case 'tool_execution_end': {
        this.tools.delete(event.toolCallId);
        const message = event.entry?.model?.[0] as (Message & { role: 'toolResult' }) | undefined;
        return [{ type: 'tool_execution_end', toolCallId: event.toolCallId, toolName: event.toolName,
          result: message ? { content: message.content, details: message.details } : undefined, isError: message?.isError ?? true }];
      }
      case 'auto_retry_start': case 'auto_retry_end': case 'compaction_start': case 'compaction_end': case 'task_failed':
        return [{ ...event }];
      default: return [];
    }
  }

  private emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) {
        if (event.type !== 'driver_error') this.fail(new Error('Agent event listener failed', { cause: error }));
      }
    }
  }

  private ready(): Conversation {
    if (this.failure) throw this.failure;
    if (this.lifecycle !== 'ready' || !this.conversation) throw new Error('Agent is not ready');
    return this.conversation;
  }

  private track(submission: Submission): void {
    this.busy = true;
    const waiting: Promise<unknown> = submission.wait(context).then(settled => {
      if (settled.status === 'unanswered') this.emit({ type: 'submission_unanswered', reason: settled.reason ?? 'unknown' });
    }, () => {}).finally(() => { this.outstanding.delete(waiting); });
    this.outstanding.add(waiting);
    this.watchSettlement();
  }

  /** `agent_settled` means the conversation is idle and no submission of this driver is still unanswered. */
  private watchSettlement(): void {
    if (this.settling) return;
    this.settling = (async () => {
      try {
        for (;;) {
          while (this.outstanding.size) await Promise.allSettled([...this.outstanding]);
          await this.conversation!.waitForIdle(context);
          if (!this.outstanding.size) break;
        }
        if (this.lifecycle !== 'ready') return;
        this.busy = false;
        this.emit({ type: 'agent_settled' });
      } catch (error) {
        if (this.lifecycle === 'ready') this.fail(errorOf(error));
      } finally { this.settling = undefined; }
    })();
  }

  private async submit(text: string, whenBusy: 'steer' | 'followUp'): Promise<{ disposition: 'started' | 'queued' }> {
    const conversation = this.ready();
    const disposition = this.busy ? 'queued' : 'started';
    // The request ID makes a retried delivery of the same text in the same phase exactly-once.
    const submission = await conversation.submit({
      type: 'input', content: text, whenBusy, requestId: `gho:${this.options.phaseToken}:${whenBusy}:${hash(text)}`,
    }, context);
    this.track(submission);
    return { disposition };
  }
  prompt(text: string): Promise<{ disposition: 'started' | 'queued' }> { return this.submit(text, 'followUp'); }
  steer(text: string): Promise<{ disposition: 'started' | 'queued' }> { return this.submit(text, 'steer'); }

  async abort(): Promise<void> { await this.ready().abort(context); }

  /** The full transcript in order, without system prompt entries. */
  async getMessages(): Promise<Message[]> {
    const conversation = this.ready();
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      const page = await conversation.entries({}, 256, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return entries.reverse().flatMap(entry => (entry.model ?? []).filter(message => message.role !== 'system'));
  }

  async getState(): Promise<Record<string, unknown>> {
    const agent = await this.ready().agent(context);
    return this.state(agent.model, agent.thinkingLevel);
  }
  private state(model: ModelRef | undefined, thinkingLevel: string): Record<string, unknown> {
    return {
      sessionId: this.options.sessionId, sessionFile: this.databasePath, thinkingLevel, isStreaming: this.busy,
      isCompacting: false, pendingMessageCount: this.outstanding.size,
      ...(model ? { model: { provider: model.provider, id: model.modelId } } : {}),
    };
  }

  respond(): never { throw new Error('Durable workers do not show interactive dialogs.'); }

  private fail(error: Error): void {
    if (this.failure || this.lifecycle === 'closing' || this.lifecycle === 'closed') return;
    this.failure = error;
    this.emit({ type: 'driver_error', error: error.message });
    void this.close();
  }

  /** Closing leaves unfinished work in storage; the next start resumes it. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.lifecycle = 'closing';
      await this.release();
      this.lifecycle = 'closed';
    })();
    return this.closePromise;
  }
  /** Idempotent: each resource is detached before it is closed, so a late startup step can release its own. */
  private async release(): Promise<void> {
    const errors: unknown[] = [];
    const stream = this.stream, harness = this.harness, lock = this.lock;
    this.stream = undefined; this.harness = undefined; this.lock = undefined;
    try { await stream?.stop(); } catch (error) { errors.push(error); }
    try { await harness?.close(context); } catch (error) { errors.push(error); }
    await this.settling?.catch(() => {});
    try { await lock?.(); } catch (error) { errors.push(error); }
    if (errors.length) this.emit({ type: 'driver_shutdown_error', error: errors.map(error => errorOf(error).message).join('; ') });
  }
}
