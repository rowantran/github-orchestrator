# Optional Obsidian TaskNotes bridge

This desktop-only plugin displays explicit GitHub issue links in task notes and applies explicit completion requests through TaskNotes. It has no network client, credentials, worker prompts, or scheduled polling. GitHub Orchestrator works without this plugin.

**The caller must verify every associated GitHub issue is completed before calling `Notes.request_completion`.** The plugin checks the request against the current association, not GitHub. A closed issue marked “not planned” is not successful completion.

## Build and test

```sh
cd obsidian-plugin
npm ci
npm test
npm run build
```

Tests use pure helpers, fake completion ports, and temporary directories. They do not access a real vault. `main.js` is generated and Git-ignored. Building does not install or enable anything. To install later, deliberately copy `manifest.json` and the built `main.js` into a chosen vault's `.obsidian/plugins/github-orchestrator/`, then enable the plugin in Obsidian.

TaskNotes must expose its runtime `tasks.write` and `tasks.events` capabilities. Its HTTP API and MCP can stay disabled. Run **GitHub Orchestrator Bridge: Refresh issue links and completion requests** to reconcile manually. Otherwise the plugin reconciles on layout readiness, relevant vault/metadata events, and a debounced filesystem watcher on the hidden bridge directory. If the watcher is unavailable, the notice directs you to the manual command.

## Python interface

```python
from pathlib import Path
from github_orchestrator.notes import Notes

notes = Notes(Path("/path/to/your/vault"))
link = notes.link("Tasks/example.md", ["https://github.com/example/repo/issues/1"])
links = notes.links()
# Only after the caller verifies ALL current link["issueUrls"] are completed:
request = notes.request_completion(link)
```

- `link` replaces the complete issue set; it does not append implicitly. `add(note_path, issue_urls)` atomically unions issues with the existing association and preserves its stable ID. Use `add` for task creation with a note, and `link` for explicit whole-set replacement. Repeated additions are idempotent. URLs are canonical lowercase, unique, and sorted. The set must be nonempty.
- `link` preserves the existing association ID and infers `notionPageId` from safe `notion_page_id` YAML. Only `type: task` notes are accepted. YAML aliases are rejected.
- `links` returns current associations. `request_completion` rejects a stale association dictionary. A successful call means **queued**, not completed.
- `completion_state(link)` returns `None`, or the latest exact-set request's `{status, requestId, requestedAt, issueFingerprint, receipt}`. Without a receipt, status is `pending`, or `stale` after 24 hours. Otherwise status comes from the validated receipt. Callers can suppress duplicate pending/accepted requests and require an explicit retry after terminal failure. Existing accepted receipts do not expire. This lookup and explicit request creation are separate locked operations; callers must serialize competing sync runs if they need atomic duplicate suppression.
- Each explicit `request_completion` call creates a new request ID. Only make another call after inspecting the previous receipt and deliberately choosing to retry. Requests are not generated automatically from note status.
- Paths are vault-relative Markdown paths; traversal, hidden note folders, backslashes and symlinks are rejected. Bridge symlinks are also rejected. The bridge assumes trusted local processes; it is not a security boundary against concurrent malicious filesystem replacement.
- Python never writes task Markdown, frontmatter, or completion status.

## File contract (schema version 1)

Everything lives in `<vault>/.github-orchestrator/`, **outside** the generated `Tasks/Notion` cache:

```text
links.json
requests/<request-uuid>.json
receipts/<request-uuid>.json
lock/                         # only while a cooperating reader/writer holds it
```

`links.json`:

```json
{
  "schemaVersion": 1,
  "links": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "notePath": "Tasks/example.md",
    "issueUrls": ["https://github.com/example/repo/issues/1"]
  }]
}
```

A Notion association also has `notionPageId`, normalized to a lowercase dashed UUID. That ID is authoritative; the plugin resolves it through Obsidian metadata and updates `notePath`. Duplicate identities fail closed. Native notes use the path and a stable association UUID; Obsidian rename events update the registry. Native renames made while the plugin is disabled cannot be inferred safely; restore the old path or deliberately repair the association. Do not guess from a title.

A completion request contains `schemaVersion`, UUID `id`, `linkId`, the exact sorted `issueUrls`, `issueFingerprint`, and UTC ISO `requestedAt`. The fingerprint is SHA-256 of the UTF-8 compact JSON URL array (`JSON.stringify` in TypeScript; `json.dumps(..., separators=(",", ":"))` in Python). Immediately before completion, the plugin requires both the current link ID and exact issue set to match. An unprocessed request older than 24 hours receives a terminal `stale` receipt without calling TaskNotes; recheck GitHub before explicitly requesting again. This limits offline delay but does not revalidate GitHub within the 24-hour window. A rename alone does not invalidate the issue set.

The shared lock is an exclusively created directory. Both implementations retry briefly, then fail with an actionable error. JSON writes use a same-directory temporary file, file sync, and atomic rename. Never delete an active lock. If a process crashes, stop all bridge users before removing a stale `lock/`. Do not run multiple devices against a cloud-synced bridge directory concurrently; cloud sync is not a distributed lock. Back up `links.json`; request/receipt files are local operational history. No Git configuration is changed automatically.

## Note formatting and completion

The plugin owns only this block:

```markdown
<!-- github-orchestrator:links:start -->
### GitHub issues

- [example/repo#1](https://github.com/example/repo/issues/1)
<!-- github-orchestrator:links:end -->
```

For `notion_managed: true` notes, the block is inside `## Local notes`, after Notion's managed section. If Local notes is missing but the Notion managed-end marker exists, the plugin appends that section. Ambiguous markers, misplaced blocks, duplicate Local notes sections, and unterminated code fences fail without rewriting the note. Native notes get an appended block. Existing text outside the block, line endings, checkboxes, and YAML are preserved by this plugin. Notion's own renderer may normalize surrounding whitespace during its later refresh.

Completion uses only:

```ts
api.tasks.setStatus(path, "Done", {
  source: "github-orchestrator",
  reason: "All explicitly linked GitHub issues were verified completed by GitHub Orchestrator."
});
```

This lets TaskNotes manage completion dates, modified timestamps, events and its other side effects. TaskNotes can normalize YAML formatting. There is no direct frontmatter fallback. The existing Notion Task Sync plugin, if present, can observe this event and send completion to Notion.

## Receipts and retries

Receipts contain `requestId`, `linkId`, `issueFingerprint`, `status`, `detail`, `recordedAt`, optional `notePath`, and **`notionConfirmed: false`**.

| Status | Meaning |
| --- | --- |
| `processing` | Durable claim written before the TaskNotes side effect. |
| `local-accepted` | TaskNotes returned and the note currently says Done; Notion is not confirmed. |
| `already-done` | Local status was already Done; no status call made. |
| `api-unavailable` | Enable/update TaskNotes, then explicitly request again. |
| `stale` | Association/issue set changed, or the unprocessed request is older than 24 hours; recheck GitHub before requesting again. |
| `failed` | The attempt failed; inspect local/Notion state before retrying. |
| `rolled-back` | Done did not persist, or later changed; this can be remote rejection or a deliberate reopen. |
| `interrupted` | A previous process stopped with only a claim; inspect state before retrying. |

An existing receipt prevents replay. A leftover `processing` claim becomes `interrupted` rather than retrying a possibly completed side effect. Later events/manual refresh can change accepted receipts to `rolled-back` if the task is no longer Done. Failures and rollbacks never trigger automatic completion retries. The plugin cannot confirm Notion persistence: consult Notion Task Sync's notice or the canonical Notion task. Missing/uncached notes alone do not prove rollback.

All notices are human Obsidian UI messages. No content is sent to an agent or an external service by this bridge.
