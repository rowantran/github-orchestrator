<!-- Purpose: provide setup, daily operation, and safe recovery steps. Audience: human queue operators. Injection: documentation only; not loaded into workers. -->
# Operations

Run one dispatcher for your personal queue. GitHub remains the source of task scope and completion. Local approvals and attempt records decide what this dispatcher may launch or publish. Do not infer permission from the Project board alone.

Start with the [installation guide](../README.md#install-and-configure). Commands below assume the editable environment is active. Otherwise run `uv run gho` from this repository. Put a custom config before the command: `gho --config /path/to/config.toml status`.

## Configuration and diagnostics

`gho init` resolves an existing GitHub Project and writes a new config; it does not create issues, change Project fields, or edit the source checkout. The queue owner is the issue assignee filter, not necessarily the repository or Project owner. Use `--owner rowantran` for the intended personal queue.

| Config section | Fields |
| --- | --- |
| `[queue]` | `repo`, `owner`, `project_id`, `project_url`, `checkout`, `state_dir`, `workspace_dir`; `base_branch` defaults to `main`. Let `init` resolve the `PVT_…` Project ID. |
| `[worker]` | Required `model`, `provider_extension`, `isara_checkout`; defaults: `thinking = "high"`, `max_workers = 2`, `timeout_seconds = 3600`, `context_files = []`. |
| `[obsidian]` | Optional `vault`, an absolute path to the intended vault. |

Use an exact Isara model ID; there is no implicit model selection. `max_workers` must be an integer from 1–8, and `timeout_seconds` a positive integer, not TOML booleans. `project_id` must be a string. `context_files` must be an array of unique path strings, not a single string. Guidance paths are repository-relative regular tracked files without `..`; they are loaded from Git objects at the fetched base. Include relevant nested guidance explicitly. Automatic context-file discovery is disabled, but later worker file reads can still add context.

Keep state and workspaces in separate dedicated directories under your home, outside the source checkout and outside the Obsidian vault. Keep credentials out of this TOML. Changing a directory is not a migration: preserve the existing journal/worktrees and reconcile all workers before moving anything. Do not create a second state directory to bypass a stuck attempt.

```sh
gh auth status
gh auth refresh -s project
gho doctor
gho doctor --sandbox
```

Required local tools are `git`, `gh`, `wt`, `pi`, `isara`, and `srt`, with Python 3.12+ and Node 22.19+. Worker launch requires **macOS and Pi 0.87.1**. Isara needs its working checkout, `.venv/bin/python`, provider extension, and normal authentication configuration. Grant the authenticated GitHub account access to the repository and Project as well as the `project` scope; a scope does not grant repository membership. Configure Git `user.name` and `user.email` in the ordinary checkout before publication; the host uses that operator identity.

`doctor` performs local prerequisite and GitHub read checks. `doctor --sandbox` also fetches the base, creates a probe worktree, resolves the locked policy, and tests permitted/denied access through the real sandbox runtime. It calls no model. Probe cleanup retains the branch. If a probe fails, inspect any retained worktree and diagnostics; do not broaden permissions or force-remove work as a fix.

For board mirroring, configure a single-select `Status` field yourself:

| Exact option | When the runner tries to mirror it |
| --- | --- |
| `Approved` | An exact reviewed fingerprint is approved. |
| `Running` | A prepared attempt is about to launch. |
| `Review` | Work is ready for review or publication completes. |
| `Needs input` | Worker execution blocks or fails. |
| `Done` | `sync` observes the published PR merged into the configured base. |

Mirroring is best effort, not a transaction with SQLite. Missing options or API failures print warnings to stderr and do not undo local state. Not every local transition updates the board; use `gho status` and `gho runs` to resolve discrepancies. Moving a card never approves, retries, or completes a run.

## Plan and inspect tasks

Use bounded issue bodies with requirements and expected checks. Keep credentials and unrelated personal data out of issues. An eligible issue must be open, in the configured repository, assigned to the queue owner, and enrolled in the configured Project.

```sh
gho task create --title "One bounded change" --body-file /path/to/task.md \
  --blocked-by 41 --blocked-by https://github.com/OWNER/REPO/issues/39
gho board
gho status
gho status --json
gho inspect 42
```

`task create` creates a real assigned issue, adds it to the Project, and records native GitHub blocking relationships. `--blocked-by` is repeatable and accepts comma-separated references. `--note "Tasks/example.md"` optionally adds the new issue to a note association. These are explicit writes, not a preview. Review the body file before invoking the command.

Issue arguments generally accept a local issue number or a full `https://github.com/OWNER/REPO/issues/N` URL. Stored issue URLs use lowercase repository names. `run --issue` accepts a number. Blocker text in the issue body is not parsed into dependency edges.

`status` normally fetches the base and reads GitHub. `status --no-fetch` skips only the Git fetch; it still reads GitHub and is for display, not offline launch authorization. `runs` reads the local journal and works offline.

## Approval and dependencies

```sh
gho context 42
# Read the files in the printed Context bundle directory.
gho approve 42 --fingerprint FINGERPRINT_FROM_CONTEXT
gho run --issue 42 --dry-run
```

Review `system.md`, `append.md`, `task.md`, `isara-bootstrap.txt`, `tool-definitions.json`, and the recorded snapshot in `approval.json`. The preview is a local file bundle, not a model request. Its byte/token estimate is not a bill or a full accounting of later context. The whole approved snapshot is limited to 128 KiB; oversized context fails rather than being truncated.

Approval binds the issue title/body/blockers and reviewed worker inputs. Guidance, model/settings, resources, worker extension source, bootstrap, and queue identity changes can invalidate it. The provider-extension path and contents of top-level `*.ts` and `*.json` files in its directory are also fingerprinted; imported code elsewhere is not fully covered. Comments or Project status changes do not. Base movement alone does not invalidate approval unless a fingerprinted input, such as a guidance file, changed. See the [exact fingerprint coverage](architecture.md#launch-policy-and-approvals).

If the preview fingerprint no longer matches, run `context` again and review the new bundle. Do not copy a fingerprint from an earlier task or approve unread content. `--yes` skips an interactive confirmation; it does not skip the fingerprint or dependency checks.

Dependencies have two distinct completion paths:

- **Code:** The prerequisite issue is successfully completed and has linked merged PR evidence. In the configured repository, that PR must target the configured base and its merge commit must be present in the freshly fetched base. An open, draft, unmerged, or closed-without-merge PR does not satisfy this check. Cross-repository evidence does not establish local code integration.
- **Non-code:** After the prerequisite is closed as completed, the operator may run `gho ack ISSUE`. This records an acknowledgment of that exact issue revision without a code-integration check. Never use it to bypass missing code. Editing the prerequisite's plan invalidates the acknowledgment.

A dependency closed as not planned or duplicate is not successful completion. Inaccessible or inconsistent dependency metadata blocks readiness. Approval does not bypass a blocker; it can be recorded while the task waits.

To withdraw approval:

```sh
gho revoke 42
```

Revocation works while a dispatcher runs. It does not stop the process or undo an already completed external write. It prevents later publication checks from accepting that approval. There is no `gho cancel` command; see interruption recovery below.

## Run, review, and publish

```sh
gho run --issue 42 --dry-run
gho run --issue 42
# Or: gho run, to consider all currently ready tasks.
gho runs --json
gho logs RUN_ID --follow
```

`run` takes one queue snapshot, waits for the selected attempts, and returns. It is not a daemon; it does not keep launching newly unblocked work. Each attempt fetches and rechecks its task before launch. The dispatcher respects `max_workers` and refuses to start over unreconciled preparing/running attempts. A prior failed or blocked attempt requires explicit retry. `run` exits 1 if any returned attempt is failed, blocked, or interrupted; an operator interrupt exits 130. A zero exit code can also mean no eligible work was launched, so inspect the output.

Review the worktree and retained records before publication. Set `WORKTREE` to the exact path from `gho runs --json` and inspect, for example:

```sh
git -c core.fsmonitor=false -C "$WORKTREE" status --short
git -C "$WORKTREE" diff --no-ext-diff --no-textconv --stat
git -C "$WORKTREE" diff --no-ext-diff --no-textconv
git -C "$WORKTREE" ls-files --others --exclude-standard
```

The diff alone omits untracked contents; read those files too. Check the worker's reported tests against logs and scope. Tests/setup from the target repository are untrusted code: do not rerun them as host-side hooks or unprotected shell commands. Keep execution inside the qualified sandbox.

A reviewable run must have a stopped worker and valid handoff. A worker's `ready_for_review` is a request for human review, not task completion. The operator publication step is:

```sh
gho publish RUN_ID
```

The CLI shows changed paths and asks for confirmation. The host stages the changes, commits with the operator identity from the normal checkout, pushes without force, and opens a draft PR containing a closing issue reference and reported checks. Git/Worktrunk hooks remain disabled. Publication does not rerun tests, rebase, merge, or close the issue directly. Approval, ownership, and prerequisites are checked again during this sequence against the attempt's recorded base. An existing unambiguous open PR for the same branch/base can be recovered rather than duplicated.

Review and merge in GitHub through your normal process, then:

```sh
gho sync
gho clean RUN_ID
```

`sync` observes published PRs; it does not merge them. `clean` requires a run recorded as merged and no live worker process group. It retains the branch and copies sessions into attempt logs before ordinary, non-forced Worktrunk removal. Dirty or otherwise unsafe cleanup can refuse; inspect rather than forcing it. Failed worktrees are deliberately retained.

## Logs and private data

Use `gho logs RUN_ID` for rendered progress, `--events` for raw JSON events, or `--follow` while its recorded process group exists. `gho runs --json` includes paths, process IDs, metadata, and recorded commit/PR information.

Under `<state_dir>/attempts/<run-id>/`, inspect:

- `input/`: the host copy of reviewed prompts, manifest, approval snapshot, and worker resources.
- `command.json` and `sandbox.json`: launch arguments and resolved policy.
- `events.jsonl` and `stderr.log`: worker events and diagnostics.
- `effective-context.json` and `result.json`, when captured successfully.
- `sessions/`, after cleanup copies the worktree's `.gho/sessions/` here.

A failure can happen before some files are created or copied; inspect the retained worktree too. Zero process exit status is not enough: the event stream must show a settled successful assistant turn, the audit must match the host's frozen inputs, and the result must satisfy its schema. Timeouts and excessive captured output stop the worker and keep its work.

The host parses the audit JSON and compares every manifest field, working directory, and context path against its frozen input copy. It checks for the complete approved system, append, task, and bootstrap text, and exact recorded tool definitions. Missing or inconsistent evidence fails the attempt.

The effective-context audit is still writable by the worker process and is **not an attestation**. Matching expected content does not prove the file's origin. It covers the pre-request hook, not all subsequent reads, compaction, or provider requests. Worker tool output and provider strings are not all owned by `agent-context/`.

Logs can contain issue bodies, source code, model output, and sensitive material. Keep state, sessions, and backups private. Do not upload them unreviewed or treat redaction as automatic. Back up SQLite through a consistent SQLite backup or while all journal writers are stopped; copying only a live WAL-mode database file can omit recent data. Preserve the matching workspaces and vault association registry as well.

## Recovery: preserve first, retry deliberately

### Interrupted or crashed dispatcher

1. Run `gho runs --json` and inspect logs, worktrees, and recorded PIDs. A worker may outlive its dispatcher. Check actual OS processes before concluding that it stopped; process IDs can be reused.
2. Run `gho recover`. It marks stopped preparing/running attempts `interrupted`; it does not restart them or remove work. A recorded live process group remains untouched.
3. If an attempt has **no recorded PID**, the dispatcher may have crashed after spawning but before saving it. Check processes by worktree/session/command and stop any surviving worker deliberately. Only after confirming no worker remains, run `gho recover --confirm-stopped`. Add `--yes` only after performing that check.
4. Inspect retained edits before deciding whether to retry. For a failed, blocked, or interrupted attempt:

   ```sh
   gho retry RUN_ID
   gho context ISSUE
   # Reapprove if the reviewed plan/context changed.
   gho run --issue ISSUE
   ```

   Retry authorizes a **fresh attempt**; it preserves but does not resume or copy the old work. There is no automatic promotion of a recovered result to reviewable status. Keep useful changes for deliberate manual reconciliation rather than deleting the journal.

An interactive interrupt during `run` requests worker shutdown. An abrupt terminal/machine failure is different: verify surviving processes. Do not delete `runner.lock` to bypass a running operation; the lock is held by the OS, not by the presence of that file. Do not reset SQLite, reuse an old worktree, force-push, or force-clean to make recovery appear successful.

### Publication stopped partway through

Commit, SQLite update, Git push, and GitHub PR creation are separate side effects. There is no cross-system transaction.

- **Recorded commit, push/API failure:** Inspect the local commit, worktree, remote branch, and GitHub PRs. If the worktree is unchanged and approval still matches, repeat `gho publish RUN_ID`; recorded commits and an existing matching open PR support this recovery path.
- **Commit succeeded before its SHA was journaled:** Publication can refuse an unexpected `HEAD`. Preserve the branch/worktree and inspect it against `base_commit`. There is no CLI repair command for this window. Reconcile delivery manually with an explicit operator decision; do not rewrite SQLite or discard the commit to bypass the guard.
- **Push or PR creation timed out:** The remote write may have succeeded. Inspect GitHub before retrying. Closed, wrong-base, or ambiguous same-branch PRs require manual resolution rather than duplicate creation.
- **Approval revoked or task changed during publication:** Stop and review. Revocation cannot undo a commit, push, or PR already created. Existing artifacts must be reconciled explicitly; no automatic rollback or merge occurs.

A late crash can also leave a completed worker recorded as running. `recover` preserves its files but does not assume that its output was already validated. Never infer successful publication or task completion from the presence of a result file alone.

### Issue creation stopped partway through

If `task create` reports an issue URL and an enrollment, dependency, or note-link failure, repair **that issue**. Do not run create again. Inspect its assignee, Project membership, native blockers, and note association. An API timeout may leave an issue even without a confirmed response; search GitHub for the intended task before creating another.

## Optional TaskNotes operations

Build and install from the local editable checkout:

```sh
(cd obsidian-plugin && npm ci && npm test && npm run build)
gho notes install
gho notes link "Tasks/example.md" 42 43
gho notes list
```

Set `[obsidian].vault` first. Install copies `main.js` and `manifest.json`; it does not enable the plugin. Enable it manually in Obsidian. TaskNotes must expose runtime `tasks.write` and `tasks.events`; its HTTP API/MCP need not be enabled.

`notes link` replaces the entire issue set. `task create --note` adds the new issue while preserving the existing set. Native notes use a stable association ID and path; Notion-backed task notes also use `notion_page_id` to survive cache-path changes. Repair ambiguous identity or an offline native rename explicitly; do not guess by title.

```sh
gho sync --complete-notes
```

Before creating a request, this checks **every linked issue** with the same rule as dependencies: closed as completed, plus verified merged code or an exact operator non-code acknowledgment. Same-repository code must be integrated into the fetched base. Mere closure is insufficient.

Existing `pending`, `processing`, `local-accepted`, and `already-done` requests are skipped, not duplicated. The plugin validates the association and exact issue set; it has no GitHub client and does not continuously recheck remote state. Unprocessed requests expire after 24 hours.

Inspect `<vault>/.github-orchestrator/requests/` and `receipts/` before requesting again. Run **GitHub Orchestrator Bridge: Refresh issue links and completion requests** in Obsidian if needed. A queued request is not completion. `local-accepted`/`already-done` describes local TaskNotes state; `notionConfirmed` remains false. The bridge calls TaskNotes to set `Done`, never writes completion YAML directly, and never calls Notion. Verify canonical Notion state through your existing integration if that matters.

Failures, stale requests, interruptions, and rollbacks need receipt review and an explicit retry:

```sh
gho sync --complete-notes --retry-note-completion
```

This rechecks GitHub before creating a new request; it does not override a pending or accepted request. A leftover `processing` receipt becomes `interrupted`, not an automatic replay of a possibly completed side effect. Do not schedule blind completion retries. Stop all bridge users before removing a proven stale `.github-orchestrator/lock/`; never use cloud sync as a cross-device lock. See the [complete bridge contract](../obsidian-plugin/README.md) for formatting, receipts, and recovery limits.
