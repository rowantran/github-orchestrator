import { createHash } from "node:crypto";

export const BRIDGE = ".github-orchestrator";
export const START = "<!-- github-orchestrator:links:start -->";
export const END = "<!-- github-orchestrator:links:end -->";
export const SOURCE = "github-orchestrator";
export const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface Link {
  id: string;
  notePath: string;
  notionPageId?: string;
  issueUrls: string[];
}
export interface Registry { schemaVersion: 1; links: Link[] }
export interface CompletionRequest {
  schemaVersion: 1;
  id: string;
  linkId: string;
  issueUrls: string[];
  issueFingerprint: string;
  requestedAt: string;
}
export type ReceiptStatus =
  | "processing" | "local-accepted" | "already-done" | "api-unavailable"
  | "stale" | "failed" | "rolled-back" | "interrupted";
export interface Receipt {
  schemaVersion: 1;
  requestId: string;
  linkId: string;
  issueFingerprint: string;
  status: ReceiptStatus;
  detail: string;
  recordedAt: string;
  notionConfirmed: false;
  notePath?: string;
}

export function notePath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:\x00\r\n]/.test(value)
      || value.split("/").some(p => !p || p === ".." || p.startsWith("."))
      || !value.toLowerCase().endsWith(".md")) {
    throw new Error("Use a vault-relative task Markdown path without traversal or hidden folders.");
  }
  return value;
}

export function notionId(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)) {
    throw new Error("Invalid notion_page_id.");
  }
  const compact = value.replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function issueUrls(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string"
      || !/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(v)
      || v.split("/").slice(3, 5).some((p: string) => p === "." || p === ".."))) {
    throw new Error("Issue URLs must be a nonempty canonical GitHub issue list.");
  }
  const sorted = [...new Set(value as string[])].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(value)) throw new Error("Issue URLs must be unique and sorted.");
  return sorted;
}

export function fingerprint(urls: string[]): string {
  return createHash("sha256").update(JSON.stringify(urls)).digest("hex");
}

export function registry(value: unknown): Registry {
  const data = value as Registry;
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.links)) throw new Error("Invalid links.json schema.");
  const ids = new Set<string>(), paths = new Set<string>(), notions = new Set<string>();
  for (const link of data.links) {
    if (!link || typeof link.id !== "string" || !ID.test(link.id)) throw new Error("Invalid link ID.");
    notePath(link.notePath);
    issueUrls(link.issueUrls);
    if (ids.has(link.id) || paths.has(link.notePath)) throw new Error("Duplicate link identity.");
    ids.add(link.id); paths.add(link.notePath);
    if (link.notionPageId !== undefined) {
      const id = notionId(link.notionPageId);
      if (id !== link.notionPageId || notions.has(id)) throw new Error("Duplicate or noncanonical Notion identity.");
      notions.add(id);
    }
  }
  return data;
}

export function renamedRegistry(data: Registry, oldPath: string, newPath: string): Registry {
  return registry({ ...data, links: data.links.map(link => {
    if (link.notePath !== oldPath && !link.notePath.startsWith(oldPath + "/")) return link;
    return { ...link, notePath: notePath(newPath + link.notePath.slice(oldPath.length)) };
  }) });
}

export function completionRequest(value: unknown): CompletionRequest {
  const request = value as CompletionRequest;
  if (!request || request.schemaVersion !== 1 || !ID.test(request.id) || !ID.test(request.linkId)
      || typeof request.requestedAt !== "string" || !Number.isFinite(Date.parse(request.requestedAt))) {
    throw new Error("Invalid completion request.");
  }
  if (fingerprint(issueUrls(request.issueUrls)) !== request.issueFingerprint) throw new Error("Invalid issue fingerprint.");
  return request;
}

export function matchingLink(request: CompletionRequest, data: Registry): Link | undefined {
  return data.links.find(link => link.id === request.linkId
    && fingerprint(link.issueUrls) === request.issueFingerprint
    && JSON.stringify(link.issueUrls) === JSON.stringify(request.issueUrls));
}

export function receipt(request: CompletionRequest, status: ReceiptStatus, detail: string, path?: string): Receipt {
  return { schemaVersion: 1, requestId: request.id, linkId: request.linkId,
    issueFingerprint: request.issueFingerprint, status, detail, recordedAt: new Date().toISOString(),
    notionConfirmed: false, ...(path ? { notePath: path } : {}) };
}

interface Line { text: string; start: number; end: number }
function bodyLines(content: string): Line[] {
  const lines: Line[] = [];
  let frontmatter = /^\uFEFF?---\r?\n/.test(content), first = true;
  let fence = "", fenceLength = 0;
  for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)) {
    if (!match[0]) continue;
    const text = match[0].replace(/\r?\n$/, "");
    if (frontmatter) {
      if (!first && text === "---") frontmatter = false;
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text);
      if (marker) {
        if (!fence) { fence = marker[1][0]; fenceLength = marker[1].length; }
        else if (marker[1][0] === fence && marker[1].length >= fenceLength
            && text.slice(marker[0].length).trim() === "") fence = "";
      } else if (!fence) lines.push({ text, start: match.index!, end: match.index! + match[0].length });
    }
    first = false;
  }
  if (frontmatter || fence) throw new Error("Unterminated frontmatter or code fence; links were not changed.");
  return lines;
}

/** Change only the bridge block, or insert one. Never reserialize note YAML. */
export function renderLinks(content: string, link: Link, managed: boolean): string {
  issueUrls(link.issueUrls);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = bodyLines(content);
  const starts = lines.filter(l => l.text === START), ends = lines.filter(l => l.text === END);
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) throw new Error("Ambiguous GitHub link markers.");
  const locals = lines.filter(l => /^## Local notes\s*$/.test(l.text));
  if (locals.length > 1) throw new Error("Multiple Local notes sections; links were not changed.");
  const local = locals[0];
  const managedEnd = lines.find(l => l.text === "<!-- notion-task-sync:managed-end -->");
  if (managed && local && (!managedEnd || local.start < managedEnd.end)) {
    throw new Error("Local notes must follow the Notion managed-end marker. Run Notion sync first.");
  }
  const sectionEnd = local ? lines.find(l => l.start >= local.end && /^#{1,2}\s/.test(l.text))?.start ?? content.length : content.length;
  const block = [START, "### GitHub issues", "", ...link.issueUrls.map(url => {
    const parts = url.split("/");
    return `- [${parts[3]}/${parts[4]}#${parts[6]}](${url})`;
  }), END].join(newline);
  if (starts.length) {
    const start = starts[0], end = ends[0];
    if (end.start < start.start || (managed && (!local || start.start < local.end || end.end > sectionEnd))) {
      throw new Error("GitHub link block must be wholly inside Local notes for managed tasks.");
    }
    return content.slice(0, start.start) + block + content.slice(end.start + END.length);
  }
  if (managed && !local) {
    if (!lines.some(l => l.text === "<!-- notion-task-sync:managed-end -->")) {
      throw new Error("Managed task needs its Notion managed-end marker and Local notes section. Run Notion sync first.");
    }
    return content + (content.endsWith(newline) ? newline : newline + newline)
      + "## Local notes" + newline + newline + block + newline;
  }
  const position = managed ? sectionEnd : content.length;
  const before = content.slice(0, position), after = content.slice(position);
  return before + (before.endsWith(newline) ? newline : newline + newline) + block + newline + (after ? newline : "") + after;
}
