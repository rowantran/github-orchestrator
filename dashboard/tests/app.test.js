import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CARD, STATUS, dependencyEdges, edgePath, filterTasks, fitViewport, githubUrl, isExternalBlocker, layoutGraph, statusCounts, validateSnapshot, workstreamNames, zoomViewport } from "../app.js";

const repo = "owner/repo";
function task(number, extra = {}) {
  return { number, title: `Task ${number}`, state: "ready", body: "", branch: "", workstreams: [], blockers: [], pull_requests: [], ...extra };
}
function blocker(number, extra = {}) { return { number, repo, state: "blocked", ...extra }; }
function snapshot(tasks = [], workstreams = []) { return { repo, tasks, workstreams }; }

// Filtering must not become a second state-classification implementation.
test("All tasks preserves every state, including Complete and Closed", () => {
  const tasks = Object.keys(STATUS).map((state, i) => task(i + 1, { state }));
  assert.equal(filterTasks(tasks).length, 6);
  assert.equal(STATUS.done.label, "Complete");
  assert.equal(STATUS.closed.label, "Closed");
  assert.deepEqual(filterTasks(tasks).map((item) => item.state), Object.keys(STATUS));
});

test("slash groups have exact membership, not implied nesting", () => {
  const tasks = [task(1, { workstreams: ["api"] }), task(2, { workstreams: ["api/auth"] })];
  assert.deepEqual(filterTasks(tasks, "api").map((item) => item.number), [1]);
  assert.deepEqual(filterTasks(tasks, "api/auth").map((item) => item.number), [2]);
});

test("a task can independently belong to overlapping groups", () => {
  const tasks = [task(1, { workstreams: ["api", "api/auth"] }), task(2, { workstreams: ["ui"] })];
  assert.equal(filterTasks(tasks, "api")[0], tasks[0]);
  assert.equal(filterTasks(tasks, "api/auth")[0], tasks[0]);
  assert.deepEqual(filterTasks(tasks, "missing"), []);
});

test("group names include configured empty groups and task memberships", () => {
  const value = snapshot([task(1, { workstreams: ["api", "api/auth", "api"] })], ["empty", "api"]);
  assert.deepEqual(workstreamNames(value), ["api", "api/auth", "empty"]);
});

test("search combines with group and matches title, number, body, branch, or group", () => {
  const tasks = [task(42, { title: "Fix authentication", body: "Token expiry", branch: "owner/gh-42", workstreams: ["Backend"] }), task(2, { title: "Other" })];
  for (const query of [" FIX ", "#42", "TOKEN", "gh-42", "backend"]) {
    assert.deepEqual(filterTasks(tasks, "Backend", query).map((item) => item.number), [42]);
  }
  assert.deepEqual(filterTasks(tasks, "Other", "token"), []);
  assert.deepEqual(filterTasks(tasks, "", "not present"), []);
});

test("filtering never changes a blocked task when its blocker is hidden", () => {
  const blocked = task(2, { state: "blocked", workstreams: ["one"], blockers: [blocker(1)] });
  const tasks = [task(1, { state: "in_progress" }), blocked];
  assert.equal(filterTasks(tasks, "one")[0], blocked);
  assert.equal(filterTasks(tasks, "one")[0].state, "blocked");
  assert.equal(blocked.blockers.length, 1);
});

test("filter sorting does not mutate the original task array", () => {
  const tasks = [task(7), task(2), task(5)];
  assert.deepEqual(filterTasks(tasks).map((item) => item.number), [2, 5, 7]);
  assert.deepEqual(tasks.map((item) => item.number), [7, 2, 5]);
});

test("counts always have all six states and follow only visible tasks", () => {
  assert.deepEqual(statusCounts([task(1, { state: "done" }), task(2, { state: "closed" })]), {
    blocked: 0, ready: 0, in_progress: 0, ready_for_review: 0, done: 1, closed: 1,
  });
});

test("an empty graph has no nodes, edges or dimensions", () => {
  assert.deepEqual(layoutGraph([], repo), { nodes: [], edges: [], width: 0, height: 0 });
});

test("a single task has positive bounded coordinates", () => {
  const graph = layoutGraph([task(1)], repo);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].x, CARD.padding);
  assert.equal(graph.nodes[0].y, CARD.padding);
  assert.ok(graph.width > CARD.width);
  assert.ok(graph.height > CARD.height);
  assert.equal(graph.nodes[0].cyclic, false);
});

test("arrows point from blocker to dependent, with left-to-right ranks", () => {
  const tasks = [task(3, { blockers: [blocker(2)] }), task(2, { blockers: [blocker(1)] }), task(1)];
  const graph = layoutGraph(tasks, repo);
  assert.deepEqual(graph.edges, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  assert.ok(graph.nodes[0].x < graph.nodes[1].x);
  assert.ok(graph.nodes[1].x < graph.nodes[2].x);
});

test("a diamond layout ranks a dependent after both blockers", () => {
  const graph = layoutGraph([task(1), task(2, { blockers: [blocker(1)] }), task(3, { blockers: [blocker(1)] }), task(4, { blockers: [blocker(2), blocker(3)] })], repo);
  const [one, two, three, four] = graph.nodes;
  assert.equal(two.x, three.x);
  assert.notEqual(two.y, three.y);
  assert.ok(one.x < two.x && two.x < four.x);
  assert.equal(graph.edges.length, 4);
});

test("disconnected tasks occupy separate non-overlapping rows", () => {
  const graph = layoutGraph([task(1), task(2), task(3)], repo);
  assert.equal(new Set(graph.nodes.map((node) => node.x)).size, 1);
  assert.equal(new Set(graph.nodes.map((node) => node.y)).size, 3);
  assert.ok(graph.nodes[1].y - graph.nodes[0].y >= CARD.height);
});

function assertFits(graph, view, viewport) {
  assert.ok(view.scale > 0 && Number.isFinite(view.scale));
  for (const node of graph.nodes) {
    const left = view.x + node.x * view.scale;
    const top = view.y + node.y * view.scale;
    assert.ok(left >= 0 && top >= 0, `Task ${node.task.number} starts inside the viewport`);
    assert.ok(left + CARD.width * view.scale <= viewport.width, `Task ${node.task.number} fits horizontally`);
    assert.ok(top + CARD.height * view.scale <= viewport.height, `Task ${node.task.number} fits vertically`);
  }
}

test("Fit includes all 100 independent tasks in a 600px-high viewport below 12%", () => {
  const graph = layoutGraph(Array.from({ length: 100 }, (_, i) => task(i + 1)), repo);
  const viewport = { width: 900, height: 600 };
  const view = fitViewport(graph, viewport);
  assert.ok(graph.height > 17_000);
  assert.ok(view.scale < 0.12);
  assertFits(graph, view, viewport);
});

test("Fit includes every task of a wide 100-task dependency chain", () => {
  const graph = layoutGraph(Array.from({ length: 100 }, (_, i) => task(i + 1, { blockers: i ? [blocker(i)] : [] })), repo);
  const viewport = { width: 900, height: 600 };
  const view = fitViewport(graph, viewport);
  assert.ok(view.scale < 0.12);
  assertFits(graph, view, viewport);
});

test("Fit centers small graphs without enlarging cards", () => {
  const graph = layoutGraph([task(1)], repo);
  const viewport = { width: 900, height: 600 };
  const view = fitViewport(graph, viewport);
  assert.equal(view.scale, 1);
  assert.equal(view.x, (viewport.width - graph.width) / 2);
  assert.equal(view.y, (viewport.height - graph.height) / 2);
  assertFits(graph, view, viewport);
});

test("Fit handles tiny viewports and skips empty or hidden graphs", () => {
  const graph = layoutGraph([task(1)], repo);
  const viewport = { width: 10, height: 20 };
  assertFits(graph, fitViewport(graph, viewport), viewport);
  assert.equal(fitViewport({ width: 0, height: 0 }, viewport), null);
  assert.equal(fitViewport(graph, { width: 0, height: 600 }), null);
});

test("initial view keeps a readable scale without limiting explicit Fit", () => {
  const graph = layoutGraph(Array.from({ length: 100 }, (_, i) => task(i + 1)), repo);
  const viewport = { width: 900, height: 600 };
  assert.equal(fitViewport(graph, viewport, true).scale, 0.55);
  assert.ok(fitViewport(graph, viewport).scale < 0.12);
});

test("zooming from a fit below 12% stays smooth, monotonic, and reversible", () => {
  const graph = layoutGraph(Array.from({ length: 100 }, (_, i) => task(i + 1)), repo);
  const viewport = { width: 900, height: 600 };
  const fitted = fitViewport(graph, viewport);
  const zoomed = zoomViewport(fitted, viewport, 1.2, fitted.scale);
  assert.equal(zoomed.scale, fitted.scale * 1.2);
  assert.ok(zoomed.scale > fitted.scale && zoomed.scale < 0.12);
  const restored = zoomViewport(zoomed, viewport, 1 / 1.2, fitted.scale);
  for (const key of ["scale", "x", "y"]) assert.ok(Math.abs(restored[key] - fitted[key]) < 1e-9);
  assert.equal(zoomViewport(fitted, viewport, 1 / 1.2, fitted.scale).scale, fitted.scale);
  assert.equal(zoomViewport({ ...fitted, scale: 2 }, viewport, 1.2, fitted.scale).scale, 2);
  // A resize or subset change can raise the fit floor; zoom-out must still not zoom in.
  assert.equal(zoomViewport(fitted, viewport, 1 / 1.2, 0.2).scale, fitted.scale);
});

test("two-node cycles are safe and their dependents still rank after the cycle", () => {
  const graph = layoutGraph([task(1, { blockers: [blocker(2)] }), task(2, { blockers: [blocker(1)] }), task(3, { blockers: [blocker(2)] })], repo);
  assert.equal(graph.nodes[0].x, graph.nodes[1].x);
  assert.notEqual(graph.nodes[0].y, graph.nodes[1].y);
  assert.ok(graph.nodes[2].x > graph.nodes[1].x);
  assert.deepEqual(graph.nodes.map((node) => node.cyclic), [true, true, false]);
  assert.equal(graph.edges.length, 3);
});

test("self-dependencies are preserved, flagged, and get a finite SVG path", () => {
  const graph = layoutGraph([task(1, { blockers: [blocker(1)] })], repo);
  assert.equal(graph.nodes[0].cyclic, true);
  assert.equal(graph.edges.length, 1);
  const path = edgePath(graph.nodes[0], graph.nodes[0]);
  assert.match(path, /^M /);
  assert.doesNotMatch(path, /NaN|undefined|Infinity/);
});

test("all nodes of a three-task cycle remain visible", () => {
  const graph = layoutGraph([task(1, { blockers: [blocker(3)] }), task(2, { blockers: [blocker(1)] }), task(3, { blockers: [blocker(2)] })], repo);
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.nodes.every((node) => node.cyclic));
  assert.equal(new Set(graph.nodes.map((node) => `${node.x},${node.y}`)).size, 3);
});

test("only visible endpoints produce edges, including when filtering hides blockers", () => {
  const tasks = [task(1), task(2, { blockers: [blocker(1)], workstreams: ["subset"] }), task(3, { blockers: [blocker(99)] })];
  assert.deepEqual(dependencyEdges(tasks, repo), [{ from: 1, to: 2 }]);
  assert.deepEqual(layoutGraph(filterTasks(tasks, "subset"), repo).edges, []);
});

test("external blockers cannot collide with local issue numbers", () => {
  const tasks = [task(1), task(2, { blockers: [blocker(1, { repo: "other/repo" })] })];
  assert.deepEqual(dependencyEdges(tasks, repo), []);
  assert.equal(isExternalBlocker(tasks[1].blockers[0], repo), true);
});

test("repository comparison is case-insensitive and falls back to GitHub URL", () => {
  assert.equal(isExternalBlocker(blocker(1, { repo: "OWNER/Repo" }), repo), false);
  assert.equal(isExternalBlocker({ number: 1, url: "https://github.com/other/repo/issues/1" }, repo), true);
  assert.equal(isExternalBlocker({ number: 1, url: "https://github.com/OWNER/Repo/issues/1" }, repo), false);
});

test("duplicate blocker references draw only one arrow", () => {
  assert.deepEqual(dependencyEdges([task(1), task(2, { blockers: [blocker(1), blocker(1)] })], repo), [{ from: 1, to: 2 }]);
});

test("layout is deterministic across task and blocker input order", () => {
  const tasks = [task(1), task(2), task(3, { blockers: [blocker(1), blocker(2)] })];
  const original = layoutGraph(tasks, repo);
  const reversed = layoutGraph([...tasks].reverse().map((item) => ({ ...item, blockers: [...item.blockers].reverse() })), repo);
  assert.deepEqual(original.nodes.map(({ task: item, x, y }) => ({ number: item.number, x, y })), reversed.nodes.map(({ task: item, x, y }) => ({ number: item.number, x, y })));
  assert.deepEqual(original.edges, reversed.edges);
});

test("long dependency chains do not overflow the call stack", () => {
  const tasks = Array.from({ length: 12_000 }, (_, i) => task(i + 1, { blockers: i ? [blocker(i)] : [] }));
  const graph = layoutGraph(tasks, repo);
  assert.equal(graph.nodes.length, tasks.length);
  assert.equal(graph.edges.length, tasks.length - 1);
  assert.ok(graph.nodes.at(-1).x > graph.nodes[0].x);
});

test("layout does not alter statuses, task objects, or input order", () => {
  const tasks = [task(2, { state: "closed", blockers: [blocker(1)] }), task(1, { state: "done" })];
  const before = structuredClone(tasks);
  layoutGraph(tasks, repo);
  assert.deepEqual(tasks, before);
});

test("normal and backward paths use finite SVG coordinates", () => {
  const graph = layoutGraph([task(1), task(2, { blockers: [blocker(1)] })], repo);
  for (const path of [edgePath(graph.nodes[0], graph.nodes[1]), edgePath(graph.nodes[1], graph.nodes[0])]) {
    assert.match(path, /^M /);
    assert.doesNotMatch(path, /NaN|undefined|Infinity/);
  }
});

test("GitHub HTTPS and HTTP links are allowed", () => {
  assert.equal(githubUrl("https://github.com/owner/repo/issues/1"), "https://github.com/owner/repo/issues/1");
  assert.equal(githubUrl("http://github.com/owner/repo/pull/2"), "http://github.com/owner/repo/pull/2");
  assert.equal(githubUrl("https://GITHUB.COM/owner/repo"), "https://github.com/owner/repo");
});

test("unsafe schemes, host spoofing, credentials, and foreign origins are not links", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//github.com/owner/repo", "/owner/repo", "https://github.com.evil.test/path", "https://evilgithub.com/path", "https://github.com@evil.test/path", "https://evil@github.com/path", "https://github.com:444/path", "https://api.github.com/path", "file:///tmp/example", "", null, undefined, 123]) {
    assert.equal(githubUrl(url), null, String(url));
  }
});

test("automatic refresh is opt-in in the initial page", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const checkbox = html.match(/<input\b[^>]*\bid="auto-refresh"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /\bchecked\b/);
});

test("the page uses only the agreed local assets and session token placeholder", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<meta name="gho-token" content="__GHO_TOKEN__">/);
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((match) => match[1]).sort(), ["/app.js", "/style.css"]);
});

test("a valid snapshot is returned unchanged", () => {
  const value = snapshot([task(1)], ["empty"]);
  assert.equal(validateSnapshot(value), value);
});

test("malformed snapshots fail instead of looking like empty queues", () => {
  for (const value of [null, {}, { repo, tasks: [] }, { repo, tasks: [], workstreams: [1] }, snapshot([task(0)]), snapshot([task(1.2)]), snapshot([task(1, { state: "unexpected" })]), snapshot([task(1), task(1)]), snapshot([task(1, { title: null })]), snapshot([task(1, { state: "toString" })])]) {
    assert.throws(() => validateSnapshot(value), /invalid/i);
  }
});
