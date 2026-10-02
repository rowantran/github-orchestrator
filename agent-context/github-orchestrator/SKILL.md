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

`gho` registers work, lists ready work, and creates worktrees.
You decide the rest with the user: which tasks to create, how to launch and steer implementers, and when to publish.

## Commands

Run `gho` inside the repository's checkout or one of its worktrees: it works on the GitHub repository of the checkout's `origin`. If it reports a missing config, ask the user to run `gho init` there and fill in the file it names.

- `gho task create --title TITLE --body-file FILE [--blocked-by N]... [--workstream NAME]... [--note VAULT_PATH]`: create an issue assigned to the user, add it to the configured project, and record native "blocked by" dependency information. Use this when breaking up the plan into a series of issues.
- `gho ready --json`: Use this when determining which issue (if any) to start next. Add `--all` to also see `blocked`, `in_progress` (branch exists or draft PR open) and `ready_for_review` (published PR, in `pull_request`) issues.
- `gho worktree N [--base REF]`: Use this once ready to start implementing issue N. It uses Worktrunk (`wt`) to create a branch `<owner>/gh-N` in a new worktree for a ready issue, and writes the task brief for the issue's agents to `.gho/brief.md` in the worktree (Git ignores it). It prints JSON with the worktree `path`, the `brief` path, and the `base_branch` that the pull request will target.
- `gho config`: prints the user's `gho` config as JSON. `agents.implementer_model` and `agents.reviewer_model` are the Pi models to launch agents with.
- `gho workstream create NAME`: create a named group of tasks, stored as a `gho:workstream:NAME` GitHub label.
- `gho workstream list --json`: list the repository's workstreams, including empty ones.
- `gho workstream add NAME N...` / `gho workstream remove NAME N...`: add or remove memberships for existing issues without changing their other labels.
- `gho dashboard [--port PORT] [--tmux-session NAME] [--tailscale-serve]`: serve the task graph on `127.0.0.1` and print its URL. By default, add `--tailscale-serve` to make the dashboard accessible over the Tailnet.
- `gho wait agents [N | N/AGENT]... [--all] [--since CURSOR] [--timeout SECONDS]`: block until an agent you launched settles, then print JSON. Without arguments it watches every agent in every issue worktree. See "Wait for agents" below.

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
4. Launch one implementer per worktree in a new tmux window titled "#N: <short-slug-version-of-issue-title>", with the worktree as its working directory. Give it the brief that `gho worktree` wrote as its first message, unchanged. Run Pi interactively (no `-p`), so the user can discuss with the implementer in that window:

   ```sh
   pane=$(tmux new-window -P -F '#{pane_id}' -n "#N: <slug>" -c <worktree> \
     'isara sandbox pi -- --gho-agent=implementer --model <implementer_model> --append-system-prompt "$(cat <skill dir>/implementer.md)" "$(cat <brief>)"') &&
   tmux set-option -p -t "$pane" @gho_repo '<owner/repo>' &&
   tmux set-option -p -t "$pane" @gho_issue 'N'
   ```

   `--gho-agent=implementer` makes the agent record its activity in `<worktree>/.gho/agents/implementer.json`, which `gho wait agents` reads. Keep it on every launch.

   Use absolute paths. Do not pass the path of `implementer.md` or the brief directly: if Pi cannot read the file, it silently uses the path itself as the prompt text.

   Replace `<owner/repo>` with `repo` from `gho config` and `N` with the numeric issue number. Set both pane options on every launch, including reviewers and relaunches. The dashboard uses these tags together to associate existing panes with tasks.

5. Watch progress for all active implementers with `gho wait agents` (see "Wait for agents" below). Answer other questions, steer (`tmux send-keys -t <window> '<message>' Enter`), stop, or relaunch as needed. Bubble up to the user for information when facing ambiguity that you can't safely resolve on your own. The user reviews the pseudocode skeleton in comments on the implementer's draft PR. When an implementer opens that PR, give the user its URL. Do NOT approve the skeleton yourself, and do not comment on the PR: the implementer uses the same GitHub account as the user, and treats every comment without the `[agent:]` prefix as a comment from the user.
6. When an implementer publishes its PR (`gho ready --all` shows the issue as `ready_for_review`), launch a reviewer in the same worktree the same way, but with `--gho-agent=reviewer`, `--model <reviewer_model>`, `reviewer.md`, and "Review " prepended to the window title.

## Wait for agents

`gho wait agents [--since <cursor>]` exits when an agent you launched settles: it finishes its run and waits for a message, waits for an answer to a dialog in its terminal, quits, or crashes. Run it as a background shell command that wakes you when it exits (in Pi: `background_start` with `kind: "shell"`). It returns JSON.

The JSON includes a `cursor`. Pass it as `--since <cursor>` every time you wait again; otherwise agents that are still settled end the wait again.

By default it watches every agent in every issue worktree. To watch only some, pass `N` (the agents in issue N's worktree) or `N/AGENT` (one agent, such as `42/reviewer`).
