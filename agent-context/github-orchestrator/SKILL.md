---
name: github-orchestrator
description: Use when the user wants to handle nontrivial work (more than one PR required) by using the github-orchestrator (gho) tool. The tool facilitates breaking up a plan into a tree of GitHub issues, then dispatching implementer agents to handle those issues.
metadata:
  purpose: Instructions for the orchestrator agent that uses the gho CLI.
  audience: The interactive orchestrator agent the user talks to.
  injection: Installed as a Pi package (pi install git:github.com/rowantran/github-orchestrator); Pi advertises it and loads it on demand. Not for implementer agents.
---
<!-- Purpose: teach the orchestrator agent the gho workflow. Audience: orchestrator agent. Injection: Pi package skill, loaded when the task matches or via /skill:github-orchestrator. -->
# Orchestrate nontrivial work with github-orchestrator (gho)

`gho` performs three fixed jobs: register work, list ready work, and create worktrees.
You decide the rest with the user: which tasks to create, how to launch and steer implementers, and when to publish.

## Commands

Run `gho` inside the repository's checkout or one of its worktrees: it works on the GitHub repository of the checkout's `origin`. If it reports a missing config, ask the user to run `gho init` there and fill in the file it names.

- `gho task create --title TITLE --body-file FILE [--blocked-by N]... [--note VAULT_PATH]`: create an issue assigned to the user, add it to the configured project, and record native "blocked by" dependency information. Use this when breaking up the plan into a series of issues.
- `gho ready --json`: Use this when determining which issue (if any) to start next. Add `--all` to also see `blocked`, `in_progress` (branch exists, no PR) and `ready_for_review` (open PR, in `pull_request`) issues.
- `gho worktree N [--base REF]`: Use this once ready to start implementing issue N. It uses Worktrunk (`wt`) to create a branch `<owner>/gh-N` in a new worktree for a ready issue.
- `gho config`: prints the user's `gho` config as JSON. `agents.implementer_model` and `agents.reviewer_model` are the Pi models to launch agents with.

## Step 1: Plan

Start by discussing the goal with the user.
Begin by proposing a high-level plan that outlines which components we need to create or modify.
Then start breaking the high-level plan down into GitHub issues.

Each issue should have a brief, precise title. It should have a body with: goal, scope, acceptance criteria, and verification commands. Add blockers to indicate the order that tasks need to be implemented in.

## Step 2: Implement

In this step, we launch implementer & reviewer agents to actually handle the tasks created above.

Once the plan is complete:

1. Run `gho ready --json` and agree with the user which issues to start and how many at once, unless they already said.
2. Run `gho worktree N` for each one.
   - Generally, only start issues that are ready, with or without pending dependencies that they need to be stacked on.
   - In certain situations, we may want to start a non-ready issue anyway (for example if it depends on two disjoint issues that are both in review separately, so the CLI detects it as not ready, but  we want to merge those two dependencies into a new base branch so we can start anyways). In that case, ask the user first, then use `gho worktree N --base <branch>`.
3. Run `gho config` to get the configured implementer / reviewer models. If a model is not set, just omit the `--model` option when launching the agents.
4. Write the task brief to a file outside the worktree. It should contain the issue URL, the branch and the base branch.
5. Launch one implementer per worktree in a new tmux window titled "#N: <short-slug-version-of-issue-title>", with the worktree as its working directory. Run Pi interactively (no `-p`), so the user can discuss with the implementer in that window:

   ```sh
   tmux new-window -n "#N: <slug>" -c <worktree> \
     'isara sandbox pi -- --model <implementer_model> --append-system-prompt "$(cat <skill dir>/implementer.md)" "$(cat <brief file>)"'
   ```

   Use absolute paths. Do not pass the path of `implementer.md` directly: if Pi cannot read the file, it silently uses the path itself as the prompt text.
6. Watch progress for all active implementers. Answer other questions, steer (`tmux send-keys -t <window> '<message>' Enter`), stop, or relaunch as needed. Bubble up to the user for information when facing ambiguity that you can't safely resolve on your own. If the implementer is looking for input on the pseudocode skeleton before implementing the real code, always bubble up to the user. Do NOT approve the skeleton yourself.
7. When an implementer has opened its draft PR (the issue shows as `ready_for_review`), launch a reviewer in the same worktree the same way, but with `--model <reviewer_model>`, `reviewer.md`, and "Review " prepended to the window title.
