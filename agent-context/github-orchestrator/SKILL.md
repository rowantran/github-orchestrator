---
name: github-orchestrator
description: Plan and operate GitHub task workflows through gho, including supervised skeleton approval, autonomous execution, agent review, and the dashboard.
metadata:
  purpose: Teach the supervisor agent how to operate the orchestration service.
  audience: The interactive Pi agent the user talks to.
  injection: Installed Pi skill; loaded when planning or operating task work.
---
<!-- Purpose: teach the supervisor the service-based workflow. Audience: interactive supervisor agent. Injection: installed Pi skill. -->
# Supervise GitHub work with gho

You help the user plan work and operate the service through its CLI. The service owns scheduling, worktrees, Pi processes, retries, phase transitions, and reviewer feedback. Do not launch implementer/reviewer processes, send tmux input, write execution checkpoints, or build your own polling loops.

## Plan and register
Discuss the goal and split it into bounded issues. Each issue needs a goal, scope, acceptance criteria, and verification commands. Record dependencies with native blocked-by links:
```sh
gho task create --title "One bounded change" --body-file task.md --blocked-by 41
gho ready --all --json
gho workstream create feature-a
gho workstream add feature-a 41 42
```
Run commands inside the target repository. If configuration is missing, run `gho init` and ask the user to fill in the Project URL. Use `gho config` and `gho doctor` to inspect settings and prerequisites.

## Enroll work
Choose the workflow with the user. Both workflows commit a skeleton first:
```sh
gho run 42 --mode supervised
gho run 43 44 --mode unsupervised
gho dashboard --tailscale-serve
```
Supervised tasks stop after the draft PR skeleton until explicitly approved. Unsupervised tasks pass that gate automatically. Both run implementation and independent agent review; only the service publishes the checked PR. Neither workflow merges it.
The planner and implementer share one persistent Pi session. Their configured models may differ. The reviewer uses a separate session. Enrolled blocked tasks remain queued until their dependencies are ready.

## Observe and intervene
```sh
gho status
gho status 42
gho agent show 42 --role implementer
gho agent message 42 --role implementer --file feedback.md
gho pause 42
gho resume 42
gho wait agents --since '<cursor>'
```
The dashboard shows agent messages, tool activity, and extension dialogs. A message is not approval. Messages to paused/blocked tasks are retained, but do not resume them. Use `resume` explicitly after resolving the blocker. The service is independent of your session; you can stop responding without stopping the tasks.

## Approval and merging
Give the user the draft PR URL and full skeleton SHA. They can approve in the dashboard or write `/gho approve FULL_SHA` in a GitHub PR comment or submitted review.
If the user explicitly asks you to approve a specific skeleton, inspect the current execution/revision and run:
```sh
gho approve 42 --sha FULL_SHA
```
Do not infer approval from general encouragement, feedback, or a request to start work. An outdated SHA is rejected. Never change supervised work to unsupervised just to bypass its gate.
Show ready-to-merge PRs to the user. Merge only if the user separately asks you to; gho never merges.

## Service lifecycle
```sh
gho service start
gho service status
gho service stop
gho serve
```
`serve` runs in the foreground; `service start` runs independently in the background. A restart reuses the saved execution and Pi sessions. A failed or interrupted command can have completed external effects: inspect status before retrying mutations.
