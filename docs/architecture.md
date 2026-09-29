<!-- Purpose: explain ownership, execution policy, and extension points. Audience: operators and maintainers. Injection: documentation only; not loaded into workers. -->
# Architecture

GitHub Orchestrator is a local, single-dispatcher tool for a personal GitHub queue. The intended queue is work in the Isara monorepo assigned to `rowantran` and enrolled in a chosen GitHub Project. Configuration can select another repository or owner without changing the design.

The important boundary is between **implementing** and **delivering**. A worker can edit and test a task. Only the operator can approve the reviewed inputs and authorize `gho publish`. The host publishes a draft PR; a human decides whether to merge it.

```text
GitHub issues + Project + native blocking dependencies
                   │ read current task and ownership
                   ▼
     context preview → explicit operator approval
                   │ local fingerprint + snapshot
                   ▼
        dispatcher → Worktrunk task worktree
                   │ isara pi run --profile locked
                   ▼
      sandboxed Pi → uncommitted edits + result + logs
                   │ operator reviews work
                   ▼
          gho publish → commit → push → draft PR
                   │ human review and merge
                   ▼
       gho sync → merged run → optional gho clean
                   └→ optional TaskNotes completion request
```

## What owns each fact

| Owner | Authoritative facts |
| --- | --- |
| GitHub issues | Title, body, assignees, native blocking relationships, open/closed state and completion reason. |
| GitHub Project | Queue membership and a human-facing status display. Status is not authorization or dependency evidence. |
| GitHub PRs and fetched Git history | PR state and whether same-repository prerequisite code is integrated into the configured base. |
| Local SQLite journal | Reviewed approvals, explicit non-code acknowledgments, and run attempts. It is not a second task database. |
| Operator | Scope review, approval/revocation, publication, merge, retry, cleanup, and ambiguous recovery decisions. |
| Worker | Scoped code/test changes and a structured handoff. It cannot authorize its own launch or publication. |
| Optional vault bridge | Explicit note-to-issue associations and completion request/receipt history, not GitHub task state. |

The queue includes only open issues in the configured repository assigned to the configured owner and enrolled in the configured Project. It is not every issue in that Project. GitHub metadata errors block decisions; an inaccessible Project must not appear as an empty queue.

Status mirroring uses an existing single-select field named exactly `Status`, with exact options `Approved`, `Running`, `Review`, `Needs input`, and `Done`. The adapter does not create fields/options. Mirroring is best effort: a failed update must not erase local approval or run state. The CLI prints mirror warnings to stderr. A stale board must be checked against `gho status` and `gho runs`.

## Launch policy and approvals

`gho context` snapshots the reviewed inputs without a model call. `gho approve --fingerprint` rereads them and refuses a stale preview. The approval fingerprint covers:

- Issue URL, title, body, and sorted native blocker URLs.
- Explicit tracked guidance file paths and complete contents at the fetched base.
- Model, thinking level, timeout, provider-extension path, locked profile, and required Pi version.
- Content hashes of top-level `*.ts` and `*.json` files in the provider extension's directory.
- The mandatory Isara bootstrap, authored resource hashes, and worker TypeScript source hashes.
- Queue repository, owner, Project ID, and base-branch name.
- The authored sandbox override, including its read/write paths. The full resolved upstream policy is also recorded and probed at launch.

A change to any of these inputs requires another preview and approval. Comments and Project status are not part of the approved task. The base commit itself is recorded for each attempt, but is not part of this fingerprint: an ordinary base advance need not invalidate approval if the explicit guidance remains unchanged. Provider hashing is limited to those top-level files; it does not recursively cover imported code or all upstream dependencies. The fingerprint is not a hash of the entire repository or Isara launcher. Treat installed components as trusted dependencies and review upgrades separately.

Readiness also requires current ownership, an open issue, no unresolved previous attempt, and satisfied prerequisites. These are separate checks, not extra meanings assigned to the fingerprint. A new attempt rechecks ownership, approval, context, and dependencies after preparation. Publication rechecks approval, task ownership, and prerequisites using the attempt's recorded base and guidance, not a newly fetched base. It does not merge or rebase the worker branch.

A blocking issue must be closed with reason `COMPLETED`; `NOT_PLANNED` and duplicate closure are not success. For same-repository code, a linked merged PR must target the configured base and its merge commit must be an ancestor of the fetched base. Cross-repository prerequisites use their linked merged PR evidence; this does not prove integration into the local monorepo. For genuinely non-code work, an operator can use `gho ack` after completion. That acknowledgment is bound to the prerequisite's exact title/body/blocker revision. It is not a way to bypass an unmerged code dependency. Optional TaskNotes completion uses this same rule for every linked issue before creating a request.

`gho revoke` removes local approval even while dispatch is running. It does not terminate the worker; later publication must still be refused without matching approval. Project status changes do not revoke or restore approval.

## Attempts and persistence

Each attempt gets a unique `gh-N-…` ID, a branch under `<owner>/agents/`, a fresh worktree, and separate logs. The normal progression is:

```text
preparing → running → review → published → merged
                └──→ blocked / failed / interrupted
```

Preparation can also fail. `gho retry` only accepts failed, blocked, or interrupted attempts; it marks the old attempt `superseded`. The next `gho run` creates a new attempt from the latest fetched base. It does not resume the old session or copy its edits. A successful review result requires operator publication, not an automatic retry.

The dispatcher holds an OS file lock and uses SQLite uniqueness constraints to prevent conflicting local attempts. `max_workers` limits parallel workers within that dispatcher. Surviving or uncertain workers after a crash block further dispatch until reconciled. This is not a lease protocol: do not run multiple machines against copied/cloud-synced state, or independent state directories against the same personal queue.

Default layout as the queue is used:

```text
~/.config/github-orchestrator/config.toml
~/.local/state/github-orchestrator/<repo>--<owner>/
  runs.sqlite3                 # approvals, acknowledgments, run journal
  runner.lock                  # OS-backed dispatcher lock
  previews/                    # review bundles
  attempts/<run-id>/            # input copy, command, events, diagnostics, outputs
~/.local/share/github-orchestrator/<repo>--<owner>/
  repository/                  # independent managed clone and sandbox policy
  tasks/<run-id>/               # Worktrunk worktree
    .gho/input/                # reviewed inputs and worker/resource copies
    .gho/bin/                  # isolated Pi launcher shim
    .gho/home/                 # isolated worker home
    .gho/tmp/
    .gho/sessions/
    .gho/effective-context.json
    .gho/result.json
```

In the directory slug, `/` in the repository name becomes `--`. The ordinary source checkout supplies the initial Git database and operator commit identity. The managed clone has no alternates or hardlink dependency on it, and fetches the configured GitHub base. Uncommitted source-checkout changes are not worker input. Worktrunk and Git hooks are disabled for host-side lifecycle operations; setup and tests remain untrusted worker work, not host hooks.

## Worker boundary

`Sandbox` resolves the real locked profile through Isara and probes the OS boundary before each launch. Current worker support is macOS Seatbelt only, with Pi pinned to 0.87.1. Missing tools, an unexpected policy, or a failed probe prevent launch; there is no permission downgrade.

The policy grants task-local writes but denies writes to reviewed `.gho/input`, the launcher shim, shared Git metadata, runner state, and the managed clone. It retains the locked profile's ambient-home denial and rejects host socket/keychain service grants. Network access is enabled for the worker; this is not an offline sandbox or an output-exfiltration guarantee. Isara owns credential provisioning and policy resolution.

The launcher disables automatic Pi extensions, skills, prompt templates, themes, context files, and built-in tools. It loads only the explicit Isara provider followed by the worker extension. A shim sets an isolated Pi home inside the sandbox because Isara scrubs inherited `PI_*` variables. Explicit repository guidance and Isara's mandatory bootstrap remain in the prompt. The bootstrap can instruct later repository reads; those are additional tool context, not automatic guidance discovery.

The extension supplies exactly `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Registration metadata comes from `agent-context/`; execution uses pinned Pi tool implementations. The pre-request hook verifies the selected tools, schemas, and explicit context, then writes `.gho/effective-context.json`. A failed hook exits before a model request.

After the worker exits, the host parses the audit JSON and checks it against the frozen host input copy. Every manifest field, the worktree, and the context path must match. The effective prompts must contain the complete approved system, append, task, and bootstrap text. Recorded tool names, descriptions, schemas, snippets, and guidelines must match exactly, ignoring tool order; UI labels are not audit fields. Missing or inconsistent audit evidence fails the attempt before result acceptance.

**The effective-context file is writable evidence, not an attestation.** These consistency checks do not prove its origin: the same worker process can overwrite it. It describes the hook boundary, not every later request, tool result, provider conversion, or compaction. The host retains logs and output files for review; neither an audit file nor the worker's success claim proves code correctness. See the full [context contract](context.md).

All authored model-facing instructions, templates, schemas, tool metadata, and extension messages belong in `agent-context/`, with purpose/audience/injection metadata. This does not own or sanitize runtime Pi tool errors, command output, file contents, native validation messages, Pi framing, or provider strings. Prompt separation is not protection against prompt injection; the OS sandbox is a separate control.

## Code ownership and extension points

Keep changes in the existing modules rather than adding a plugin framework or another task store.

| Module | Responsibility and natural extension point |
| --- | --- |
| `src/github_orchestrator/cli.py` | Human commands and confirmations. Add operator actions here, with policy enforced below the CLI too. |
| `config.py`, `domain.py` | Explicit queue configuration and shared value types. Add validated configuration here, not implicit environment-dependent worker behavior. |
| `runner.py` | Readiness, approval, dispatch, result handling, publication, merge observation, recovery. This owns policy, not the GitHub adapter or worker. |
| `github.py` | GitHub.com reads/writes through `gh`; paginated metadata and identity checks. New API behavior must reject missing/partial evidence. |
| `state.py` | SQLite approvals/acknowledgments/attempts and local locks. Preserve old work and test restart behavior when changing transitions. |
| `workspace.py` | Independent clone, fetched base, Worktrunk lifecycle, host commit/push, safe cleanup. Never add repository setup hooks on the host. |
| `sandbox.py` | Isara policy resolution, probe, environment isolation. A new OS needs a tested adapter, not a fallback to unsandboxed execution. |
| `context.py`, `agent-context/` | Fingerprint inputs, resource rendering, and per-attempt snapshots. New worker context must be reviewable and invalidate approval when appropriate. |
| `process.py` | Argument-array subprocess execution with bounded failures; no shell evaluation of task text. |
| `pi/worker.ts`, `pi/context.ts`, `pi/resources.ts` | Tool adapters, pre-request verification, and resource loading. Keep authored model prose out of TypeScript. |
| `notes.py`, `obsidian-plugin/src/` | Optional local association/request/receipt protocol and TaskNotes completion. No GitHub credentials or direct Notion client in the plugin. |

`Runner` accepts adapter instances for tests. Use that seam for test doubles and focused changes; do not create a general scheduler abstraction before there is a concrete need. Adding a tool or changing Pi requires coordinated resource/schema, launch/audit, sandbox, and test review. Merely editing a prompt does not grant permissions.

The [operations guide](operations.md) covers recovery and external side-effect windows. Tests must use temporary repositories and vaults, exercise failures/restarts, and avoid real GitHub writes or paid model requests. See [development commands](../README.md#development-and-further-reading).
