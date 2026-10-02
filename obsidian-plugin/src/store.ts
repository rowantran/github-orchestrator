import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { BRIDGE, ID, registry, type Registry } from "./bridge";

/** Desktop-only file store. The lock protocol is shared with orchestrator/core/notes.ts. */
export class Store {
  constructor(readonly vault: string) {}

  async safe(relative: string): Promise<string> {
    if (!relative || path.isAbsolute(relative) || /[\\\x00]/.test(relative)
        || relative.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe bridge path.");
    const root = await fs.realpath(this.vault);
    let current = root;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return current;
  }

  async read(relative: string): Promise<unknown | undefined> {
    try { return JSON.parse(await fs.readFile(await this.safe(relative), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async write(relative: string, value: unknown): Promise<void> {
    const destination = await this.safe(relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.safe(relative);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, "wx");
      try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await this.safe(relative);
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(await this.safe(BRIDGE), { recursive: true });
    const lock = await this.safe(`${BRIDGE}/lock`);
    const deadline = Date.now() + 3000;
    for (;;) {
      try { await fs.mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.safe(`${BRIDGE}/lock`);
        if (Date.now() >= deadline) throw new Error("Bridge is locked. Retry. After a crash, stop bridge users before removing .github-orchestrator/lock.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally { await fs.rmdir(lock); }
  }

  async registry(): Promise<Registry> {
    return registry(await this.read(`${BRIDGE}/links.json`) ?? { schemaVersion: 1, links: [] });
  }

  async requestIds(): Promise<string[]> {
    try {
      return (await fs.readdir(await this.safe(`${BRIDGE}/requests`)))
        .filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}
