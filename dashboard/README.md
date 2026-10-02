# Local task dashboard

The dashboard shows the task dependency graph and live local execution state. Select a task to start work, review and approve its skeleton commit, pause or resume it, and chat with its implementer or reviewer. Agent transcripts, tool results, streaming output, and pending dialogs stay in the browser; no terminal takeover is needed.

The frontend uses system fonts and plain JavaScript. It needs no runtime packages, external scripts, font downloads, or frontend build step.

## Run and check

Start the dashboard with `gho dashboard` from a configured repository, then open the printed URL. The TypeScript server in `orchestrator/http.ts` serves `index.html`, `app.js`, and `style.css` at `/`, `/app.js`, and `/style.css`. It inserts the per-process session token into the page. The graph, execution controls, and agent conversations use this service API.

Run the frontend checks from the repository root with Node.js 24 or later:

```sh
cd dashboard
npm test
npm run build
```

`npm test` runs dependency-free unit tests for filtering, graph layout, counts, URL validation, and snapshot validation. `npm run build` checks JavaScript syntax; there are no generated frontend assets. No install step is needed.

Opening `index.html` directly does not load tasks. The dashboard needs the server API.

For tailnet access, use `gho dashboard --tailscale-serve [--port 8080]`. The command keeps the backend on loopback, manages a temporary Tailscale Serve proxy, and prints the node's HTTP URL. The same relative asset/API URLs work through the proxy. Tailnet access rules control who can read tasks and agent transcripts, start or steer agents, approve skeletons, and pause/resume tasks; there is no dashboard login. See [Local and tailnet access](../README.md#local-and-tailnet-access) for requirements and shutdown behavior.

## Interface

- **All tasks** includes all returned root tasks, including Complete and Closed tasks.
- Workstreams are exact, overlapping groups. For example, `api` and `api/auth` are independent names. A group with no tasks stays available in the selector.
- Search and workstream selection only change what is visible. Task status comes from the server and is never recalculated in the browser.
- Arrows point from blockers to their dependents. Only dependencies whose endpoints are both visible in the configured repository are drawn. Cycles share a graph column and are marked on the affected cards.
- Select a card with a click, Enter, or Space to open its details. Use Tab or arrow keys to move between task cards. Escape closes the details and returns focus to the card.
- Drag the graph background to pan. Use the zoom controls, `+` / `−`, or Control/Command + scroll to zoom. **Fit graph** (or `F` with graph focus) includes every visible task, even when this needs a scale below 12%. Zoom controls work smoothly from that fitted scale. The initial view keeps cards larger for readability. Keyboard focus brings off-screen cards into view.
- Automatic refresh is off by default to limit GitHub API usage. Opt in with **Refresh every 60s**, or use **Refresh** manually. When enabled, automatic refresh runs 60 seconds after the previous request finishes and pauses while the page is hidden. Failed refreshes retain the last successful graph with a visible stale-data warning.

## Task execution and agent conversations

- **Start task** is available for ready tasks. Supervised mode stops after planning for skeleton approval. Unsupervised mode proceeds without that approval. The service validates readiness again when starting.
- **Approve this skeleton** sends the full commit SHA displayed in the panel. A stale SHA is rejected; approval never silently transfers to a new skeleton revision.
- Planning and implementation share the same implementer Pi session. The model may change between phases. The reviewer has a separate session and conversation selector.
- **Pause task** and **Resume task** change service execution state. Sending a message does not itself approve a skeleton or unpause a task.
- **Send message** nudges the selected agent. The service decides whether to steer active work or queue feedback for its next turn. Message drafts survive polls and agent-role switches; failed sends retain the draft.
- Agent messages and tool calls/results are plain text. Live assistant deltas and tool output are shown while work proceeds. Recent raw RPC events can be expanded for diagnostics. Images are not loaded from transcripts.
- Pending confirmation, selection, input, and editor dialogs can be answered or cancelled in the browser.
- Local runs and the selected agent view update every 1.5 seconds, without overlapping polls. Hidden tabs pause polling. This does not call GitHub. GitHub graph refresh remains manual or opt-in every 60 seconds.

## Local API and safety

Every `/api/` request sends `X-GHO-Token` from `<meta name="gho-token" content="__GHO_TOKEN__">`. The TypeScript server exposes:

| Method and path | Body / result |
| --- | --- |
| `GET /api/health` | `{ "ok": true }`, without reading GitHub or agent state. |
| `GET /api/snapshot` | Full GitHub task graph. Concurrent refreshes share one request. |
| `GET /api/runs` | Array of local run records. |
| `GET /api/runs/:issue` | One run record. |
| `POST /api/runs/:issue/start` | `{ "mode": "supervised" }` or `"unsupervised"`. |
| `POST /api/runs/:issue/approve` | `{ "sha": "<full commit SHA>" }`; optional `actor` is descriptive, not authentication. |
| `POST /api/runs/:issue/pause` | `{}`. |
| `POST /api/runs/:issue/resume` | `{}`. |
| `GET /api/runs/:issue/agents/:role` | Agent status, messages, events, and pending dialogs. |
| `POST /api/runs/:issue/agents/:role/messages` | `{ "text": "..." }`. |
| `POST /api/runs/:issue/agents/:role/responses` | Dialog `id` plus `value`, `confirmed`, or `cancelled`. |
| `POST /api/shutdown` | `{}`; available only if the service provides a shutdown callback. Acknowledges before shutdown. |

Roles are `implementer` and `reviewer`; arbitrary agent names, commands, RPC methods, and filesystem paths are not exposed. Non-success responses contain an actionable `error` string. A request timeout does not cancel a mutation already running in the service: refresh local state before retrying.

The server binds only to `127.0.0.1`. Exact Host and Origin checks, singleton security headers, the per-process token, bounded bodies, absolute request deadlines, and a content security policy protect the API. Tailscale mode adds only validated node authorities and manages an owned foreground Serve process; it refuses occupied or Funnel-enabled ports and never resets shared configuration. No GitHub credentials are sent to the browser.

Task text, including issue descriptions, is rendered as text, not HTML or Markdown. Links must be absolute HTTP(S) URLs on `github.com` without credentials or nonstandard ports. All external links use `noopener noreferrer`. The dashboard does not load images or other resources from task content.

## Browser test selectors

- `#workstream-select`, `#task-search`, `#refresh-button`, `#auto-refresh`
- `#status-legend [data-status-count="done"]` (and the other five API state names)
- `#graph-viewport`, `#graph-state`, `#graph-nodes .task-node`, `#task-42`
- `#graph-edges .dependency-edge[data-from="41"][data-to="42"]`
- `#detail-panel`, `#detail-title`, `#close-detail`
- `#error-banner`, `#runtime-status`, `#refresh-status`
- `#zoom-in`, `#zoom-out`, `#fit-graph`, `#zoom-level`

Execution selectors include `#run-list`, `#run-panel`, `#run-mode`, `#start-task`, `#run-phase`, `#skeleton-sha`, `#approve-skeleton`, `#pause-task`, `#resume-task`, `#run-action-result`, `#agent-role`, `#agent-session`, `#agent-transcript`, `#agent-message`, `#send-agent-message`, and `#agent-dialogs`.

See [`tests/orchestration-browser/README.md`](../tests/orchestration-browser/README.md) for Playwright CLI tests against the actual TypeScript server and a synthetic service. They cover graph filters, safe links, keyboard navigation, large-graph fit, task controls, and agent conversations without real GitHub or model calls.
