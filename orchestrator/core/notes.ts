import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument, visit } from 'yaml';
import { ensure, issueUrl, parseIssue } from './domain.js';

export const BRIDGE = '.github-orchestrator';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATUSES = ['processing', 'local-accepted', 'already-done', 'api-unavailable', 'stale', 'failed', 'rolled-back', 'interrupted'] as const;
export type CompletionStatus = 'pending' | typeof STATUSES[number];
export interface Link { id: string; notePath: string; issueUrls: string[]; notionPageId?: string }
export interface CompletionRequest { schemaVersion: 1; id: string; linkId: string; issueUrls: string[]; issueFingerprint: string; requestedAt: string }
export interface CompletionState { status: CompletionStatus; requestId: string; requestedAt: string; issueFingerprint: string; receipt: Record<string, unknown> | null }
const fingerprint = (urls: string[]): string => createHash('sha256').update(JSON.stringify(urls)).digest('hex');
export function notePath(value: string): string {
  ensure(value.length > 0 && !/[\\:\0\r\n]/.test(value) && value.split('/').every(p => p.length > 0 && !p.startsWith('.')) && value.toLowerCase().endsWith('.md'), 'Use a vault-relative task Markdown path without traversal or hidden folders.'); return value;
}
function canonicalUrls(values: string[]): string[] { ensure(values.length > 0, 'A note link requires at least one GitHub issue URL.'); return [...new Set(values.map(v => issueUrl(parseIssue(v))))].sort(); }
function notionId(value: unknown): string {
  ensure(typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value), 'Task note has an invalid notion_page_id.');
  const id = value.replaceAll('-', '').toLowerCase(); return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function record(value: unknown): Record<string, unknown> { ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid bridge JSON object.'); return value as Record<string, unknown>; }
function strings(value: unknown): string[] { ensure(Array.isArray(value) && value.every(v => typeof v === 'string'), 'Invalid bridge issue URLs.'); return value; }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export class Notes {
  private constructor(readonly vault: string, readonly bridge: string) {}
  static async open(vault: string): Promise<Notes> { const root = await realpath(vault); ensure((await stat(root)).isDirectory(), 'Obsidian vault must be an existing directory.'); return new Notes(root, join(root, BRIDGE)); }
  async safe(path: string): Promise<string> {
    const rel = relative(this.vault, path); ensure(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'Path escapes the Obsidian vault.');
    let current = this.vault;
    for (const part of rel.split(sep).filter(Boolean)) { current = join(current, part); try { ensure(!(await lstat(current)).isSymbolicLink(), `Refusing symlink in vault path: ${rel}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return path;
  }
  private async mkdir(path: string): Promise<void> { await mkdir(await this.safe(path), { recursive: true }); await this.safe(path); }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.mkdir(this.bridge); const path = await this.safe(join(this.bridge, 'lock')), deadline = Date.now() + 3000;
    for (;;) {
      try { await mkdir(path); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.safe(path); ensure(Date.now() < deadline, 'Obsidian bridge is locked. Retry; stop bridge users before removing a stale lock.'); await delay(25);
      }
    }
    try { return await fn(); } finally { await rmdir(path); }
  }
  private async readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(await this.safe(path), 'utf8')); } catch (error) { throw new Error(`Cannot read bridge JSON ${path}: ${String(error)}`); } }
  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.safe(path); await this.mkdir(dirname(path)); const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try { const file = await open(await this.safe(temporary), 'wx'); try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); } await this.safe(path); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  private async registry(): Promise<Link[]> {
    const path = await this.safe(join(this.bridge, 'links.json')); if (!await exists(path)) return [];
    const registry = record(await this.readJson(path)); ensure(registry.schemaVersion === 1 && Array.isArray(registry.links), 'Invalid links.json schema; repair it before updating associations.');
    const ids = new Set<string>(), paths = new Set<string>(), notions = new Set<string>();
    const links: Link[] = [];
    for (const value of registry.links) {
      const item = record(value); ensure(Object.keys(item).every(k => ['id', 'notePath', 'issueUrls', 'notionPageId'].includes(k)), 'Unknown link field in links.json.');
      ensure(typeof item.id === 'string' && UUID.test(item.id) && typeof item.notePath === 'string', 'Invalid link identity in links.json.');
      await this.safe(join(this.vault, notePath(item.notePath))); const urls = strings(item.issueUrls); ensure(same(urls, canonicalUrls(urls)), 'Issue URLs in links.json must be canonical, unique, and sorted.');
      ensure(!ids.has(item.id) && !paths.has(item.notePath), 'Duplicate link identity in links.json.'); ids.add(item.id); paths.add(item.notePath);
      const link: Link = { id: item.id, notePath: item.notePath, issueUrls: urls };
      if (item.notionPageId !== undefined) { const id = notionId(item.notionPageId); ensure(id === item.notionPageId && !notions.has(id), 'Duplicate or noncanonical Notion identity in links.json.'); notions.add(id); link.notionPageId = id; }
      links.push(link);
    }
    return links;
  }
  async taskIdentity(note: string): Promise<string | undefined> {
    const path = await this.safe(join(this.vault, notePath(note)));
    // Read a bounded prefix only; a large note body must not expand bridge memory use.
    const file = await open(path, 'r'), buffer = Buffer.alloc(131_080); let data: string;
    try { const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); data = buffer.subarray(0, bytesRead).toString('utf8'); } finally { await file.close(); }
    const lines = data.split(/\r?\n/); ensure(lines.shift()?.replace(/^\uFEFF/, '').trim() === '---', 'Task note must have YAML frontmatter with type: task.');
    const end = lines.findIndex(line => line.trim() === '---'); ensure(end >= 0, 'Task note has unterminated or oversized YAML frontmatter.');
    const source = lines.slice(0, end).join('\n'); ensure(Buffer.byteLength(source) <= 131_072, 'Task frontmatter exceeds the bridge size limit.');
    const document = parseDocument(source, { uniqueKeys: true }); ensure(!document.errors.length, `Cannot read task frontmatter: ${document.errors.map(e => e.message).join('; ')}`);
    visit(document, { Alias() { throw new Error('Task frontmatter aliases are not supported by the bridge.'); }, Node(_key, node) { ensure(!('tag' in node) || !node.tag, 'Task frontmatter tags are not supported by the bridge.'); } });
    const metadata = record(document.toJS({ maxAliasCount: 0 })); ensure(metadata.type === 'task', 'Only notes with type: task can be linked.');
    if (!Object.hasOwn(metadata, 'notion_page_id')) { ensure(metadata.notion_managed !== true, 'Managed Notion task is missing notion_page_id.'); return undefined; }
    return notionId(metadata.notion_page_id);
  }
  links(): Promise<Link[]> { return this.locked(async () => (await this.registry()).sort((a, b) => a.id.localeCompare(b.id))); }
  link(note: string, urls: string[]): Promise<Link> { return this.updateLink(note, urls, false); }
  add(note: string, urls: string[]): Promise<Link> { return this.updateLink(note, urls, true); }
  private async updateLink(note: string, issueUrls: string[], union: boolean): Promise<Link> {
    notePath(note); let urls = canonicalUrls(issueUrls);
    return this.locked(async () => {
      const notionPageId = await this.taskIdentity(note), links = await this.registry();
      const matches = links.filter(link => link.notePath === note || notionPageId !== undefined && link.notionPageId === notionPageId); ensure(matches.length <= 1, 'Conflicting path and Notion identities in links.json.');
      const previous = matches[0];
      if (previous) { ensure(previous.notionPageId === notionPageId, 'Task identity changed at this path; resolve the old association first.'); links.splice(links.indexOf(previous), 1); if (union) urls = canonicalUrls([...previous.issueUrls, ...urls]); }
      const link: Link = { id: previous?.id ?? randomUUID(), notePath: note, issueUrls: urls, ...(notionPageId ? { notionPageId } : {}) };
      links.push(link); links.sort((a, b) => a.id.localeCompare(b.id)); await this.writeJson(join(this.bridge, 'links.json'), { schemaVersion: 1, links }); return link;
    });
  }
  private async current(link: Link): Promise<Link> { const current = (await this.registry()).find(l => l.id === link.id); ensure(current && same(current, link), 'Note association changed; reload links and recheck all GitHub issues.'); return current; }
  completionState(link: Link): Promise<CompletionState | null> {
    return this.locked(async () => {
      const current = await this.current(link), hash = fingerprint(current.issueUrls), directory = await this.safe(join(this.bridge, 'requests')); if (!await exists(directory)) return null;
      let latest: { request: CompletionRequest; time: number; modified: number } | undefined;
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
        const path = join(directory, name), value = record(await this.readJson(path)); if (value.linkId !== current.id || value.issueFingerprint !== hash) continue;
        ensure(value.schemaVersion === 1 && value.id === name.slice(0, -5) && same(value.issueUrls, current.issueUrls) && typeof value.requestedAt === 'string' && Number.isFinite(Date.parse(value.requestedAt)), `Completion request identity/timestamp mismatch: ${name}`);
        const candidate = { request: value as unknown as CompletionRequest, time: Date.parse(value.requestedAt), modified: (await stat(await this.safe(path))).mtimeMs };
        if (!latest || candidate.time > latest.time || candidate.time === latest.time && (candidate.modified > latest.modified || candidate.modified === latest.modified && candidate.request.id > latest.request.id)) latest = candidate;
      }
      if (!latest) return null; const { request, time } = latest, receiptPath = await this.safe(join(this.bridge, 'receipts', `${request.id}.json`));
      let receipt: Record<string, unknown> | null = null, status: CompletionStatus = Date.now() - time > 86_400_000 ? 'stale' : 'pending';
      if (await exists(receiptPath)) {
        receipt = record(await this.readJson(receiptPath)); ensure(receipt.schemaVersion === 1 && receipt.requestId === request.id && receipt.linkId === current.id && receipt.issueFingerprint === hash && STATUSES.includes(receipt.status as typeof STATUSES[number]), 'Completion receipt identity or status mismatch; inspect it before retrying.'); status = receipt.status as CompletionStatus;
      }
      return { status, requestId: request.id, requestedAt: request.requestedAt, issueFingerprint: hash, receipt };
    });
  }
  requestCompletion(link: Link): Promise<CompletionRequest> {
    return this.locked(async () => {
      const current = await this.current(link), request: CompletionRequest = { schemaVersion: 1, id: randomUUID(), linkId: current.id, issueUrls: current.issueUrls, issueFingerprint: fingerprint(current.issueUrls), requestedAt: new Date().toISOString() };
      await this.writeJson(join(this.bridge, 'requests', `${request.id}.json`), request); return request;
    });
  }
  async install(pluginDirectory: string, yes = false): Promise<string> {
    ensure(yes, 'Plugin installation needs explicit confirmation (--yes).');
    const manifest = record(JSON.parse(await readFile(join(pluginDirectory, 'manifest.json'), 'utf8'))); ensure(manifest.id === 'github-orchestrator', 'Unexpected plugin manifest identity.');
    const files = new Map<string, Buffer>(); for (const name of ['manifest.json', 'main.js']) files.set(name, await readFile(join(pluginDirectory, name)));
    if (await exists(join(pluginDirectory, 'styles.css'))) files.set('styles.css', await readFile(join(pluginDirectory, 'styles.css')));
    const destination = join(this.vault, '.obsidian', 'plugins', 'github-orchestrator'); await this.mkdir(destination);
    for (const [name, content] of files) { const path = await this.safe(join(destination, name)), file = await open(path, 'w'); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
    return destination;
  }
}
