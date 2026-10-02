# Orchestration browser tests

These tests use the actual TypeScript HTTP server and an in-memory service fixture. They never launch Pi, GitHub, git, or Tailscale. No real issues, pull requests, credentials, or notes are read or changed.

From the repository root, using Node.js 24:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

The Playwright CLI starts Chromium. Each test starts its own real HTTP listener on an OS-selected loopback port. `fixture.mjs` provides task snapshots, run state, agent transcripts, RPC events, and pending dialogs. The tests call the server through the browser, rather than replacing HTTP responses with route mocks. The stale-approval test changes the fixture when the approval is submitted. The large-graph test updates the service's task list and uses the real snapshot endpoint. The expired-token test alters a request header so the server itself rejects it.

A shared browser fixture blocks unexpected external requests. PR popups receive local test HTML at the requested GitHub URL, so navigation and opener isolation are tested without connecting to GitHub. Each test also fails on browser JavaScript errors.

Coverage includes:
- All six task states, completed/closed work, local dependency edges, and external blocker details.
- Exact overlapping workstreams, independent slash names, hidden blockers, search, empty groups, deep links, and browser history without changing readiness.
- Literal issue text, rejected unsafe URLs, and draft/open/merged PR links that remain above long content and open without an opener.
- Fitting 100 tasks below 12% zoom, smooth zoom controls, keyboard navigation to distant cards, and Escape focus restoration.
- Starting supervised and unsupervised tasks.
- Approval bound to the displayed full commit SHA, including stale-approval rejection.
- Same implementer session across planning and implementation, even when the model changes.
- Pause/resume, live lifecycle badges, and separate reviewer conversations.
- Message nudges, retained drafts, transcripts, streaming assistant text, and live tool output.
- Confirmation, selection, input, and editor-cancellation dialogs.
- Lightweight local polling without repeated GitHub snapshot reads.
- Failed refreshes retaining the graph and selected task, successful refresh recovery, expired-token recovery, and inert transcript text.

The HTTP/security tests are in `tests/http.test.ts`. `tests/http-tailscale.test.ts` uses a temporary fake Tailscale executable to check foreground ownership and cleanup; it cannot change real Serve settings. After compiling, run them with:

```sh
node --test dist/tests/http*.test.js
```
