import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = new URL(existsSync(new URL("../package.json", import.meta.url)) ? "../" : "../../", import.meta.url);
const bin = fileURLToPath(new URL("bin/gho.mjs", root));
const fixture = fileURLToPath(new URL("tests/fixtures/fake-cli-gh.mjs", root));
interface Result { code: number | null; stdout: string; stderr: string; pid: number }
interface Descriptor { pid: number; port: number; token: string; url: string; repo: string }
async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timeout) reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr}`));
      else resolve({ code, stdout, stderr, pid: child.pid! });
    });
  });
}
function success(result: Result): string {
  assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout;
}
async function fixtureRepo(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "gho cli test "));
  const tools = join(cwd, "tools"), configDir = join(cwd, "config"), calls = join(cwd, "external-calls.jsonl");
  await mkdir(tools);
  await mkdir(join(cwd, "home"));
  for (const command of ["gh", "pi", "wt"]) {
    await copyFile(fixture, join(tools, command));
    await chmod(join(tools, command), 0o755);
  }
  await writeFile(calls, "");
  const env: NodeJS.ProcessEnv = {
    PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(cwd, "home"),
    GHO_CONFIG_DIR: configDir, GHO_CLI_CALL_LOG: calls,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
  const git = (...args: string[]) => run("git", args, cwd, env).then(success);
  await git("init", "-b", "main");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await git("remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git");
  await git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  const runtime = join(cwd, ".git", "gho-service");
  const cli = (...args: string[]) => run(process.execPath, [bin, ...args], cwd, env);
  t.after(async () => {
    // Tests own only this temporary daemon. Never look up or stop a real checkout service.
    try {
      const descriptor = JSON.parse(await readFile(join(runtime, "service.json"), "utf8")) as Descriptor;
      try { process.kill(descriptor.pid, "SIGTERM"); } catch { /* Already stopped. */ }
      for (let i = 0; i < 50 && existsSync(join(runtime, "service.json")); i++) await delay(50);
      if (existsSync(join(runtime, "service.json"))) { try { process.kill(descriptor.pid, "SIGKILL"); } catch { /* Exited. */ } }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rm(cwd, { recursive: true, force: true });
  });
  const configure = async () => {
    success(await cli("init"));
    await writeFile(join(configDir, "config.toml"), 'owner = "fixture-owner"\n[agents]\nplanner_model = "fixture/planner:high"\nimplementer_model = "fixture/worker"\nreviewer_model = "fixture/reviewer"\n[orchestration]\npoll_interval_ms = 100\n');
    await writeFile(join(configDir, "repos/fixture-owner/fixture-repo.toml"), 'project_url = "https://github.com/users/fixture-owner/projects/1"\nbase_branch = "trunk"\n');
  };
  return { cwd, env, cli, configDir, configure, runtime, calls };
}

test("actual bin exposes CLI help and version without GitHub or Pi calls", async (t) => {
  const { cli, calls } = await fixtureRepo(t);
  assert.match(success(await cli("--help")), /Usage: gho/);
  for (const command of ["service", "agent", "run", "approve"])
    assert.match(success(await cli(command, "--help")), new RegExp(command));
  assert.match(success(await cli("--version")), /^\d+\.\d+\.\d+\s*$/);
  assert.equal(await readFile(calls, "utf8"), "");
});

test("actual init derives owner and branch, never overwrites, and config honors explicit directory", async (t) => {
  const { cwd, env, cli, calls, configDir, configure } = await fixtureRepo(t);
  const initial = JSON.parse(success(await cli("init"))) as { files: Array<{ path: string; created: boolean }>; repo: string };
  assert.equal(initial.repo, "fixture-owner/fixture-repo");
  assert.equal(initial.files.length, 2);
  assert(initial.files.every((file) => file.created));
  assert.match(await readFile(join(configDir, "config.toml"), "utf8"), /owner = "fixture-owner"/);
  assert.match(await readFile(join(configDir, "repos/fixture-owner/fixture-repo.toml"), "utf8"), /base_branch = "trunk"/);
  const incomplete = await cli("config");
  assert.notEqual(incomplete.code, 0);
  assert.match(incomplete.stderr, /project_url/);
  await configure();
  const original = await readFile(join(configDir, "config.toml"), "utf8");
  const again = JSON.parse(success(await cli("init"))) as { files: Array<{ created: boolean }> };
  assert(again.files.every((file) => !file.created));
  assert.equal(await readFile(join(configDir, "config.toml"), "utf8"), original);
  const config = JSON.parse(success(await run(process.execPath, [bin, "--config-dir", configDir, "config"], cwd,
    { ...env, GHO_CONFIG_DIR: join(cwd, "wrong-directory") }))) as Record<string, unknown>;
  assert.equal(config.checkout, cwd);
  assert.equal(config.repo, "fixture-owner/fixture-repo");
  assert.equal(config.owner, "fixture-owner");
  assert.equal(config.base_branch, "trunk");
  assert.deepEqual(config.agents, { planner_model: "fixture/planner:high", implementer_model: "fixture/worker", reviewer_model: "fixture/reviewer" });
  const log = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log, [{ command: "gh", args: ["api", "--hostname", "github.com", "user", "--jq", ".login"] }]);
});

test("actual service detaches from CLI, stays idle on start, reuses one daemon and stops cleanly", { timeout: 45_000 }, async (t) => {
  const { cli, configure, calls, runtime, configDir, cwd, env } = await fixtureRepo(t);
  await configure();
  await writeFile(calls, "");
  assert.deepEqual(JSON.parse(success(await cli("service", "status"))), { running: false });
  const first = await run(process.execPath, [bin, "--config-dir", configDir, "service", "start", "--port", "0"],
    cwd, { ...env, GHO_CONFIG_DIR: join(cwd, "wrong-service-config") });
  const url = success(first).trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//);
  const descriptor = JSON.parse(await readFile(join(runtime, "service.json"), "utf8")) as Descriptor;
  assert.notEqual(descriptor.pid, first.pid, "Service must not be the exited CLI process");
  assert.doesNotThrow(() => process.kill(descriptor.pid, 0));
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
  await delay(350); // More than three configured polling periods, after the starter exited.
  const status = JSON.parse(success(await cli("service", "status"))) as Record<string, unknown>;
  assert.deepEqual(status, { running: true, pid: descriptor.pid, url });
  assert.deepEqual(JSON.parse(success(await cli("status"))), []);
  assert.equal(success(await cli("service", "start")).trim(), url);
  assert.equal(success(await cli("dashboard")).trim(), url);
  assert.equal((JSON.parse(await readFile(join(runtime, "service.json"), "utf8")) as Descriptor).pid, descriptor.pid);
  assert.deepEqual(await readdir(join(runtime, "executions")), []);
  assert.equal(await readFile(calls, "utf8"), "", "Starting an idle service must not query GitHub, launch Pi, or create worktrees");
  assert.deepEqual(JSON.parse(success(await cli("service", "stop"))), { stopped: true });
  assert.deepEqual(JSON.parse(success(await cli("service", "status"))), { running: false });
  assert.equal(existsSync(join(runtime, "service.json")), false);
  assert.equal(existsSync(join(runtime, "service.lock")), false);
  assert.deepEqual(JSON.parse(success(await cli("service", "stop"))), { stopped: true });
  assert.equal(await readFile(calls, "utf8"), "");
});
