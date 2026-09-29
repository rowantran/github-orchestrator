/** Purpose: load reviewed worker metadata. Audience: maintainers. Injection: selected JSON values only; no resource headers. */
import { readFileSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type WorkerToolName = (typeof TOOL_NAMES)[number];
export interface ToolResource {
  name: WorkerToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: ToolDefinition["parameters"] & { type: "object"; properties: Record<string, unknown>; required?: string[] };
}
export interface WorkerStrings {
  flags: { context: string };
  errors: Record<string, string>;
  audit: { purpose: string; assumptions: string[] };
}
export interface WorkerResources {
  tools: Record<WorkerToolName, ToolResource>;
  strings: WorkerStrings;
}

export function loadResources(root = new URL("../agent-context/", import.meta.url)): WorkerResources {
  const strings = JSON.parse(readFileSync(new URL("strings.json", root), "utf8")) as WorkerStrings;
  const document = JSON.parse(readFileSync(new URL("tool-definitions.json", root), "utf8"));
  const tools = document.tools as WorkerResources["tools"];
  if (document.schema !== 1 || !tools || Object.keys(tools).length !== TOOL_NAMES.length ||
      TOOL_NAMES.some((name) => {
        const entry = tools[name];
        return !entry || entry.name !== name || !entry.label || !entry.description || !entry.promptSnippet ||
          !Array.isArray(entry.promptGuidelines) || entry.promptGuidelines.some((item) => typeof item !== "string") ||
          entry.parameters?.type !== "object";
      })) {
    throw new Error(strings.errors.invalid_resources);
  }
  return { tools, strings: { flags: strings.flags, errors: strings.errors, audit: strings.audit } };
}
