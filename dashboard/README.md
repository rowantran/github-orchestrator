# Local task dashboard

The dashboard shows the server’s task classifications and dependency graph. It uses system fonts and plain JavaScript. It needs no runtime packages, external scripts, font downloads, or build step.

## Run and check

Start the dashboard with `gho dashboard` from a configured repository, then open the loopback URL printed by the command. The Rust server embeds `index.html`, `app.js`, and `style.css`, serves them at `/`, `/app.js`, and `/style.css`, and replaces the HTML token placeholder for that server session. Rebuild the Rust executable after changing an embedded asset.

Run the frontend checks from the repository root with Node.js 20 or later:

```sh
cd dashboard
npm test
npm run build
```

`npm test` runs dependency-free unit tests for filtering, graph layout, counts, URL validation, and snapshot validation. `npm run build` checks JavaScript syntax; there are no generated frontend assets. No install step is needed.

Opening `index.html` directly does not load tasks. The dashboard needs the server API.

For tailnet access, use `gho dashboard --tailscale-serve [--port 8080]`. The command keeps the backend on loopback, manages a temporary Tailscale Serve proxy, and prints the node's HTTP URL. The same relative asset/API URLs work through the proxy. Tailnet access rules control who can read tasks and select panes; there is no dashboard login. See [Tailscale access](../README.md#tailscale-access) for requirements and shutdown behavior.

## Interface

- **All tasks** includes all returned root tasks, including Complete and Closed tasks.
- Workstreams are exact, overlapping groups. For example, `api` and `api/auth` are independent names. A group with no tasks stays available in the selector.
- Search and workstream selection only change what is visible. Task status comes from the server and is never recalculated in the browser.
- Arrows point from blockers to their dependents. Only dependencies whose endpoints are both visible in the configured repository are drawn. Cycles share a graph column and are marked on the affected cards.
- Select a card with a click, Enter, or Space to open its details. Use Tab or arrow keys to move between task cards. Escape closes the details and returns focus to the card.
- Drag the graph background to pan. Use the zoom controls, `+` / `−`, or Control/Command + scroll to zoom. **Fit graph** (or `F` with graph focus) includes every visible task, even when this needs a scale below 12%. Zoom controls work smoothly from that fitted scale. The initial view keeps cards larger for readability. Keyboard focus brings off-screen cards into view.
- Select a task pane, then use **Focus task pane** to select that task’s window and pane in tmux. Clients attached to that session show it. The browser sends only the issue number and pane ID, never a command. Missing panes and server failures have explicit messages.
- Automatic refresh is off by default to limit GitHub API usage. Opt in with **Refresh every 60s**, or use **Refresh** manually. When enabled, automatic refresh runs 60 seconds after the previous request finishes and pauses while the page is hidden. Failed refreshes retain the last successful graph with a visible stale-data warning.

## Local API and safety

Requests to `GET /api/snapshot` and `POST /api/focus` send `X-GHO-Token` from `<meta name="gho-token" content="__GHO_TOKEN__">`. The focus request body is `{ "issue": 42, "pane": "%3" }`. A success response has `message`; non-success responses have `error`.

Task text, including issue descriptions, is rendered as text, not HTML or Markdown. Links must be absolute HTTP(S) URLs on `github.com` without credentials or nonstandard ports. All external links use `noopener noreferrer`. The dashboard does not load images or other resources from task content.

## Browser test selectors

- `#workstream-select`, `#task-search`, `#refresh-button`, `#auto-refresh`
- `#status-legend [data-status-count="done"]` (and the other five API state names)
- `#graph-viewport`, `#graph-state`, `#graph-nodes .task-node`, `#task-42`
- `#graph-edges .dependency-edge[data-from="41"][data-to="42"]`
- `#detail-panel`, `#detail-title`, `#close-detail`
- `#pane-select`, `#focus-pane-button`, `#focus-result`
- `#error-banner`, `#tmux-warning`, `#refresh-status`
- `#zoom-in`, `#zoom-out`, `#fit-graph`, `#zoom-level`

Serve the three static assets and intercept the two API routes to test with synthetic snapshots. No tests need real GitHub mutations or a real tmux session.

`tests/fit-browser.js` exports `checkLargeGraphFit(page, url)` for the integrated Playwright suite. It intercepts the snapshot with 100 independent tasks, verifies every card fits inside the viewport, and checks smooth zooming below 12%. Use a fresh Playwright page and a running local dashboard URL; the helper adds no frontend dependency.
