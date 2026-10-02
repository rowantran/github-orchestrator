# Orchestration browser tests

These tests use the actual TypeScript HTTP server and an in-memory service fixture. They never launch Pi, GitHub, git, tmux, or Tailscale. No real issues, pull requests, credentials, or notes are read or changed.

From the repository root, using Node.js 24:

```sh
npm install
npx tsc
npx playwright install chromium
npx playwright test --config tests/orchestration-browser/playwright.config.ts
```

The Playwright CLI starts Chromium. Each test starts its own real HTTP listener on an OS-selected loopback port. `fixture.mjs` provides task snapshots, run state, agent transcripts, RPC events, and pending dialogs. The tests call the server through the browser, rather than replacing the HTTP API with route mocks. The stale-approval test changes the fixture when the approval is submitted; the large-graph regression supplies a synthetic snapshot.

Coverage includes:
- Workstreams, dependency edges, external blockers, literal task text, and large-graph fit.
- Starting supervised and unsupervised tasks.
- Approval bound to the displayed full commit SHA, including stale-approval rejection.
- Same implementer session across planning and implementation, even when the model changes.
- Pause/resume, live lifecycle badges, and separate reviewer conversations.
- Message nudges, retained drafts, transcripts, streaming assistant text, and live tool output.
- Confirmation, selection, input, and editor-cancellation dialogs.
- Lightweight local polling without repeated GitHub snapshot reads.
- Failed refreshes retaining the previous graph, token failures, and safe rendering of untrusted transcript text.

The HTTP/security tests are in `tests/http.test.ts`. `tests/http-tailscale.test.ts` uses a temporary fake Tailscale executable to check foreground ownership and cleanup; it cannot change real Serve settings. After compiling, run them with:

```sh
node --test dist/tests/http*.test.js
```
