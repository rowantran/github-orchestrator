import type { Role } from '../types.js';

/** Selects how the service runs worker agents. */
export type AgentRuntime = 'durable' | 'rpc';

/**
 * The shared contract between the engine and a worker runtime. One instance drives one task role's
 * conversation for one dispatch: the engine starts it, sends the phase prompt or nudges, consumes its
 * events, and closes it. Conversation identity survives instances through `sessionId`/`sessionDir`.
 *
 * Events use Pi coding-agent names. The engine relies on: `driver_ready` (with `state.model`),
 * `agent_settled` (no automatic work remains), `extension_ui_request` (dialogs, RPC only), and
 * `driver_error`/`process_exit` (the worker stopped). Every event is journaled for the dashboard.
 */
export interface WorkerAgent {
  readonly pid?: number;
  /** True when start() found an interrupted turn that continues by itself; the engine must not start another turn. */
  readonly resumedWork?: boolean;
  start(): Promise<void>;
  prompt(text: string): Promise<unknown>;
  steer(text: string): Promise<unknown>;
  /** Stop current work. A runtime that keeps unfinished work across close() must discard it here. */
  abort(): Promise<unknown>;
  /** Release the worker. Durable runtimes may keep unfinished work for the next start(). */
  close(): Promise<void>;
  getMessages(): Promise<unknown>;
  getState(): Promise<unknown>;
  respond(response: Record<string, unknown>): Promise<unknown> | void;
  onEvent(listener: (event: Record<string, unknown>) => void): (() => void) | void;
}

/** Runtime-independent inputs for one dispatch. */
export interface AgentOptions {
  cwd: string;
  sessionId: string;
  sessionDir: string;
  role: Role;
  /** Pi model pattern; absent keeps the conversation's model or uses the operator's Pi default. */
  model?: string;
  /** Role instructions resource from agent-context/runtime/. */
  instructionsPath: string;
  reportPath: string;
  phaseToken: string;
}

export type AgentFactory = (options: AgentOptions) => WorkerAgent;

/** Runtime prerequisites reported by `gho doctor`. */
export interface RuntimeDiagnosis { checks: string[]; warnings: string[] }
