import { test as base, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "../..");
let reportedSocketDenial = false;
export const PREFIX = "gho:workstream:";
export const XSS_TITLE = 'Blocked <img src=x onerror="window.__ghoXss=1">';
export const XSS_BODY = '<script>window.__ghoXss=1</script>\n<img src=x onerror="window.__ghoXss=1">\n[unsafe](javascript:window.__ghoXss=1)';

function pullRequest(issue, state = "OPEN", draft = false) {
  const number = 100 + issue;
  return {
    id: `PR_${number}`, number, url: `https://github.com/acme/app/pull/${number}`,
    state, merged: state === "MERGED", isDraft: draft,
    baseRefName: "main", headRefName: `worker/gh-${issue}`,
    mergeCommit: state === "MERGED" ? { oid: "a".repeat(40) } : null,
    repository: { nameWithOwner: "acme/app" }, headRepository: { nameWithOwner: "acme/app" },
  };
}

function initialState() {
  const issue = (number, title, groups, extra = {}) => ({
    repo: "acme/app", number, title, body: `Description for task ${number}.`,
    state: "OPEN", reason: null, assignees: ["worker"], project: true,
    blockers: [], closing_prs: [], labels: ["bug", ...groups.map((group) => PREFIX + group)],
    ...extra,
  });
  const specs = [
    issue(1, XSS_TITLE, ["project-a", "project-b"], { body: XSS_BODY, blockers: ["outside/repo#99", "acme/app#4"] }),
    issue(2, "Ready nested-only task", ["project-a/feature-1"], { blockers: ["acme/app#4", "acme/app#5"] }),
    issue(3, "Draft implementation", ["project-a", "project-a/feature-1", "project-b"]),
    issue(4, "Ready for review", ["project-a", "project-b"]),
    // An unassigned completed task proves the dashboard is not the open personal queue.
    issue(5, "Completed archived task", ["project-a/feature-1"], { state: "CLOSED", reason: "COMPLETED", assignees: [] }),
    issue(6, "Closed without completion", ["project-b"], { state: "CLOSED", reason: "NOT_PLANNED" }),
    issue(7, "Outside configured Project", ["project-a"], { project: false }),
    issue(99, "External approval blocker", [], { repo: "outside/repo", project: false }),
  ];
  return {
    labels: ["bug", ...["project-a", "project-a/feature-1", "project-b", "project-empty"].map((name) => PREFIX + name)],
    issues: Object.fromEntries(specs.map((spec) => [`${spec.repo}#${spec.number}`, spec])),
    // PRs are found by branch, not closing keywords, including the merged PR for task 5.
    branch_prs: { "worker/gh-3": [pullRequest(3, "OPEN", true)], "worker/gh-4": [pullRequest(4)], "worker/gh-5": [pullRequest(5, "MERGED")] },
  };
}

function executable(name) {
  for (const path of (process.env.PATH || "").split(":")) {
    const candidate = join(path, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is required for the isolated dashboard tests`);
}

function lines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await ended; } finally { clearTimeout(timer); }
}

export const test = base.extend({
  app: async ({}, use, testInfo) => {
    const binary = resolve(process.env.GHO_E2E_BINARY || join(project, "target/debug/gho"));
    if (!existsSync(binary)) throw new Error(`Build the real dashboard first: cargo build --locked (missing ${binary})`);
    const root = mkdtempSync(join(tmpdir(), "gho-e2e-"));
    const repo = join(root, "repo");
    const config = join(root, "config");
    const bin = join(root, "bin");
    for (const dir of [repo, bin, join(config, "repos/acme"), join(root, "home")]) mkdirSync(dir, { recursive: true });
    const realTmux = executable("tmux");
    // Do not inherit Git/GitHub credentials, config overrides, or a user's tmux session.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(GH_|GITHUB_|GIT_|GHO_|TMUX|XDG_CONFIG_HOME$|HOME$)/.test(key)));
    Object.assign(env, {
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      PATH: `${bin}:${process.env.PATH}`, GHO_CONFIG_DIR: config,
      GHO_E2E_FIXTURE: root, GHO_E2E_REAL_TMUX: realTmux,
    });
    const run = (command, args) => execFileSync(command, args, { cwd: repo, env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const tmux = (...args) => run(realTmux, ["-S", join(root, "tmux.sock"), ...args]);
    let child;
    let serverLog = "";
    let tmuxMode = "real";
    const tmuxStatePath = join(root, "tmux-state.json");
    const tmuxState = () => JSON.parse(readFileSync(tmuxStatePath, "utf8"));
    try {
      writeFileSync(join(config, "config.toml"), 'owner = "worker"\n');
      writeFileSync(join(config, "repos/acme/app.toml"), 'project_url = "https://github.com/orgs/acme/projects/7"\nbase_branch = "main"\n');
      writeFileSync(join(root, "state.json"), JSON.stringify(initialState()));
      for (const tool of ["gh", "tmux"]) {
        copyFileSync(join(here, `fake-${tool}.py`), join(bin, tool));
        chmodSync(join(bin, tool), 0o755);
      }
      run("git", ["init", "-b", "main"]);
      run("git", ["-c", "user.name=Dashboard fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
      run("git", ["remote", "add", "origin", "https://github.com/acme/app.git"]);
      run("git", ["worktree", "add", "-b", "worker/gh-3", join(root, "task-3")]);
      // No shell startup files or user tmux config. Every command explicitly supplies our socket.
      let firstPane;
      let secondPane;
      try {
        firstPane = tmux("-f", "/dev/null", "new-session", "-d", "-s", "gho-e2e", "-n", "implementer", "-c", join(root, "task-3"), "-P", "-F", "#{pane_id}", "sleep 3600");
      } catch (error) {
        // Only a known sandbox capability denial permits simulation. Other tmux failures fail tests.
        if (!/Operation not permitted/.test(String(error.stderr || error.message))) throw error;
        if (process.env.GHO_E2E_REQUIRE_REAL_TMUX === "1") {
          throw new Error(`GHO_E2E_REQUIRE_REAL_TMUX=1 forbids fallback: private tmux sockets were denied.\n${error.stderr || error.message}`);
        }
        tmuxMode = "fake (sandbox denies private tmux sockets: Operation not permitted)";
        env.GHO_E2E_TMUX_MODE = "fake";
        [firstPane, secondPane] = ["%0", "%1"];
        writeFileSync(tmuxStatePath, JSON.stringify({ active: firstPane, panes: [firstPane, secondPane].map((id) => ({ id, path: join(root, "task-3"), issue: 3 })) }));
        if (!reportedSocketDenial) {
          console.warn(`Dashboard e2e tmux mode: ${tmuxMode}. No real pane-selection coverage in this run.`);
          reportedSocketDenial = true;
        }
      }
      if (tmuxMode === "real") {
        secondPane = tmux("split-window", "-d", "-t", firstPane, "-c", join(root, "task-3"), "-P", "-F", "#{pane_id}", "sleep 3600");
        for (const pane of [firstPane, secondPane]) {
          tmux("set-option", "-p", "-t", pane, "@gho_repo", "acme/app");
          tmux("set-option", "-p", "-t", pane, "@gho_issue", "3");
        }
        tmux("select-pane", "-t", firstPane);
      }
      testInfo.annotations.push({ type: "tmux", description: tmuxMode });
      child = spawn(binary, ["dashboard", "--port", "0", "--tmux-session", "gho-e2e"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { serverLog += chunk; });
      child.stderr.on("data", (chunk) => { serverLog += chunk; });
      const url = await new Promise((resolveUrl, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Dashboard did not start. Rebuild target/debug/gho with all assets.\n${serverLog}`)), 10_000);
        const finish = (error, value) => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          child.off("error", onError);
          error ? reject(error) : resolveUrl(value);
        };
        const onData = () => { const match = serverLog.match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) finish(null, match[0]); };
        const onExit = () => finish(new Error(`Dashboard exited; rebuild the binary if the command is missing.\n${serverLog}`));
        const onError = (error) => finish(error);
        child.stdout.on("data", onData); child.once("exit", onExit); child.once("error", onError);
      });
      const app = {
        url, root, firstPane, secondPane, tmuxMode,
        cli: (...args) => run(binary, args),
        state: () => JSON.parse(readFileSync(join(root, "state.json"), "utf8")),
        replaceState: (state) => {
          // Only fixture data changes; the browser still loads the real snapshot API.
          writeFileSync(join(root, "state.json"), JSON.stringify(state));
        },
        calls: (tool = "gh") => lines(join(root, `${tool}-calls.jsonl`)),
        activePane: () => tmuxMode === "real" ? tmux("display-message", "-p", "-t", "gho-e2e:implementer", "#{pane_id}") : tmuxState().active,
        retagPane: (pane, issue) => {
          if (tmuxMode === "real") return tmux("set-option", "-p", "-t", pane, "@gho_issue", String(issue));
          const state = tmuxState();
          state.panes.find((item) => item.id === pane).issue = issue;
          writeFileSync(tmuxStatePath, JSON.stringify(state));
        },
        failRefresh: () => writeFileSync(join(root, "fail-gh"), "intentional failure"),
        recoverRefresh: () => rmSync(join(root, "fail-gh"), { force: true }),
        async open(page, query = "") {
          const response = page.waitForResponse((response) => response.url() === `${url}api/snapshot`, { timeout: 95_000 });
          await page.goto(url + query);
          const snapshot = await response;
          expect(snapshot.status(), await snapshot.text()).toBe(200);
          await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
          await page.getByLabel("Refresh every 60s").uncheck();
          return snapshot.json();
        },
      };
      await use(app);
      expect(lines(join(root, "rejected.jsonl")), "Every gh/tmux operation must match the strict fixture").toEqual([]);
    } finally {
      await stop(child);
      if (tmuxMode === "real") {
        try { tmux("kill-server"); } catch { /* Server may not have started. Never fall back to a default socket. */ }
      }
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("server.log", { body: serverLog, contentType: "text/plain" });
        for (const name of ["gh-calls.jsonl", "tmux-calls.jsonl", "rejected.jsonl"]) {
          if (existsSync(join(root, name))) await testInfo.attach(name, { body: readFileSync(join(root, name)), contentType: "application/x-ndjson" });
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  browserSafety: [async ({ context, app }, use) => {
    const errors = [];
    const unexpectedRequests = [];
    const githubVisits = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    // Fulfil GitHub link clicks locally. No browser request reaches an external host.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(app.url).origin) return route.continue();
      if (url.origin === "https://github.com" && route.request().isNavigationRequest()) {
        githubVisits.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Intercepted GitHub link</title>Offline link target" });
      }
      unexpectedRequests.push(url.href);
      return route.abort("blockedbyclient");
    });
    await use({ githubVisits });
    expect(errors, "Uncaught browser errors").toEqual([]);
    expect(unexpectedRequests, "Unexpected non-loopback browser requests").toEqual([]);
  }, { auto: true }],
});
export { expect };
