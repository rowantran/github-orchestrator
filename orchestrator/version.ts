import { readFile } from "node:fs/promises";
import type { Runner } from "./core/process.js";

const repository = "https://github.com/rowantran/github-orchestrator";
const reference = "refs/heads/main";
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const update = "update the gho source checkout, then run npm ci && npm link";

/** A diagnostic only: unavailable or different versions never stop otherwise valid work. */
export async function checkVersion(runner: Runner, buildInfo = new URL("./build-info.json", import.meta.url)): Promise<{ ok: boolean; message: string }> {
  let installed: string | null = null;
  try {
    const value = JSON.parse(await readFile(buildInfo, "utf8")) as { commit?: unknown };
    if (typeof value.commit === "string" && sha.test(value.commit)) installed = value.commit;
  } catch { /* A missing or malformed stamp is an unknown build, not a broken CLI. */ }
  let published: string;
  try {
    const output = await runner.run({ argv: ["git", "ls-remote", repository, reference], timeoutMs: 20_000 });
    const row = output.trim().split("\n").map(line => line.trim().split("\t")).find(([, name]) => name === reference);
    if (!row?.[0] || !sha.test(row[0])) throw new Error(`${repository} has no valid main commit.`);
    published = row[0];
  } catch (error) {
    return { ok: false, message: `gho version: cannot read the published version: ${String(error)}` };
  }
  if (!installed) return { ok: false, message: `gho version: unknown (built without Git); to update, ${update}` };
  if (installed === published) return { ok: true, message: `gho version: ${installed.slice(0, 12)} (latest on main)` };
  return { ok: false, message: `gho version: ${installed.slice(0, 12)} is installed, but main is at ${published.slice(0, 12)}; to update, ${update}` };
}
