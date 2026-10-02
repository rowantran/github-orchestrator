import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { HarnessSettings } from '@earendil-works/pi-durable';
import {
  createAgentSessionServices, createBashToolDefinition, createEditToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, DefaultResourceLoader, resolveCliModel, SettingsManager, type AgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import type { DurableRuntime, ModelChoice, WorkerResources } from './agent.js';

/**
 * The operator's normal Pi configuration, without Pi's agent loop: models and credentials (including providers
 * registered by installed Pi extensions), settings, AGENTS.md/context files, skills, SYSTEM.md and APPEND_SYSTEM.md.
 * Pi extension tools, hooks, commands and dialogs are not run by durable workers.
 */
type PromptSections = (input: Record<string, unknown>) => Record<string, string>;
interface HttpDispatcher {
  applyHttpProxySettings(proxy: string | undefined): void;
  configureHttpDispatcher(timeoutMs: number): void;
}

/** Pi exports no prompt builder; load the module of the exact pinned Pi version, or fail clearly. */
async function piModule<T>(relative: string): Promise<T> {
  const base = import.meta.resolve('@earendil-works/pi-coding-agent');
  try { return await import(new URL(relative, base).href) as T; }
  catch (error) { throw new Error(`Pi module ${relative} is unavailable; reinstall the pinned @earendil-works/pi-coding-agent version.`, { cause: error }); }
}

const definitions = { read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition };

export class PiDurableRuntime implements DurableRuntime {
  readonly settings: HarnessSettings;
  private constructor(private readonly services: AgentSessionServices, private readonly buildSections: PromptSections,
    readonly diagnostics: string[]) {
    const settings = services.settingsManager;
    // Read at every use, so later settings reads stay live like Pi's own session settings.
    this.settings = {
      get stream() {
        const provider = settings.getProviderRetrySettings();
        const idle = settings.getHttpIdleTimeoutMs();
        return {
          timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
          maxRetryDelayMs: provider.maxRetryDelayMs,
          ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
        };
      },
      get compaction() { return settings.getCompactionSettings(); },
      get retry() { return settings.getRetrySettings(); },
      get steeringMode() { return settings.getSteeringMode(); },
      get followUpMode() { return settings.getFollowUpMode(); },
    };
  }

  /** Load once per service process. `agentDir` defaults to Pi's own (PI_CODING_AGENT_DIR or ~/.pi/agent). */
  static async create(cwd: string, agentDir?: string): Promise<PiDurableRuntime> {
    const services = await createAgentSessionServices({ cwd, ...(agentDir ? { agentDir } : {}) });
    const http = await piModule<HttpDispatcher>('./core/http-dispatcher.js');
    // Pi's HTTP setup: proxy and idle timeouts. Without it, long provider streams can end early.
    http.applyHttpProxySettings(services.settingsManager.getGlobalSettings().httpProxy);
    http.configureHttpDispatcher(services.settingsManager.getHttpIdleTimeoutMs());
    const prompt = await piModule<{ buildSystemPromptSections: PromptSections }>('./core/system-prompt.js');
    const extensions = services.resourceLoader.getExtensions();
    const diagnostics = [
      ...services.diagnostics.map(item => `${item.type}: ${item.message}`),
      ...extensions.errors.map(item => `error: extension ${item.path}: ${String(item.error)}`),
    ];
    return new PiDurableRuntime(services, prompt.buildSystemPromptSections, diagnostics);
  }

  get models() { return this.services.modelRuntime; }

  async resolveModel(pattern: string | undefined): Promise<ModelChoice | undefined> {
    const settings = this.services.settingsManager;
    const thinking = (level: string | undefined) => level as ModelThinkingLevel | undefined;
    if (pattern) {
      const resolved = resolveCliModel({ cliModel: pattern, modelRuntime: this.services.modelRuntime });
      if (resolved.error || !resolved.model) throw new Error(`Cannot resolve model ${pattern}: ${resolved.error ?? 'not found'}`);
      // Pi's CLI can synthesize an unlisted model ID; a durable conversation stores only registered models.
      if (!this.services.modelRuntime.getModel(resolved.model.provider, resolved.model.id)) {
        throw new Error(`Cannot resolve model ${pattern}: ${resolved.warning ?? 'the provider does not list this model'}`);
      }
      return { model: { provider: resolved.model.provider, modelId: resolved.model.id },
        thinkingLevel: thinking(resolved.thinkingLevel ?? settings.getDefaultThinkingLevel()) };
    }
    const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
    if (provider && id) {
      const model = this.services.modelRuntime.getModel(provider, id);
      if (model) return { model: { provider, modelId: id }, thinkingLevel: thinking(settings.getDefaultThinkingLevel()) };
    }
    const [first] = await this.services.modelRuntime.getAvailable();
    return first ? { model: { provider: first.provider, modelId: first.id }, thinkingLevel: thinking(settings.getDefaultThinkingLevel()) } : undefined;
  }

  async resources(cwd: string, tools: readonly string[]): Promise<WorkerResources> {
    const settingsManager = SettingsManager.create(cwd, this.services.agentDir);
    const loader = new DefaultResourceLoader({
      cwd, agentDir: this.services.agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    const toolSnippets: Record<string, string> = {}, toolGuidelines: Record<string, string[]> = {};
    for (const name of tools) {
      const create = definitions[name as keyof typeof definitions];
      if (!create) continue;
      const definition = create(cwd) as { promptSnippet?: string; promptGuidelines?: string[] };
      if (definition.promptSnippet) toolSnippets[name] = definition.promptSnippet;
      if (definition.promptGuidelines) toolGuidelines[name] = [...definition.promptGuidelines];
    }
    const append = loader.getAppendSystemPrompt();
    const sections = this.buildSections({
      cwd, selectedTools: [...tools], toolSnippets, toolGuidelines,
      ...(loader.getSystemPrompt() ? { customPrompt: loader.getSystemPrompt() } : {}),
      ...(append.length ? { appendSystemPrompt: append.join('\n\n') } : {}),
      contextFiles: loader.getAgentsFiles().agentsFiles, skills: loader.getSkills().skills,
    });
    const shellPath = settingsManager.getShellPath(), commandPrefix = settingsManager.getShellCommandPrefix();
    return { sections, ...(shellPath ? { shellPath } : {}), ...(commandPrefix ? { commandPrefix } : {}) };
  }
}
