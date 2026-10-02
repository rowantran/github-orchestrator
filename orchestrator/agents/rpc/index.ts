import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentFactory, RuntimeDiagnosis } from '../types.js';
import { PiAgent, type PiAgentOptions } from './agent.js';

export { PiAgent, type DialogResponse, type PiAgentOptions, type PiModel, type PiState, type PromptAcceptance, type RpcEvent } from './agent.js';

/** Service factory: one `pi --mode rpc` process per dispatch. */
export function createRpcFactory(defaults: Pick<PiAgentOptions, 'command' | 'args'> = {}): AgentFactory {
  return options => new PiAgent({ ...defaults, ...options });
}

/** RPC workers need the Pi CLI on PATH. */
export async function diagnose(cwd: string): Promise<RuntimeDiagnosis> {
  try {
    await promisify(execFile)('pi', ['--version'], { cwd, timeout: 15_000 });
    return { checks: ['Pi available'], warnings: [] };
  } catch { return { checks: [], warnings: ['Pi is not available on PATH; install Pi before starting agents.'] }; }
}
