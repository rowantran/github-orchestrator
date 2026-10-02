import type { AgentFactory, AgentRuntime, RuntimeDiagnosis } from './types.js';

export type { AgentFactory, AgentOptions, AgentRuntime, RuntimeDiagnosis, WorkerAgent } from './types.js';

/** Selects the worker runtime. Runtime modules load on demand, so ordinary CLI commands never import Pi. */
export async function createAgentFactory(runtime: AgentRuntime | undefined, checkout: string, log?: (message: string) => void): Promise<AgentFactory> {
  if (runtime === 'rpc') return (await import('./rpc/index.js')).createRpcFactory();
  return (await import('./durable/index.js')).createDurableFactory(checkout, log);
}

/** `gho doctor` checks for the selected runtime. */
export async function diagnoseAgents(runtime: AgentRuntime | undefined, checkout: string, models: Record<string, string | undefined>): Promise<RuntimeDiagnosis> {
  if (runtime === 'rpc') return (await import('./rpc/index.js')).diagnose(checkout);
  return (await import('./durable/index.js')).diagnose(checkout, models);
}
