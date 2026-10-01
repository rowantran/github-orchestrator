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

export function startDashboard() {
  const $ = (id) => document.getElementById(id);
  const state = {
    snapshot: null, group: new URL(location.href).searchParams.get("group") || "", query: "", selected: null,
    graph: null, scale: 1, x: 0, y: 0, refreshing: false, timer: null, updated: null, focusPending: false,
  };
  const viewport = $("graph-viewport"), stage = $("graph-stage"), detail = $("detail-panel");
  const token = document.querySelector('meta[name="gho-token"]')?.content || "";
  let resizeTimer;

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
      if (list(task.panes).length) { const pane = element("span", "pane-indicator", "▣"); pane.title = "Task pane available"; footer.append(pane); }
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
    const focus = detailSection("Local task pane");
    const panes = list(task.panes);
    if (panes.length) {
      const label = element("label", "field-label", panes.length > 1 ? "Choose a pane" : "Task pane");
      label.htmlFor = "pane-select";
      const select = element("select"); select.id = "pane-select";
      select.append(...panes.map((pane) => {
        const option = element("option", "", `${text(pane.session)} / ${text(pane.window)} · ${text(pane.id)}`);
        option.value = text(pane.id); return option;
      }));
      focus.append(label, select);
    }
    const focusButton = element("button", "button primary focus-button", "Focus task pane");
    focusButton.type = "button"; focusButton.id = "focus-pane-button";
    focusButton.disabled = !panes.length || state.focusPending;
    focusButton.setAttribute("aria-describedby", "focus-help");
    focusButton.addEventListener("click", () => focusPane(task.number));
    focus.append(focusButton);
    const help = element("p", "filter-help", panes.length ? "Selects this task’s window and pane in tmux. Clients attached to that session show it. It does not start or run commands." : state.snapshot.tmux_warning ? `Pane discovery is unavailable: ${state.snapshot.tmux_warning}` : task.worktree ? "No tmux pane is open in this task’s worktree." : "This task has no local worktree or available tmux pane.");
    help.id = "focus-help";
    const result = element("p", "focus-result"); result.id = "focus-result"; result.setAttribute("role", "status");
    focus.append(help, result); content.push(focus);
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
    content.push(prs);
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
    fields.append(element("dt", "", "Branch"), element("dd", "", task.branch || "Not created"), element("dt", "", "Worktree"), element("dd", "", task.worktree || "Not created"));
    if (list(task.stack_on).length) fields.append(element("dt", "", "Stack on"), element("dd", "", task.stack_on.map((number) => `#${number}`).join(" → ")));
    local.append(fields); content.push(local);
    detail.replaceChildren(...content);
  }

  async function focusPane(issue) {
    if (state.focusPending) return;
    const pane = $("pane-select")?.value;
    if (!pane) return;
    state.focusPending = true;
    $("focus-pane-button").disabled = true;
    $("focus-result").classList.remove("failure");
    $("focus-result").textContent = "Focusing pane…";
    try {
      const result = await api("/api/focus", { method: "POST", body: JSON.stringify({ issue, pane }) });
      if (state.selected === issue) $("focus-result").textContent = text(result.message) || "Task pane focused.";
    } catch (error) {
      if (state.selected === issue) { $("focus-result").textContent = `Could not focus pane: ${error.message}`; $("focus-result").classList.add("failure"); }
    } finally {
      state.focusPending = false;
      if ($("focus-pane-button")) $("focus-pane-button").disabled = !$("pane-select");
    }
  }

  function renderGraph(resetView = false) {
    if (!state.snapshot) return;
    const active = document.activeElement?.id;
    const paneChoice = $("pane-select")?.value;
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
    if (paneChoice && $("pane-select") && [...$("pane-select").options].some((option) => option.value === paneChoice)) $("pane-select").value = paneChoice;
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
      $("tmux-warning").hidden = !snapshot.tmux_warning;
      $("tmux-warning").textContent = snapshot.tmux_warning ? `Pane discovery: ${snapshot.tmux_warning}` : "";
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
  document.addEventListener("visibilitychange", scheduleRefresh);
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
}

if (typeof document !== "undefined") startDashboard();
