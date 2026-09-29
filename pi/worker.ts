/** Purpose: explicitly loaded, isolated worker tools and audit. Audience: Pi and maintainers. Injection: reviewed resources only. */
import { writeSync } from "node:fs";
import {
  createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { effectiveContext, readContext, writeEffectiveContext } from "./context.ts";
import { loadResources, TOOL_NAMES, type WorkerResources } from "./resources.ts";

const factories = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

export function createWorkerTools(cwd: string, resources: WorkerResources): ToolDefinition[] {
  return TOOL_NAMES.map((name) => {
    const implementation = factories[name](cwd);
    const definition = resources.tools[name];
    // Do not spread the implementation: its authored descriptions/schema are outside our review surface.
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: structuredClone(definition.promptGuidelines),
      parameters: structuredClone(definition.parameters),
      execute: implementation.execute,
    } as ToolDefinition;
  });
}

export function installWorker(
  pi: ExtensionAPI,
  cwd = process.cwd(),
  resources = loadResources(),
  terminate: (code: number) => never = process.exit,
): void {
  pi.registerFlag("gho-context", { type: "string", description: resources.strings.flags.context });
  for (const tool of createWorkerTools(cwd, resources)) pi.registerTool(tool);
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const { path, context } = readContext(pi.getFlag("gho-context"), ctx.cwd, resources.strings);
      const audit = effectiveContext({
        path, context, cwd: ctx.cwd, toolCwd: cwd, event,
        activeTools: pi.getActiveTools(), allTools: pi.getAllTools(), resources,
      });
      writeEffectiveContext(path, audit, resources.strings);
    } catch (error) {
      // Pi catches lifecycle-handler throws and continues. Exit synchronously instead: no request may follow a failed audit.
      const allowed = Object.values(resources.strings.errors);
      const message = error instanceof Error && allowed.includes(error.message) ? error.message : resources.strings.errors.audit_failed;
      writeSync(2, `${message}\n`);
      terminate(1);
    }
  });
}

export default function worker(pi: ExtensionAPI): void {
  installWorker(pi);
}
