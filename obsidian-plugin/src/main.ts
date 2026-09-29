import { watch } from "node:fs";
import { FileSystemAdapter, Notice, Plugin, TFile, getFrontMatterInfo, parseYaml, type EventRef, type TAbstractFile } from "obsidian";
import {
  BRIDGE, SOURCE, completionRequest, notePath, notionId, renamedRegistry, renderLinks,
  type CompletionRequest, type Link, type Receipt,
} from "./bridge";
import { processCompletion } from "./completion";
import { Store } from "./store";

interface TaskStatusEvent { taskPath?: string; before?: { status?: string }; after?: { status?: string }; source?: string }
interface TaskNotesApi {
  hasCapability(capability: string): boolean;
  tasks: { setStatus(path: string, status: string, context: { source: string; reason: string }): Promise<unknown> };
  events: { on(event: "task.status.changed", handler: (event: TaskStatusEvent) => void): EventRef };
}

export default class GitHubOrchestratorBridge extends Plugin {
  private store!: Store;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private again = false;
  private stopped = false;
  private api?: TaskNotesApi;
  private knownPaths = new Set<string>();
  private recentNotices = new Map<string, number>();

  async onload(): Promise<void> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice("GitHub Orchestrator requires a desktop filesystem vault.", 10000);
      return;
    }
    this.store = new Store(this.app.vault.adapter.getBasePath());
    this.addCommand({ id: "reconcile", name: "Refresh issue links and completion requests", callback: () => {
      void this.reconcile().then(() => this.notice("GitHub bridge refresh finished. Review completion receipts for results."));
    } });
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.rename(file, oldPath).catch(error => this.notice(String(error)));
    }));
    this.registerEvent(this.app.vault.on("modify", file => { if (this.knownPaths.has(file.path)) this.schedule(); }));
    this.registerEvent(this.app.vault.on("delete", file => { if (this.knownPaths.has(file.path)) this.schedule(); }));
    this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
      if (this.knownPaths.has(file.path) || cache.frontmatter?.type === "task") this.schedule();
    }));
    this.app.workspace.onLayoutReady(() => { if (!this.stopped) void this.start(); });
    this.register(() => { this.stopped = true; if (this.timer) clearTimeout(this.timer); });
  }

  private async start(): Promise<void> {
    try {
      // Also observes hidden bridge files, which Obsidian's normal file events can omit.
      await this.store.withLock(async () => {});
      const watcher = watch(await this.store.safe(BRIDGE), { recursive: true }, (_event, name) => {
        const relative = name?.toString().replaceAll("\\", "/");
        if (!relative || relative === "links.json" || relative === "requests"
            || /^requests\/[a-f0-9-]+\.json$/.test(relative)) this.schedule();
      });
      watcher.on("error", error => this.notice(`Bridge file watcher failed: ${error.message}. Use Refresh issue links and completion requests.`));
      this.register(() => watcher.close());
    } catch (error) {
      this.notice(`Bridge file watcher unavailable: ${String(error)}. Use Refresh issue links and completion requests.`);
    }
    await this.reconcile();
  }

  private notice(message: string): void {
    const now = Date.now();
    if (now - (this.recentNotices.get(message) ?? 0) < 30000) return;
    this.recentNotices.set(message, now);
    if (this.recentNotices.size > 100) this.recentNotices.delete(this.recentNotices.keys().next().value!);
    new Notice(message, 10000);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile(); }, 350);
  }

  private taskNotes(): TaskNotesApi | undefined {
    const app = this.app as typeof this.app & { plugins: { getPlugin(id: string): { api?: TaskNotesApi } | null } };
    const api = app.plugins.getPlugin("tasknotes")?.api;
    if (!api || typeof api.hasCapability !== "function" || typeof api.tasks?.setStatus !== "function"
        || typeof api.events?.on !== "function" || !api.hasCapability("tasks.write") || !api.hasCapability("tasks.events")) return undefined;
    if (this.api !== api) {
      this.api = api;
      this.registerEvent(api.events.on("task.status.changed", () => this.schedule()));
    }
    return api;
  }

  private metadata(content: string, link: Link): Record<string, unknown> {
    const info = getFrontMatterInfo(content);
    const data = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> : null;
    if (!data || data.type !== "task") throw new Error("Linked note must have type: task.");
    if (link.notionPageId) {
      if (notionId(data.notion_page_id) !== link.notionPageId) throw new Error("Linked Notion identity changed.");
    } else if (data.notion_page_id !== undefined || data.notion_managed === true) {
      throw new Error("Native association now points to a Notion task. Relink after resolving its identity.");
    }
    return data;
  }

  private async resolve(link: Link): Promise<TFile> {
    let path = notePath(link.notePath);
    if (link.notionPageId) {
      const candidates = this.app.vault.getMarkdownFiles().filter(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        try { return fm?.type === "task" && notionId(fm.notion_page_id) === link.notionPageId; }
        catch { return false; }
      });
      if (candidates.length > 1) throw new Error("Multiple notes have this notion_page_id. Resolve duplicates first.");
      if (candidates.length === 1) path = notePath(candidates[0].path);
    }
    await this.store.safe(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("Linked task note is missing. Sync Notion or restore/relink the native note.");
    this.metadata(await this.app.vault.read(file), link);
    link.notePath = file.path;
    return file;
  }

  private async rename(file: TAbstractFile, oldPath: string): Promise<void> {
    await this.store.withLock(async () => {
      const original = await this.store.registry();
      const renamed = renamedRegistry(original, oldPath, file.path);
      if (JSON.stringify(original) === JSON.stringify(renamed)) return;
      for (let index = 0; index < renamed.links.length; index++) {
        const link = renamed.links[index];
        if (link.notePath === original.links[index].notePath) continue;
        await this.store.safe(link.notePath);
        const moved = this.app.vault.getAbstractFileByPath(link.notePath);
        if (!(moved instanceof TFile)) throw new Error("Renamed task is not available; restore or relink its path.");
        this.metadata(await this.app.vault.read(moved), link);
      }
      await this.store.write(`${BRIDGE}/links.json`, renamed);
    });
    this.schedule();
  }

  private reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) { this.again = true; return this.active; }
    this.active = this.run().catch(error => this.notice(`GitHub bridge: ${String(error)}`)).finally(() => {
      this.active = undefined;
      if (this.again) { this.again = false; this.schedule(); }
    });
    return this.active;
  }

  private async run(): Promise<void> {
    await this.store.withLock(async () => {
      const data = await this.store.registry();
      const original = JSON.stringify(data);
      this.knownPaths = new Set(data.links.map(link => link.notePath));
      this.taskNotes();
      for (const link of data.links) {
        try {
          const file = await this.resolve(link);
          this.knownPaths.add(file.path);
          const before = await this.app.vault.read(file);
          const managed = this.metadata(before, link).notion_managed === true;
          if (renderLinks(before, link, managed) !== before) {
            // Vault.process serializes note edits and keeps unrelated text byte-for-byte.
            await this.app.vault.process(file, content => {
              const current = this.metadata(content, link);
              return renderLinks(content, link, current.notion_managed === true);
            });
          }
        } catch (error) { this.notice(`GitHub links for ${link.notePath}: ${String(error)}`); }
      }
      if (JSON.stringify(data) !== original) await this.store.write(`${BRIDGE}/links.json`, data);
      for (const id of await this.store.requestIds()) {
        try {
          const request = completionRequest(await this.store.read(`${BRIDGE}/requests/${id}.json`));
          if (request.id !== id) throw new Error("Request ID does not match its filename.");
          await this.processRequest(request);
        } catch (error) { this.notice(`GitHub completion request ${id}: ${String(error)}. Repair the request file; it was not executed.`); }
      }
    });
  }

  private async saveReceipt(value: Receipt): Promise<void> {
    await this.store.write(`${BRIDGE}/receipts/${value.requestId}.json`, value);
  }

  private async processRequest(request: CompletionRequest): Promise<void> {
    await processCompletion(request, {
      readReceipt: async () => await this.store.read(`${BRIDGE}/receipts/${request.id}.json`) as Receipt | undefined,
      saveReceipt: value => this.saveReceipt(value),
      registry: () => this.store.registry(),
      resolve: async link => {
        const file = await this.resolve(link);
        return { path: file.path, status: this.metadata(await this.app.vault.read(file), link).status };
      },
      apiAvailable: () => this.taskNotes() !== undefined,
      setDone: async path => {
        const api = this.taskNotes();
        if (!api) throw new Error("TaskNotes runtime API became unavailable.");
        await api.tasks.setStatus(path, "Done", {
          source: SOURCE, reason: "All explicitly linked GitHub issues were verified completed by GitHub Orchestrator.",
        });
      },
      notice: message => this.notice(message),
    });
  }
}
