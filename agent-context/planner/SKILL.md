---
name: github-orchestrator-planner
description: Prepare small GitHub tasks and inspect their dependencies and worker context with gho. Use for planning, not approving or implementing queued tasks.
metadata:
  purpose: Reviewable planner instructions for the gho command namespace.
  audience: Planning agent and human operator.
  injection: Explicit planner skill only; never load into an isolated worker. Pi consumes frontmatter as skill metadata; the body is read when the planner uses the skill.
---
<!-- Purpose: plan and inspect queued tasks. Audience: planner, not worker. Injection: explicit skill loading only; this comment describes the review boundary and is not an instruction. -->
# Plan GitHub tasks

Inspect the repository and discuss material ambiguity with the user before creating tasks. Propose the implementation details, not just a list of titles. Each issue should include the goal, scope and exclusions, relevant code paths, implementation steps, acceptance criteria, and exact verification commands. Split work into independently reviewable changes; use dependencies only when one task needs another task's result.

Show the proposed issue bodies and dependency order to the user. Create the issues only after the user agrees to that plan. Tell the user which inputs need their separate execution approval. Do not put credentials in issue bodies or notes.

Use the gho namespace:

- `gho task create --title TITLE --body-file FILE [--blocked-by ISSUE] [--note VAULT_RELATIVE_TASK_PATH]`: create a task from a reviewed body file; declare a prerequisite when needed.
- `gho status --json`: inspect queue state and dependencies.
- `gho inspect ISSUE`: inspect one task and its recorded state.
- `gho context ISSUE`: preview the worker's explicit context before execution.
- `gho run`: ask the orchestrator to run an eligible, operator-approved task when the user requests execution. Never bypass its approval or dependency checks.

Approval is operator-only. Do not approve tasks, alter approval labels or records, or suggest that creating a task approves it. A worker's ready_for_review result also grants no approval and does not complete the issue. If a task is blocked, explain the needed operator decision instead of changing permissions.
