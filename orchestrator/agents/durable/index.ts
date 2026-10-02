import type { AgentFactory, RuntimeDiagnosis } from '../types.js';
import { DurableAgent, type DurableRuntime } from './agent.js';
import { PiDurableRuntime } from './pi-runtime.js';

export { DurableAgent, type DurableAgentOptions, type DurableRuntime, type ModelChoice, type WorkerResources } from './agent.js';
export { PiDurableRuntime } from './pi-runtime.js';

/** Service factory: the operator's Pi configuration loads once, on the first dispatch, and is shared by all workers. */
export function createDurableFactory(checkout: string, log: (message: string) => void = () => {}): AgentFactory {
  let runtime: Promise<DurableRuntime> | undefined;
  const load = () => runtime ??= PiDurableRuntime.create(checkout).then(loaded => {
    for (const diagnostic of loaded.diagnostics) log(`Pi ${diagnostic}`);
    return loaded;
  }, error => { runtime = undefined; throw error; });
  return options => new DurableAgent({ ...options, runtime: load });
}

/** Load the Pi configuration like the service does and resolve each role's model, without contacting a model. */
export async function diagnose(checkout: string, models: Record<string, string | undefined>): Promise<RuntimeDiagnosis> {
  const result: RuntimeDiagnosis = { checks: [], warnings: [] };
  let runtime: PiDurableRuntime;
  try { runtime = await PiDurableRuntime.create(checkout); }
  catch (error) {
    result.warnings.push(`Pi Durable workers cannot load the Pi configuration: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  result.checks.push('Pi Durable workers load Pi settings, credentials, providers, context files and skills');
  for (const diagnostic of runtime.diagnostics) result.warnings.push(`Pi ${diagnostic}`);
  for (const [role, pattern] of Object.entries(models)) {
    try {
      const choice = await runtime.resolveModel(pattern);
      if (choice) result.checks.push(`${role} model resolves to ${choice.model.provider}/${choice.model.modelId}`);
      else result.warnings.push(`${role} model: no Pi model is available.`);
    } catch (error) { result.warnings.push(`${role} model: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}
