export const STATUS = Object.freeze({
  blocked: { label: "Blocked", icon: "!" },
  ready: { label: "Ready", icon: "→" },
  in_progress: { label: "In progress", icon: "◐" },
  ready_for_review: { label: "Ready for review", icon: "◇" },
  done: { label: "Complete", icon: "✓" },
  closed: { label: "Closed", icon: "×" },
});

export const CARD = Object.freeze({ width: 264, height: 144, gapX: 92, gapY: 32, padding: 48 });
const text = (value) => typeof value === "string" ? value : "";
const list = (value) => Array.isArray(value) ? value : [];
const compareTasks = (a, b) => a.number - b.number;

/** Only GitHub HTTP(S) links are clickable. Task text is never parsed as HTML. */
export function githubUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com" || url.username || url.password || url.port) return null;
    return url.href;
  } catch { return null; }
}

export function validateSnapshot(value) {
  if (!value || typeof value.repo !== "string" || !value.repo || !Array.isArray(value.tasks) || !Array.isArray(value.workstreams) || value.workstreams.some((name) => typeof name !== "string")) {
    throw new Error("The server returned an invalid task snapshot.");
  }
  const numbers = new Set();
  for (const task of value.tasks) {
    if (!task || !Number.isSafeInteger(task.number) || task.number < 1 || numbers.has(task.number) || typeof task.title !== "string" || !Object.hasOwn(STATUS, task.state)) {
      throw new Error("The server returned an invalid or duplicate task.");
    }
    numbers.add(task.number);
  }
  return value;
}

export function workstreamNames(snapshot) {
  return [...new Set([...list(snapshot.workstreams), ...list(snapshot.tasks).flatMap((task) => list(task.workstreams))].filter((name) => typeof name === "string" && name.length > 0))].sort((a, b) => a.localeCompare(b));
}

/** Workstreams are exact, overlapping memberships, never a slash hierarchy. */
export function filterTasks(tasks, group = "", query = "") {
  const needle = query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    if (group && !list(task.workstreams).includes(group)) return false;
    if (!needle) return true;
    return [`#${task.number}`, task.title, task.body, task.branch, ...list(task.workstreams)].some((field) => text(field).toLocaleLowerCase().includes(needle));
  }).sort(compareTasks);
}

export function statusCounts(tasks) {
  const counts = Object.fromEntries(Object.keys(STATUS).map((state) => [state, 0]));
  for (const task of tasks) if (Object.hasOwn(counts, task.state)) counts[task.state]++;
  return counts;
}

export function isExternalBlocker(blocker, repo) {
  if (text(blocker.repo)) return blocker.repo.toLowerCase() !== repo.toLowerCase();
  const url = githubUrl(blocker.url);
  if (!url) return false;
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts.length >= 2 && parts.slice(0, 2).join("/").toLowerCase() !== repo.toLowerCase();
}

export function dependencyEdges(tasks, repo) {
  const visible = new Set(tasks.map((task) => task.number));
  const seen = new Set();
  const edges = [];
  for (const task of [...tasks].sort(compareTasks)) {
    for (const blocker of list(task.blockers)) {
      if (!blocker || isExternalBlocker(blocker, repo) || !visible.has(blocker.number)) continue;
      const key = `${blocker.number}:${task.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: blocker.number, to: task.number });
    }
  }
  return edges.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Collapse strongly connected components before ranking. Iterative walks also
 * support long chains without recursion limits; cycles never block the layout. */
export function layoutGraph(tasks, repo) {
  const ordered = [...tasks].sort(compareTasks);
  const ids = ordered.map((task) => task.number);
  const edges = dependencyEdges(ordered, repo);
  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  const visited = new Set();
  const finished = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = outgoing.get(frame.id);
      if (frame.next < children.length) {
        const child = children[frame.next++];
        if (!visited.has(child)) { visited.add(child); stack.push({ id: child, next: 0 }); }
      } else { finished.push(frame.id); stack.pop(); }
    }
  }
  const componentOf = new Map();
  const components = [];
  for (const id of finished.reverse()) {
    if (componentOf.has(id)) continue;
    const index = components.length;
    const members = [];
    const stack = [id];
    componentOf.set(id, index);
    while (stack.length) {
      const current = stack.pop();
      members.push(current);
      for (const parent of incoming.get(current)) {
        if (!componentOf.has(parent)) { componentOf.set(parent, index); stack.push(parent); }
      }
    }
    components.push(members.sort((a, b) => a - b));
  }
  const children = components.map(() => new Set());
  const indegree = components.map(() => 0);
  const rank = components.map(() => 0);
  for (const edge of edges) {
    const from = componentOf.get(edge.from), to = componentOf.get(edge.to);
    if (from !== to && !children[from].has(to)) { children[from].add(to); indegree[to]++; }
  }
  const queue = components.map((_, i) => i).filter((i) => indegree[i] === 0);
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const to of children[from]) {
      rank[to] = Math.max(rank[to], rank[from] + 1);
      if (--indegree[to] === 0) queue.push(to);
    }
  }
  const columns = new Map();
  for (const id of ids) {
    const column = rank[componentOf.get(id)];
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(id);
  }
  // Order each column near its parents to reduce crossings without changing rank.
  const rows = new Map();
  for (const [column, members] of [...columns].sort((a, b) => a[0] - b[0])) {
    const center = (id) => {
      const positions = incoming.get(id).filter((parent) => rows.has(parent)).map((parent) => rows.get(parent));
      return positions.length ? positions.reduce((sum, row) => sum + row, 0) / positions.length : Number.MAX_SAFE_INTEGER;
    };
    members.sort((a, b) => center(a) - center(b) || a - b);
    members.forEach((id, row) => rows.set(id, row));
    columns.set(column, members);
  }
  const maxRows = Math.max(1, ...[...columns.values()].map((members) => members.length));
  const nodes = ordered.map((task) => {
    const column = rank[componentOf.get(task.number)];
    const offset = (maxRows - columns.get(column).length) * (CARD.height + CARD.gapY) / 2;
    return { task, x: CARD.padding + column * (CARD.width + CARD.gapX), y: CARD.padding + offset + rows.get(task.number) * (CARD.height + CARD.gapY), cyclic: components[componentOf.get(task.number)].length > 1 || outgoing.get(task.number).includes(task.number) };
  });
  return {
    nodes, edges,
    width: nodes.length ? CARD.padding * 2 + columns.size * (CARD.width + CARD.gapX) - CARD.gapX : 0,
    height: nodes.length ? CARD.padding * 2 + maxRows * (CARD.height + CARD.gapY) - CARD.gapY : 0,
  };
}

/** Explicit Fit has no minimum scale: even a very large graph must fit.
 * Initial views keep a readable scale and can be panned instead. */
export function fitViewport(graph, viewport, initial = false) {
  const { width, height } = viewport;
  if (![graph.width, graph.height, width, height].every((size) => Number.isFinite(size) && size > 0)) return null;
  const margin = Math.min(12, width / 4, height / 4);
  const fittedScale = Math.min((width - margin * 2) / graph.width, (height - margin * 2) / graph.height, 1);
  const scale = initial ? Math.max(0.55, fittedScale) : fittedScale;
  return {
    scale,
    x: Math.max(margin, (width - graph.width * scale) / 2),
    y: Math.max(margin, (height - graph.height * scale) / 2),
  };
}

/** Large graphs can zoom smoothly between their fitted scale and 200%.
 * Never make zoom-out increase a scale already below the usual 12% floor. */
export function zoomViewport(view, viewport, factor, fittedScale = 0.12) {
  const minimum = Math.min(0.12, fittedScale, view.scale);
  const scale = Math.min(2, Math.max(minimum, view.scale * factor));
  return {
    scale,
    x: viewport.width / 2 - (viewport.width / 2 - view.x) * scale / view.scale,
    y: viewport.height / 2 - (viewport.height / 2 - view.y) * scale / view.scale,
  };
}

export function edgePath(from, to) {
  const x1 = from.x + CARD.width + 2, y1 = from.y + CARD.height / 2;
  const x2 = to.x - 8, y2 = to.y + CARD.height / 2;
  if (from.task.number === to.task.number) {
    return `M ${x1} ${y1} C ${x1 + 54} ${y1}, ${x1 + 54} ${from.y - 22}, ${from.x + CARD.width / 2} ${from.y - 22} S ${from.x - 36} ${from.y - 22}, ${x2} ${y2}`;
  }
  if (x2 < x1) {
    const bendY = Math.min(from.y, to.y) - 18;
    return `M ${x1} ${y1} C ${x1 + 36} ${y1}, ${x1 + 36} ${bendY}, ${x1} ${bendY} L ${x2 - 14} ${bendY} C ${x2 - 36} ${bendY}, ${x2 - 36} ${y2}, ${x2} ${y2}`;
  }
  const curve = Math.max(36, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function externalLink(label, url, className = "text-link") {
  const safe = githubUrl(url);
  const node = element(safe ? "a" : "span", className, label);
  if (safe) { node.href = safe; node.target = "_blank"; node.rel = "noopener noreferrer"; }
  return node;
}

function statusBadge(state) {
  const known = Object.hasOwn(STATUS, state);
  const badge = element("span", `status-badge ${known ? `status-${state}` : ""}`);
  const symbol = element("span", "status-icon", known ? STATUS[state].icon : "?");
  symbol.setAttribute("aria-hidden", "true");
  badge.append(symbol, document.createTextNode(known ? STATUS[state].label : text(state) || "Unknown"));
  return badge;
}

export const PHASES = Object.freeze({
  queued: "Queued", planning: "Planning", awaiting_approval: "Awaiting approval",
  implementing: "Implementing", reviewing: "Reviewing", ready_to_merge: "Ready to merge",
  paused: "Paused", blocked: "Blocked", done: "Complete", closed: "Closed",
});

/** Render Pi message content as inert text. Tool arguments/results stay inspectable. */
export function piContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(piContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (value.type === "image") return "[Image omitted; open the Pi session to inspect it.]";
  if (value.type === "toolCall") return `${text(value.name) || "Tool"}\n${JSON.stringify(value.arguments ?? {}, null, 2)}`;
  if (typeof value.text === "string") return value.text;
  if (typeof value.thinking === "string") return value.thinking;
  if (value.content !== undefined) return piContent(value.content);
  return JSON.stringify(value, null, 2);
}

/** Only the newest unfinished streamed message/tool output supplements the message history. */
export function liveAgentOutput(events) {
  let assistant = "";
  const tools = new Map();
  for (const wrapped of list(events)) {
    const event = wrapped?.event && typeof wrapped.event === "object" ? wrapped.event : wrapped;
    if (!event) continue;
    if (event.type === "message_start") assistant = "";
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (event.message) assistant = piContent(event.message.content);
      else if (update?.partial) assistant = piContent(update.partial.content);
      else if (update?.type === "text_delta") assistant += text(update.delta);
    }
    if (event.type === "message_end" || event.type === "agent_end") assistant = "";
    if (event.type === "tool_execution_start") tools.set(event.toolCallId, { name: event.toolName, output: piContent(event.args), running: true });
    if (event.type === "tool_execution_update") tools.set(event.toolCallId, { name: event.toolName, output: piContent(event.partialResult), running: true });
    if (event.type === "tool_execution_end") tools.set(event.toolCallId, { name: event.toolName, output: piContent(event.result), running: false, error: event.isError });
  }
  return { assistant, tools: [...tools.values()].slice(-20) };
}

export function startDashboard() {
  const $ = (id) => document.getElementById(id);
  const state = {
    snapshot: null, group: new URL(location.href).searchParams.get("group") || "", query: "", selected: null,
    graph: null, scale: 1, x: 0, y: 0, refreshing: false, timer: null, updated: null,
  };
  const viewport = $("graph-viewport"), stage = $("graph-stage"), detail = $("detail-panel");
  const token = document.querySelector('meta[name="gho-token"]')?.content || "";
  let resizeTimer;
  const live = { runs: new Map(), loaded: false, role: "implementer", timer: null, polling: false, pending: false, view: null, panelIssue: null, panel: null, runSignature: "", viewSignature: "", listSignature: "", drafts: new Map() };
  $("run-list-section").hidden = false;
  $("runtime-status").hidden = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin", cache: "no-store",
      headers: { "X-GHO-Token": token, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    let body;
    try { body = await response.json(); } catch { throw new Error(`The local server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw new Error(text(body?.error) || `The local server returned HTTP ${response.status}.`);
    return body;
  }

  function announceError(message) {
    $("error-banner").hidden = !message;
    $("error-banner").textContent = message;
  }

  function transform() {
    stage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    $("zoom-level").textContent = `${Math.round(state.scale * 100)}%`;
  }

  function fitGraph(initial = false) {
    if (!state.graph?.nodes.length) return;
    const fitted = fitViewport(state.graph, viewport.getBoundingClientRect(), initial);
    if (!fitted) return;
    Object.assign(state, fitted);
    transform();
  }

  function zoom(factor) {
    if (!state.graph?.nodes.length) return;
    const bounds = viewport.getBoundingClientRect();
    const fitted = fitViewport(state.graph, bounds);
    if (!fitted) return;
    Object.assign(state, zoomViewport(state, bounds, factor, fitted.scale));
    transform();
  }

  function showGraphState(title, message, symbol = "◇") {
    const panel = $("graph-state");
    panel.replaceChildren(element("span", "state-symbol", symbol), element("h3", "", title), element("p", "", message));
    panel.firstChild.setAttribute("aria-hidden", "true");
    panel.hidden = false;
  }

  function renderLegend(tasks) {
    const counts = statusCounts(tasks);
    $("status-legend").replaceChildren(...Object.entries(STATUS).map(([key]) => {
      const row = element("li");
      const count = element("span", "legend-count", counts[key]);
      count.dataset.statusCount = key;
      row.append(statusBadge(key), count);
      return row;
    }));
  }

  function renderGroups() {
    const names = workstreamNames(state.snapshot);
    if (state.group && !names.includes(state.group)) names.push(state.group);
    const select = $("workstream-select");
    const all = element("option", "", `All tasks (${state.snapshot.tasks.length})`);
    all.value = "";
    select.replaceChildren(all, ...names.map((name) => {
      const count = state.snapshot.tasks.filter((task) => list(task.workstreams).includes(name)).length;
      const option = element("option", "", `${name} (${count})`);
      option.value = name;
      return option;
    }));
    select.value = state.group;
    select.disabled = false;
  }

  function renderEdges() {
    const svg = $("graph-edges");
    const ns = "http://www.w3.org/2000/svg";
    const make = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
      return node;
    };
    svg.setAttribute("width", state.graph.width);
    svg.setAttribute("height", state.graph.height);
    const defs = make("defs", {});
    for (const suffix of ["", "-selected"]) {
      const marker = make("marker", { id: `arrow${suffix}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
      marker.append(make("path", { d: "M 0 0 L 10 5 L 0 10 z", class: `arrowhead${suffix}` }));
      defs.append(marker);
    }
    const positions = new Map(state.graph.nodes.map((node) => [node.task.number, node]));
    svg.replaceChildren(defs, ...state.graph.edges.map((edge) => make("path", {
      d: edgePath(positions.get(edge.from), positions.get(edge.to)),
      class: `dependency-edge${edge.from === state.selected || edge.to === state.selected ? " selected-edge" : ""}`,
      "data-from": edge.from, "data-to": edge.to,
      "marker-end": `url(#arrow${edge.from === state.selected || edge.to === state.selected ? "-selected" : ""})`,
    })));
  }

  function renderNodes() {
    $("graph-nodes").replaceChildren(...state.graph.nodes.map(({ task, x, y, cyclic }) => {
      const button = element("button", `task-node status-${task.state}${state.selected === task.number ? " selected" : ""}`);
      button.type = "button";
      button.id = `task-${task.number}`;
      button.dataset.issue = task.number;
      button.setAttribute("aria-pressed", String(state.selected === task.number));
      button.setAttribute("aria-label", `#${task.number} ${task.title}, ${STATUS[task.state].label}. Show details`);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      const top = element("span", "task-node-top");
      top.append(element("span", "issue-number", `#${task.number}`), statusBadge(task.state));
      const title = element("span", "task-node-title", task.title);
      title.title = task.title;
      const footer = element("span", "task-node-footer");
      const blockers = list(task.blockers);
      const external = blockers.some((blocker) => isExternalBlocker(blocker, state.snapshot.repo));
      const prs = list(task.pull_requests);
      const bits = [];
      if (blockers.length) bits.push(`${blockers.length} blocker${blockers.length === 1 ? "" : "s"}${external ? " · external" : ""}`);
      else bits.push("No blockers");
      if (cyclic) bits.push("Cycle");
      else if (prs.length) bits.push(`${prs.length} PR${prs.length === 1 ? "" : "s"}`);
      footer.append(element("span", "", bits.join(" · ")));
      const phase = element("span", "run-phase-small");
      phase.dataset.runIssue = task.number;
      const run = live.runs.get(task.number);
      phase.textContent = run ? PHASES[run.phase] || run.phase : "";
      footer.append(phase);
      button.append(top, title, footer);
      button.addEventListener("click", () => selectTask(task.number));
      button.addEventListener("focus", () => revealNode(task.number));
      button.addEventListener("keydown", (event) => navigateNodes(event, task.number));
      return button;
    }));
  }

  function revealNode(number) {
    const node = state.graph.nodes.find((item) => item.task.number === number);
    if (!node) return;
    const width = viewport.clientWidth, height = viewport.clientHeight, margin = 24;
    const left = node.x * state.scale + state.x, top = node.y * state.scale + state.y;
    const right = left + CARD.width * state.scale, bottom = top + CARD.height * state.scale;
    if (left < margin) state.x += margin - left;
    else if (right > width - margin) state.x -= right - width + margin;
    if (top < margin) state.y += margin - top;
    else if (bottom > height - margin) state.y -= bottom - height + margin;
    transform();
  }

  function navigateNodes(event, number) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = state.graph.nodes.find((node) => node.task.number === number);
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const sign = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const candidates = state.graph.nodes.filter((node) => (horizontal ? node.x - current.x : node.y - current.y) * sign > 0);
    const distance = (node) => Math.abs((horizontal ? node.x : node.y) - (horizontal ? current.x : current.y)) + 2 * Math.abs((horizontal ? node.y : node.x) - (horizontal ? current.y : current.x));
    candidates.sort((a, b) => distance(a) - distance(b));
    if (candidates.length) $(`task-${candidates[0].task.number}`).focus({ preventScroll: true });
  }

  function detailSection(title) {
    const section = element("section", "detail-section");
    section.append(element("h3", "eyebrow", title));
    return section;
  }

  function closeDetail(restoreFocus = true) {
    const previous = state.selected;
    state.selected = null;
    live.panelIssue = null;
    live.panel = null;
    detail.hidden = true;
    $("workspace").classList.remove("has-detail");
    renderSelection();
    if (restoreFocus) $(`task-${previous}`)?.focus({ preventScroll: true });
  }

  function renderSelection() {
    for (const node of $("graph-nodes").children) {
      const selected = Number(node.dataset.issue) === state.selected;
      node.classList.toggle("selected", selected);
      node.setAttribute("aria-pressed", String(selected));
    }
    if (state.graph) renderEdges();
  }

  function selectTask(number) {
    state.selected = number;
    renderSelection();
    renderDetail();
    pollLocal();
    revealNode(number);
    $("detail-title").focus({ preventScroll: true });
  }

  function renderDetail() {
    const task = state.snapshot.tasks.find((item) => item.number === state.selected);
    if (!task) { detail.hidden = true; $("workspace").classList.remove("has-detail"); return; }
    detail.hidden = false;
    $("workspace").classList.add("has-detail");
    const header = element("div", "detail-header");
    header.append(externalLink(`Issue #${task.number} ↗`, task.url));
    const close = element("button", "icon-button", "×");
    close.type = "button"; close.id = "close-detail"; close.setAttribute("aria-label", "Close task details");
    close.addEventListener("click", () => closeDetail());
    header.append(close);
    const title = element("h2", "detail-title", task.title);
    title.id = "detail-title"; title.tabIndex = -1;
    const content = [header, title, statusBadge(task.state)];
    if (task.reason) content.push(element("p", "task-reason", task.reason));
    if (list(task.workstreams).length) {
      const groups = element("div", "task-groups");
      groups.append(...task.workstreams.map((name) => element("span", "group-tag", name)));
      content.push(groups);
    }
    const prs = detailSection("Pull requests");
    if (!list(task.pull_requests).length) prs.append(element("p", "muted", "No pull requests."));
    for (const pr of list(task.pull_requests)) {
      const item = element("div", "pr-item");
      const stateLabel = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.draft ? "Draft" : "Open";
      const safe = githubUrl(pr.url);
      const number = safe ? new URL(safe).pathname.match(/\/pull\/(\d+)/)?.[1] : null;
      const line = element("div", "pr-heading");
      line.append(externalLink(number ? `PR #${number} ↗` : "Pull request ↗", pr.url), element("span", `pr-state pr-${stateLabel.toLowerCase()}`, stateLabel));
      item.append(line, element("p", "branch-line", `${text(pr.head) || "Unknown head"} → ${text(pr.base) || "Unknown base"}`));
      prs.append(item);
    }
    content.push(prs, runPanel(task));
    const blockers = detailSection("Blocked by");
    if (!list(task.blockers).length) blockers.append(element("p", "muted", "No blockers."));
    for (const blocker of list(task.blockers)) {
      const item = element("div", "blocker-item");
      const external = isExternalBlocker(blocker, state.snapshot.repo);
      const label = `${external ? `${text(blocker.repo)} ` : ""}#${blocker.number}${blocker.title ? ` · ${blocker.title}` : ""} ↗`;
      item.append(externalLink(label, blocker.url));
      const tags = element("div", "blocker-tags");
      tags.append(statusBadge(blocker.state));
      if (external) tags.append(element("span", "external-tag", "External repository"));
      else if (!state.graph.nodes.some((node) => node.task.number === blocker.number)) tags.append(element("span", "external-tag", "Outside this view"));
      item.append(tags); blockers.append(item);
    }
    content.push(blockers);
    const description = detailSection("Description");
    description.append(element("div", `issue-body${task.body ? "" : " muted"}`, task.body || "No description provided."));
    content.push(description);
    const local = detailSection("Working copy");
    const fields = element("dl", "local-fields");
    const run = live.runs.get(task.number);
    fields.append(element("dt", "", "Branch"), element("dd", "", run?.branch || task.branch || "Not created"), element("dt", "", "Worktree"), element("dd", "", run?.worktree || task.worktree || "Not created"));
    if (list(task.stack_on).length) fields.append(element("dt", "", "Stack on"), element("dd", "", task.stack_on.map((number) => `#${number}`).join(" → ")));
    local.append(fields); content.push(local);
    detail.replaceChildren(...content);
  }

  function runPanel(task) {
    if (live.panelIssue === task.number && live.panel) return live.panel;
    live.panelIssue = task.number;
    live.runSignature = "";
    live.viewSignature = "";
    live.view = null;
    const panel = detailSection("Task execution");
    panel.id = "run-panel";
    const summary = element("div"); summary.id = "run-summary";
    const feedback = element("p", "action-result"); feedback.id = "run-action-result"; feedback.setAttribute("role", "status");
    const agents = element("section", "agent-panel");
    const label = element("label", "field-label", "Agent conversation"); label.htmlFor = "agent-role";
    const role = element("select"); role.id = "agent-role";
    for (const [value, name] of [["implementer", "Implementer · planning and implementation"], ["reviewer", "Reviewer"]]) {
      const option = element("option", "", name); option.value = value; role.append(option);
    }
    role.value = live.role;
    role.addEventListener("change", () => {
      live.role = role.value; live.view = null; live.viewSignature = "";
      $("agent-message").value = live.drafts.get(`${task.number}/${live.role}`) || "";
      renderAgent(); pollLocal();
    });
    const status = element("p", "muted"); status.id = "agent-status";
    const session = element("p", "agent-session"); session.id = "agent-session";
    const transcript = element("div", "agent-transcript"); transcript.id = "agent-transcript";
    transcript.setAttribute("aria-label", "Agent transcript");
    const dialogs = element("div", "agent-dialogs"); dialogs.id = "agent-dialogs";
    const form = element("form", "agent-composer");
    const messageLabel = element("label", "field-label", "Message or nudge this agent"); messageLabel.htmlFor = "agent-message";
    const input = element("textarea"); input.id = "agent-message"; input.rows = 3; input.maxLength = 16000;
    input.placeholder = "Ask a question or steer the current work…";
    input.value = live.drafts.get(`${task.number}/${live.role}`) || "";
    input.addEventListener("input", () => live.drafts.set(`${task.number}/${live.role}`, input.value));
    const send = element("button", "button primary", "Send message"); send.type = "submit"; send.id = "send-agent-message";
    form.append(messageLabel, input, send, element("p", "filter-help", "Messages stay in this Pi session. Active work receives a steering message; otherwise the service queues feedback. Messages do not approve a skeleton or resume paused work."));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const value = input.value;
      const selectedRole = live.role;
      if (!value.trim()) return;
      const sent = await runAction(task.number, `agents/${selectedRole}/messages`, { text: value }, "Message sent.");
      if (sent) {
        if (live.drafts.get(`${task.number}/${selectedRole}`) === value) live.drafts.delete(`${task.number}/${selectedRole}`);
        if (live.panelIssue === task.number && live.role === selectedRole && input.value === value) input.value = "";
      }
    });
    agents.append(label, role, status, session, transcript, dialogs, form);
    panel.append(summary, feedback, agents);
    live.panel = panel;
    // The panel is not mounted until renderDetail finishes.
    queueMicrotask(() => { if (live.panel === panel) { renderRun(); renderAgent(); } });
    return panel;
  }

  function actionButton(label, action, body = {}, primary = false) {
    const button = element("button", `button ${primary ? "primary" : "secondary"}`, label);
    button.type = "button"; button.disabled = live.pending;
    button.addEventListener("click", () => runAction(state.selected, action, typeof body === "function" ? body() : body));
    return button;
  }

  function renderRun() {
    if (!$("run-summary")) return;
    const run = live.runs.get(state.selected);
    const signature = JSON.stringify([run, live.loaded, live.pending]);
    if (signature === live.runSignature) return;
    live.runSignature = signature;
    const summary = $("run-summary");
    if (!live.loaded) { summary.replaceChildren(element("p", "muted", "Loading local execution state…")); return; }
    if (!run) {
      const label = element("label", "field-label", "Execution mode"); label.htmlFor = "run-mode";
      const mode = element("select"); mode.id = "run-mode";
      for (const [value, label] of [["supervised", "Supervised · approve the skeleton first"], ["unsupervised", "Unsupervised · implement without approval"]]) {
        const option = element("option", "", label); option.value = value; mode.append(option);
      }
      const start = actionButton("Start task", "start", () => ({ mode: mode.value }), true); start.id = "start-task";
      const task = state.snapshot?.tasks.find(item => item.number === state.selected);
      start.disabled ||= task?.state !== "ready";
      summary.replaceChildren(label, mode, start, element("p", "filter-help", task?.state === "ready" ? "Supervised mode stops at a committed skeleton. You approve its exact commit before implementation. Both phases use the same implementer session." : "Only ready tasks can start. Complete the blockers and refresh the graph first."));
    } else {
      const phase = element("strong", `run-phase phase-${run.phase}`, PHASES[run.phase] || run.phase); phase.id = "run-phase";
      const info = element("p", "muted", `${run.mode === "unsupervised" ? "Unsupervised" : "Supervised"} · Updated ${new Date(run.updatedAt).toLocaleTimeString()}`);
      const nodes = [phase, info];
      if (run.error) { const error = element("p", "run-error", run.error); error.setAttribute("role", "alert"); nodes.push(error); }
      if (run.feedback) nodes.push(element("p", "issue-body", run.feedback));
      if (run.prUrl) nodes.push(externalLink("Open pull request ↗", run.prUrl));
      if (run.skeletonSha) {
        const sha = element("code", "skeleton-sha", run.skeletonSha); sha.id = "skeleton-sha";
        nodes.push(element("p", "field-label", "Skeleton commit"), sha);
      }
      if (run.approvedSha) nodes.push(element("p", "approved-sha", `Approved commit: ${run.approvedSha}`));
      const buttons = element("div", "run-actions");
      if (run.phase === "awaiting_approval" && run.skeletonSha) {
        // Capture the displayed full SHA. A concurrent skeleton change must be rejected by the service.
        const approve = actionButton("Approve this skeleton", "approve", { sha: run.skeletonSha }, true); approve.id = "approve-skeleton";
        buttons.append(approve);
        nodes.push(element("p", "filter-help", "Review this commit in the pull request. Approval applies only to the SHA above, not to a later revision."));
      }
      if (["paused", "blocked"].includes(run.phase)) { const resume = actionButton("Resume task", "resume"); resume.id = "resume-task"; buttons.append(resume); }
      else if (!["done", "closed"].includes(run.phase)) { const pause = actionButton("Pause task", "pause"); pause.id = "pause-task"; buttons.append(pause); }
      nodes.push(buttons);
      summary.replaceChildren(...nodes);
    }
    const agent = run?.agents?.[live.role];
    if ($("send-agent-message")) $("send-agent-message").disabled = live.pending || !agent?.sessionId || ["done", "closed"].includes(run?.phase);
  }

  function renderAgent() {
    if (!$("agent-transcript")) return;
    const run = live.runs.get(state.selected), record = run?.agents?.[live.role];
    $("agent-status").textContent = `${live.role === "implementer" ? "Implementer" : "Reviewer"}: ${live.view?.status || record?.status || "not started"}${record?.model ? ` · ${record.model}` : ""}`;
    $("agent-session").textContent = record?.sessionId ? `Session ${record.sessionId}${live.role === "implementer" ? " · shared by planning and implementation" : ""}` : "The conversation appears when this agent starts.";
    $("send-agent-message").disabled = live.pending || !record?.sessionId || ["done", "closed"].includes(run?.phase);
    const signature = JSON.stringify([state.selected, live.role, live.view]);
    if (signature === live.viewSignature) return;
    live.viewSignature = signature;
    const transcript = $("agent-transcript");
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const open = new Set([...transcript.querySelectorAll("details[open]")].map(item => item.dataset.entry));
    const entries = [];
    const messages = Array.isArray(live.view?.messages) ? live.view.messages : list(live.view?.messages?.messages);
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message !== "object") continue;
      const tool = message.role === "toolResult" || message.role === "tool";
      const article = element(tool ? "details" : "article", `agent-entry${tool ? " tool-output" : ""}`);
      article.dataset.entry = `message-${index}`;
      if (tool) article.open = open.has(article.dataset.entry);
      article.append(element(tool ? "summary" : "h4", "agent-entry-label", `${tool ? `Tool: ${text(message.toolName) || "result"}` : text(message.role) || "Message"}${message.isError ? " · failed" : ""}`));
      article.append(element("pre", "", piContent(message.content)));
      entries.push(article);
    }
    const streaming = liveAgentOutput(live.view?.events);
    if (streaming.assistant) {
      const entry = element("article", "agent-entry streaming-output");
      entry.append(element("h4", "agent-entry-label", "Assistant · streaming"), element("pre", "", streaming.assistant)); entries.push(entry);
    }
    for (const [index, tool] of streaming.tools.entries()) {
      const entry = element("details", "agent-entry tool-output live-tool"); entry.dataset.entry = `tool-${index}`;
      entry.open = tool.running || open.has(entry.dataset.entry);
      entry.append(element("summary", "", `${tool.name || "Tool"} · ${tool.running ? "running" : tool.error ? "failed" : "finished"}`), element("pre", "", tool.output)); entries.push(entry);
    }
    if (!entries.length) entries.push(element("p", "muted", "No messages yet."));
    if (list(live.view?.events).length) {
      const raw = element("details", "agent-entry raw-events"); raw.dataset.entry = "events"; raw.open = open.has("events");
      raw.append(element("summary", "", "Recent RPC events"), element("pre", "", JSON.stringify(live.view.events.slice(-100), null, 2))); entries.push(raw);
    }
    transcript.replaceChildren(...entries);
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
    renderDialogs(list(live.view?.dialogs));
  }

  function renderDialogs(dialogs) {
    const container = $("agent-dialogs");
    const signature = JSON.stringify(dialogs);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.replaceChildren(...dialogs.map(dialog => {
      const form = element("form", "agent-dialog"); form.dataset.dialogId = dialog.id;
      form.append(element("h4", "", text(dialog.title) || "Agent needs a response"));
      if (dialog.message) form.append(element("p", "issue-body", dialog.message));
      const method = dialog.method;
      let input;
      if (["input", "editor", "select"].includes(method)) {
        input = element(method === "select" ? "select" : "textarea");
        input.setAttribute("aria-label", text(dialog.title) || "Dialog response");
        if (method === "select") for (const option of list(dialog.options)) { const node = element("option", "", option); node.value = option; input.append(node); }
        else { input.value = text(dialog.prefill) || text(dialog.value); input.placeholder = text(dialog.placeholder); input.maxLength = 16000; }
        form.append(input);
      }
      const issue = state.selected, role = live.role;
      if (input || method === "confirm") {
        const submit = element("button", "button primary", method === "confirm" ? "Confirm" : "Send response"); submit.type = "submit"; form.append(submit);
        form.addEventListener("submit", event => { event.preventDefault(); runAction(issue, `agents/${role}/responses`, input ? { id: dialog.id, value: input.value } : { id: dialog.id, confirmed: true }, "Response sent."); });
      } else form.append(element("p", "muted", "This dialog type is not supported here. Cancel it and ask the agent for another way to continue."));
      const cancel = element("button", "button secondary", method === "confirm" ? "Decline" : "Cancel dialog"); cancel.type = "button";
      cancel.addEventListener("click", () => runAction(issue, `agents/${role}/responses`, method === "confirm" ? { id: dialog.id, confirmed: false } : { id: dialog.id, cancelled: true }, "Response sent."));
      form.append(cancel); return form;
    }));
  }

  async function runAction(issue, path, body, message = "Task updated.") {
    if (live.pending || !Number.isSafeInteger(issue)) return false;
    live.pending = true;
    const feedback = $("run-action-result");
    if (feedback) { feedback.textContent = "Sending…"; feedback.classList.remove("failure"); }
    renderRun(); renderAgent();
    try {
      await api(`/api/runs/${issue}/${path}`, { method: "POST", body: JSON.stringify(body) });
      if (state.selected === issue && $("run-action-result")) $("run-action-result").textContent = message;
      return true;
    } catch (error) {
      if (state.selected === issue && $("run-action-result")) { $("run-action-result").textContent = error.message; $("run-action-result").classList.add("failure"); }
      return false;
    } finally {
      live.pending = false; live.runSignature = "";
      renderRun(); renderAgent(); pollLocal();
    }
  }

  function renderRunList() {
    const signature = JSON.stringify([[...live.runs.values()].map(run => [run.issue, run.phase]), state.snapshot?.tasks.map(task => task.number)]);
    if (signature === live.listSignature) return;
    live.listSignature = signature;
    const rows = [...live.runs.values()].sort((a, b) => a.issue - b.issue).map(run => {
      const button = element("button", "run-list-item"); button.type = "button";
      button.append(element("span", "", `#${run.issue}`), element("span", `run-phase phase-${run.phase}`, PHASES[run.phase] || run.phase));
      button.disabled = !state.snapshot?.tasks.some(task => task.number === run.issue);
      button.addEventListener("click", () => {
        state.group = ""; state.query = ""; $("task-search").value = "";
        const url = new URL(location.href); url.searchParams.delete("group"); history.replaceState(null, "", url);
        renderGroups(); renderGraph(); selectTask(run.issue);
      });
      return button;
    });
    $("run-list").replaceChildren(...(rows.length ? rows : [element("p", "muted", "No local runs. Select a ready task to start.")]));
    for (const badge of document.querySelectorAll("[data-run-issue]")) {
      const run = live.runs.get(Number(badge.dataset.runIssue));
      badge.textContent = run ? PHASES[run.phase] || run.phase : "";
    }
  }

  async function pollLocal() {
    if (live.polling || document.hidden) return;
    clearTimeout(live.timer); live.polling = true;
    try {
      const runs = await api("/api/runs");
      if (!Array.isArray(runs) || runs.some(run => !Number.isSafeInteger(run?.issue) || !Object.hasOwn(PHASES, run.phase))) throw new Error("The server returned invalid local run state.");
      live.runs = new Map(runs.map(run => [run.issue, run])); live.loaded = true;
      renderRunList(); renderRun();
      const issue = state.selected, role = live.role;
      if (issue && live.runs.has(issue)) {
        const view = await api(`/api/runs/${issue}/agents/${role}`);
        if (state.selected === issue && live.role === role) { live.view = view; renderAgent(); }
      } else { live.view = null; renderAgent(); }
      $("runtime-status").textContent = "Live execution · local state updates every 1.5s. GitHub graph refresh is separate.";
      $("runtime-status").classList.remove("warning-banner");
    } catch (error) {
      $("runtime-status").textContent = `Live updates unavailable: ${error.message} Last local state is retained; retrying.`;
      $("runtime-status").classList.add("warning-banner");
    } finally {
      live.polling = false;
      if (!document.hidden) live.timer = setTimeout(pollLocal, 1500);
    }
  }

  function renderGraph(resetView = false) {
    if (!state.snapshot) return;
    const active = document.activeElement?.id;
    const visible = filterTasks(state.snapshot.tasks, state.group, state.query);
    if (!visible.some((task) => task.number === state.selected)) state.selected = null;
    state.graph = layoutGraph(visible, state.snapshot.repo);
    $("view-title").textContent = state.group || "All tasks";
    $("view-summary").textContent = `${visible.length} of ${state.snapshot.tasks.length} tasks${state.query.trim() ? " · search results" : ""}${state.group ? " · exact group membership" : " · including completed and closed"}`;
    $("edge-count").textContent = `${state.graph.edges.length} visible dependenc${state.graph.edges.length === 1 ? "y" : "ies"}`;
    renderLegend(visible);
    renderNodes(); renderEdges(); renderDetail();
    stage.style.width = `${state.graph.width}px`; stage.style.height = `${state.graph.height}px`;
    $("graph-state").hidden = visible.length > 0;
    if (!visible.length) {
      if (state.query.trim()) showGraphState("No matching tasks", "Try another search or select a different workstream.", "⌕");
      else if (state.group) showGraphState("This workstream is empty", "No tasks belong to this exact group. Select All tasks to see the full graph.");
      else showGraphState("No tasks yet", "No project tasks were returned for this repository. Refresh after adding tasks to your queue.");
    }
    for (const id of ["zoom-in", "zoom-out", "fit-graph"]) $(id).disabled = !visible.length;
    if (resetView) requestAnimationFrame(() => fitGraph(true));
    if (active && $(active)) $(active).focus({ preventScroll: true });
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    if ($("auto-refresh").checked && !document.hidden) state.timer = setTimeout(() => refresh(), 60_000);
  }

  async function refresh() {
    if (state.refreshing) return;
    clearTimeout(state.timer);
    state.refreshing = true;
    $("refresh-button").disabled = true;
    $("refresh-button").textContent = "Refreshing…";
    $("refresh-status").textContent = state.snapshot ? "Updating snapshot…" : "Reading GitHub…";
    viewport.setAttribute("aria-busy", "true");
    try {
      const snapshot = validateSnapshot(await api("/api/snapshot"));
      const firstLoad = !state.snapshot;
      state.snapshot = snapshot;
      state.updated = new Date();
      $("repo-name").textContent = snapshot.repo;
      document.title = `${snapshot.repo} · Task graph`;
      const project = githubUrl(snapshot.project_url);
      $("project-link").hidden = !project;
      if (project) $("project-link").href = project;
      announceError("");
      renderGroups(); renderGraph(firstLoad);
      $("refresh-status").textContent = `Updated ${state.updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      announceError(`Could not refresh tasks: ${error.message}${state.snapshot ? " Showing the last successful snapshot." : " Check the local server, then select Refresh to retry."}`);
      $("refresh-status").textContent = state.updated ? `Last update ${state.updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refresh failed` : "Not connected";
      if (!state.snapshot) { showGraphState("Task graph unavailable", "Check the error above, then select Refresh to retry.", "!"); $("view-summary").textContent = "No snapshot loaded"; }
    } finally {
      state.refreshing = false;
      $("refresh-button").disabled = false;
      $("refresh-button").textContent = "Refresh";
      viewport.setAttribute("aria-busy", "false");
      scheduleRefresh();
    }
  }

  $("workstream-select").addEventListener("change", (event) => {
    state.group = event.target.value;
    const url = new URL(location.href);
    if (state.group) url.searchParams.set("group", state.group); else url.searchParams.delete("group");
    history.pushState(null, "", url);
    renderGraph(true);
  });
  window.addEventListener("popstate", () => {
    state.group = new URL(location.href).searchParams.get("group") || "";
    if (state.snapshot) { renderGroups(); renderGraph(true); }
  });
  $("task-search").addEventListener("input", (event) => { state.query = event.target.value; renderGraph(true); });
  $("refresh-button").addEventListener("click", () => refresh());
  $("auto-refresh").addEventListener("change", scheduleRefresh);
  document.addEventListener("visibilitychange", () => {
    scheduleRefresh();
    clearTimeout(live.timer);
    if (!document.hidden) pollLocal();
  });
  $("zoom-in").addEventListener("click", () => zoom(1.2));
  $("zoom-out").addEventListener("click", () => zoom(1 / 1.2));
  $("fit-graph").addEventListener("click", () => fitGraph());
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
    if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
    if (event.key.toLowerCase() === "f") { event.preventDefault(); fitGraph(); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.selected !== null) closeDetail(); });
  let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    drag = { x: event.clientX, y: event.clientY, startX: state.x, startY: state.y, id: event.pointerId };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add("panning");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    state.x = drag.startX + event.clientX - drag.x; state.y = drag.startY + event.clientY - drag.y; transform();
  });
  const endDrag = () => { drag = null; viewport.classList.remove("panning"); };
  viewport.addEventListener("pointerup", endDrag); viewport.addEventListener("pointercancel", endDrag); viewport.addEventListener("lostpointercapture", endDrag);
  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => fitGraph(true), 150); });
  renderLegend([]);
  refresh();
  pollLocal();
}

if (typeof document !== "undefined") startDashboard();
