import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.json"], {
  cwd: root, stdio: "inherit",
});

// Stamp the code being built, not the target repository where a user later runs gho.
// Source archives have no Git identity; do not accidentally use a containing checkout.
let commit = null;
if (existsSync(new URL(".git", import.meta.url))) {
  try {
    const value = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) commit = value;
  } catch { /* Building without Git is supported. Doctor reports an unknown version. */ }
}
writeFileSync(new URL("dist/orchestrator/build-info.json", import.meta.url), JSON.stringify({ commit }) + "\n");
