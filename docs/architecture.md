<!-- Purpose: explain implementation ownership and recovery boundaries. Audience: maintainers. Injection: documentation only. -->
# Architecture

The TypeScript service is the deterministic executor. The supervisor agent plans work and operates the CLI; it is not the scheduler. The CLI and dashboard are clients of the same service.

## Responsibilities

| Component | Owns |
| --- | --- |
| GitHub | Issue content, assignment, Project membership, dependencies, workstreams, PRs, CI, human feedback, and merge state. |
| `orchestrator/core/` | GitHub CLI adapter, configuration, dependency classification, Worktrunk provisioning, workstreams, and TaskNotes bridge. No Rust subprocess delegation. |
| `orchestrator/cli.ts` | User/supervisor commands, JSON output, service lifecycle, and legacy task-management commands. |
| `orchestrator/service.ts` | Independent service process, repository-scoped ownership, HTTP server, and runtime discovery. |
| `orchestrator/engine.ts` | Lifecycle gates, ready-task dispatch, concurrency, retry limits, review/fix loops, approval, and reconciliation. |
| `orchestrator/store.ts` | Private atomic execution checkpoints and bounded agent event reads. No local task database. |
| `orchestrator/rpc.ts` | One normal Pi CLI subprocess per active task role, stable session identity, JSONL protocol, event delivery, model configuration, dialogs, and process-group shutdown. |
| `extensions/orchestration.mjs` | Structured, immutable phase reports. Loaded explicitly only for service-owned agents. |
| `orchestrator/http.ts`, `dashboard/` | Dependency graph, lifecycle controls, transcript/tool inspection, nudges, and dialog responses. |
| `orchestrator/tailscale.ts` | Explicit temporary tailnet sharing, without Funnel or persistent configuration changes. |
| `agent-context/runtime/` | All worker/reviewer instructions, phase prompts, recovery instructions, and report-tool description. |
| `agent-context/github-orchestrator/SKILL.md` | Supervisor instructions for operating the CLI. |

The existing Rust sources and agent-status extension remain as legacy regression references during migration. They do not launch or manage the new agents. The TypeScript npm executable is the supported entry point for orchestration.

## Task lifecycle

```text
queued → planning → awaiting_approval → implementing → reviewing → ready_to_merge
                         │                   ↑             │
                         │                   └── findings ─┘
                         └─ automatic for unsupervised tasks
```

Both modes require a pushed skeleton and draft PR. Planner and implementer use one saved Pi session; their model selections can differ. A phase boundary can replace the RPC process without replacing its conversation. The reviewer uses a separate saved session. At most one role is active in a task's worktree.

`paused` and `blocked` preserve the phase to resume. `needs_input`, repeated agent failures, or exhausted review/CI correction budgets block execution. `done` and `closed` are terminal. Closing a task as not planned/duplicate does not make it successful or unblock dependent issues.

The service publishes a PR only after a reviewer approves its current revision and CI is passed or absent. Pending checks wait; failures return to implementation within the fix budget. A report is not proof that a check passed: the service checks the branch/base, pushed head, clean worktree, GitHub check status, and reviewer revision. The worker and reviewer also run issue-specific verification.

Only humans merge. There is no merge operation in the core service interface.

## Approval and feedback

Approval binds to the full skeleton commit SHA. The CLI and dashboard submit explicit approval requests. GitHub uses an exact `/gho approve FULL_SHA` command from the configured owner in a PR comment or submitted review. Agent comments beginning with `[agent:]` cannot provide approval or human feedback.

An updated skeleton invalidates the old gate. A nudge at the gate authorizes skeleton revision, not implementation. Revision-bound checks reject stale approval and review results. Feedback delivery identities are checkpointed to avoid repeated polling delivery.

These gates are workflow controls for trusted agents, not a sandbox against malicious code running as the same OS/GitHub user. Normal Pi tool permissions still apply.

## Persistence and recovery

GitHub remains the task store. The service writes runtime artifacts under the repository's Git common directory:

```text
<git-common-dir>/gho-service/
  service.guard                # permanent inode for OS-held flock; never unlink
  service.lock                 # readable ownership metadata, not the authority
  service.json                 # PID, loopback port, private token
  service.log
  executions/<issue>.json      # phase, mode, approval, session IDs, dispatch identity
  events/<issue>-<role>.jsonl   # agent output and operator interactions
```

Each worktree contains ignored `.gho/sessions/` and `.gho/reports/`. Checkpoints are atomic replacements; reports are atomically published without replacing an existing conflicting result. Dispatch identity is stored before launching Pi. Provisioning intent is stored before creating a worktree, permitting recovery of an interrupted owned creation. A service restart processes saved reports before retrying an interrupted turn.

Only one service may own the checkout's execution records and session writers. Ownership uses an OS-held `flock` on a permanent inode, not stale PID-file deletion. Each Pi child separately holds a worktree-wide lock under `.gho/writer/` before it can accept a phase prompt. A service crash cannot release an old worker's lock while that worker is still alive. A normal CLI command can exit while the service continues. A process manager is required for automatic service restart; the service itself does not install one.

Recovery is not arbitrary tool-call replay. An interrupted Pi session resumes with instructions to inspect the working copy, commits, PRs, and external effects before repeating actions. Exactly-once external side effects are not promised. Do not open a service-owned session concurrently in a separate TUI process.

## Normal Pi behavior

Workers launch the actual `pi --mode rpc` executable, with an explicit worktree, session directory, and stable session ID. Pi loads its normal settings, providers, credentials, extensions, skills, and context files. The service supplies only its additional report extension and role instructions. It does not construct a replacement Pi harness or use Pi Durable's separate extension API.

The RPC driver uses LF-only JSONL framing, correlated command IDs, continuously drained output, bounded frames/queues, and command deadlines. `agent_settled`, not `agent_end`, indicates that Pi will not continue automatically. Prompt acceptance is not phase completion. Standard extension dialogs are forwarded and never silently approved. Terminal-specific custom UI is not available in RPC mode.

## Dashboard safety

The HTTP server binds to loopback. API calls require a per-process token, exact Host/Origin checks, bounded JSON bodies, and deadlines. Only fixed bundled assets are served. The browser receives neither GitHub credentials nor arbitrary RPC/command execution access. Agent text is rendered as text, not HTML.

The task graph retains full Project membership, overlapping workstreams, archived/completed tasks, and external blocker details. Display filters never recalculate readiness. Transcript/lifecycle polling reads local execution state without triggering graph refreshes.

Tailscale sharing is explicit. It validates exact node names, refuses occupied Serve/Funnel ports, owns a temporary foreground mapping, and removes only that mapping at shutdown. Tailnet rules authorize access to the dashboard and its mutation controls.

## Verification

- Core tests use command fakes and temporary git repositories/vaults.
- Lifecycle tests cover gate enforcement, model/session continuity, review/CI loops, recovery, concurrency, and pause/resume.
- RPC tests use fake subprocesses for framing, failure, backpressure, dialogs, and cleanup. An installed-Pi smoke test verifies normal resource discovery without a model request.
- HTTP tests cover routing, token/Host/Origin validation, limits, shutdown, and Tailscale ownership.
- Playwright CLI tests exercise task selection, agent inspection, messages, explicit approval, dialogs, and failure recovery in the browser.
- The Rust suite and legacy dashboard tests remain available to catch migration regressions.
