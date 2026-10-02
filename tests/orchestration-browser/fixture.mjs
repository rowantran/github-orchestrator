import { startServer } from "../../dist/orchestrator/http.js";

export const SKELETON = "a".repeat(40);
export const REVISED = "b".repeat(40);

/** Actual HTTP server with an in-memory service. No GitHub, Pi, git or tmux processes. */
export async function fixture() {
  const calls = [];
  let snapshotCalls = 0;
  let failSnapshot = false;
  let failMessage = false;
  const runs = new Map();
  const views = new Map();
  const tasks = [
    { number: 41, title: "Shared foundation", state: "done", workstreams: ["platform"], blockers: [] },
    { number: 42, title: "Build the task API", state: "in_progress", workstreams: ["platform", "api"], blockers: [{ number: 41, state: "done", url: "https://github.com/test/repo/issues/41" }] },
    { number: 43, title: "Add supervised work", state: "ready", workstreams: ["api"], blockers: [] },
    { number: 44, title: "Add unsupervised work", state: "ready", workstreams: ["platform"], blockers: [] },
    { number: 45, title: "Needs external dependency", state: "blocked", workstreams: ["api"], blockers: [{ number: 9, repo: "other/repo", state: "blocked", title: "External dependency", url: "https://github.com/other/repo/issues/9" }] },
    { number: 46, title: "<img src=x onerror=alert(1)>", state: "closed", workstreams: ["platform"], blockers: [] },
  ].map(task => ({ ...task, body: `Description for #${task.number}.`, url: `https://github.com/test/repo/issues/${task.number}`, pull_requests: [], panes: [] }));
  const createRun = (issue, mode, phase) => ({
    version: 1, issue, repo: "test/repo", mode, phase, worktree: `/temporary/worktree-${issue}`,
    branch: `test/gh-${issue}`, baseBranch: "main", skeletonSha: phase === "awaiting_approval" ? SKELETON : undefined,
    agents: { implementer: { sessionId: `implementer-session-${issue}`, model: "planner-model", status: "settled" }, reviewer: { sessionId: `reviewer-session-${issue}`, status: "idle" } },
    updatedAt: "2026-01-01T12:00:00Z",
  });
  const touch = run => { run.updatedAt = new Date().toISOString(); };
  runs.set(42, createRun(42, "supervised", "awaiting_approval"));
  const view = (issue, role) => {
    const key = `${issue}/${role}`;
    if (!views.has(key)) views.set(key, {
      role, status: role === "implementer" ? "settled" : "idle",
      messages: role === "implementer" ? [
        { role: "user", content: `Plan issue #${issue}.` },
        { role: "assistant", content: [{ type: "text", text: "The skeleton is committed. Please review the API." }, { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } }] },
        { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "12 tests passed; no real GitHub writes." }], isError: false },
      ] : [{ role: "assistant", content: [{ type: "text", text: "Reviewer conversation is separate." }] }],
      events: [], dialogs: [],
    });
    return views.get(key);
  };
  const requireRun = issue => { const run = runs.get(issue); if (!run) throw new Error("Start the task first."); return run; };
  const api = {
    async snapshot() { snapshotCalls++; if (failSnapshot) throw new Error("Fixture GitHub read failed. Retry Refresh."); return { repo: "test/repo", project_url: "https://github.com/users/test/projects/1", workstreams: ["platform", "api", "empty"], tasks }; },
    runs() { calls.push(["runs"]); return [...runs.values()]; },
    async getRun(issue) { return runs.get(issue); },
    async start(issue, options) {
      calls.push(["start", issue, options]);
      if (runs.has(issue)) throw new Error("This task already has a run.");
      if (tasks.find(task => task.number === issue)?.state !== "ready") throw new Error("Only ready tasks can start.");
      const run = createRun(issue, options.mode || "supervised", "planning"); runs.set(issue, run); return run;
    },
    async approve(issue, sha) {
      calls.push(["approve", issue, sha]); const run = requireRun(issue);
      if (run.phase !== "awaiting_approval" || run.skeletonSha !== sha) throw new Error("Skeleton changed. Refresh and approve the new SHA.");
      run.approvedSha = sha; run.phase = "implementing"; run.agents.implementer.model = "implementation-model"; run.agents.implementer.status = "working"; touch(run); return run;
    },
    async pause(issue) { calls.push(["pause", issue]); const run = requireRun(issue); run.resumePhase = run.phase; run.phase = "paused"; touch(run); return run; },
    async resume(issue) { calls.push(["resume", issue]); const run = requireRun(issue); run.phase = run.resumePhase || "planning"; touch(run); return run; },
    async message(issue, role, text) {
      calls.push(["message", issue, role, text]);
      if (failMessage) throw new Error("Agent is disconnected. Resume the task, then resend your message.");
      view(issue, role).messages.push({ role: "user", content: text }); return { ok: true };
    },
    async agent(issue, role) { calls.push(["agent", issue, role]); requireRun(issue); return view(issue, role); },
    async respond(issue, role, response) { calls.push(["respond", issue, role, response]); const agent = view(issue, role); agent.dialogs = agent.dialogs.filter(dialog => dialog.id !== response.id); return { ok: true }; },
  };
  const server = await startServer(api);
  return { server, calls, runs, view, tasks, snapshotCount: () => snapshotCalls, failSnapshot: value => { failSnapshot = value; }, failMessage: value => { failMessage = value; } };
}
