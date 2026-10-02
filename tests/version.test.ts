import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { systemRunner, type Runner } from "../orchestrator/core/process.js";
import { checkVersion } from "../orchestrator/version.js";

const old = "1".repeat(40), latest = "2".repeat(40);
const published = `${latest}\trefs/heads/main\n`;

test("build identity records the source checkout, not the repository being diagnosed", async () => {
  const root = new URL(existsSync(new URL("../package.json", import.meta.url)) ? "../" : "../../", import.meta.url);
  const info = JSON.parse(await readFile(new URL("dist/orchestrator/build-info.json", root), "utf8"));
  const expected = existsSync(new URL(".git", root))
    ? (await systemRunner.run({ argv: ["git", "rev-parse", "HEAD"], cwd: fileURLToPath(root) })).trim()
    : null;
  assert.equal(info.commit, expected);
});

test("version diagnostics preserve nonfatal latest, different, unknown and offline results", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gho-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stamp = pathToFileURL(join(directory, "build-info.json"));
  const cases: Array<{ stamp?: string; output: string | Error; ok?: boolean; message: RegExp }> = [
    { stamp: JSON.stringify({ commit: latest }), output: published, ok: true, message: /222222222222 \(latest on main\)/ },
    { stamp: JSON.stringify({ commit: old }), output: published, message: /111111111111 is installed, but main is at 222222222222;.*npm ci && npm link/ },
    { stamp: JSON.stringify({ commit: null }), output: published, message: /unknown \(built without Git\)/ },
    { output: published, message: /unknown/ },
    { stamp: "{", output: published, message: /unknown/ },
    { stamp: JSON.stringify({ commit: "not-a-commit" }), output: published, message: /unknown/ },
    { stamp: JSON.stringify({ commit: old }), output: new Error("offline"), message: /cannot read the published version:.*offline/ },
    { output: `${latest}\trefs/heads/other\n`, message: /no valid main commit/ },
    { output: "invalid\trefs/heads/main\n", message: /no valid main commit/ },
    { stamp: JSON.stringify({ commit: latest }), output: `${old}\trefs/heads/other\n${published}`, ok: true, message: /latest on main/ },
  ];
  for (const entry of cases) {
    if (entry.stamp === undefined) await rm(stamp, { force: true });
    else await writeFile(stamp, entry.stamp);
    const runner: Runner = { run: async command => {
      assert.deepEqual(command.argv, ["git", "ls-remote", "https://github.com/rowantran/github-orchestrator", "refs/heads/main"]);
      assert.equal(command.timeoutMs, 20_000);
      if (entry.output instanceof Error) throw entry.output;
      return entry.output;
    } };
    const result = await checkVersion(runner, stamp);
    assert.equal(result.ok, entry.ok ?? false);
    assert.match(result.message, entry.message);
  }
});
