# GitHub Orchestrator

A personal GitHub issue queue for the Isara monorepo. One local dispatcher selects tasks assigned to `rowantran` in a configured GitHub Project, creates Worktrunk worktrees, and runs Pi through `isara pi run`.

**GitHub owns tasks and dependencies. You approve execution and publication.** Workers edit and test code in a macOS sandbox. They leave changes uncommitted. `gho publish` is a separate operator action that commits, pushes, and opens a **draft** pull request (PR). Nothing auto-merges.

The repository and owner are configurable; Isara and `rowantran` are the intended starting setup. This is not a hosted service or a distributed queue.

## Install and configure

You need:

- Python 3.12+ and `uv`.
- Git and authenticated GitHub CLI (`gh`), with repository access and permission to use the chosen GitHub Project.
- Node 22.19+, Pi **0.87.1**, Worktrunk (`wt`), and the sandbox runtime (`srt`) on `PATH`.
- A working Isara checkout with its CLI on `PATH`, its `.venv/bin/python`, and its Pi provider extension. Use your existing Isara authentication setup; do not put credentials in queue config or issue text.
- **macOS for worker launch.** There is no unsandboxed fallback. Linux worker support needs a tested sandbox adapter.

From this repository, install an editable local checkout:

```sh
uv sync --dev
source .venv/bin/activate
gho --help
```

`uv sync` installs this package in editable mode. Keep this checkout available: it contains the worker resources and optional plugin. Without activating the environment, use `uv run gho` from this directory instead of `gho`.

If needed, sign in with `gh auth login`. Then check access and grant GitHub Projects scope:

```sh
gh auth status
gh auth refresh -s project
```

Create or choose a GitHub Project yourself. For status mirroring, its single-select field must be named exactly `Status`, with these exact options: **Approved**, **Running**, **Review**, **Needs input**, **Done**. Missing options do not grant or revoke permission; mirroring is best effort. `gho init` does not create a Project or edit its fields.

Replace the example paths, Project number, and model ID below. `--repo` is optional; the default comes from the Isara checkout's GitHub `origin`.

```sh
gho init \
  --checkout /absolute/path/to/isara \
  --owner rowantran \
  --project https://github.com/users/rowantran/projects/123 \
  --model EXACT_ISARA_MODEL_ID \
  --isara-checkout /absolute/path/to/isara \
  --context-file AGENTS.md

gho doctor
gho doctor --sandbox
```

Choose the guidance files relevant to your work. Repeat `--context-file` for each **tracked** file; these are read from the fetched base, not from local edits. Add `--provider-extension /absolute/path/to/isara_provider.ts` if your provider is not at Isara's default `src/project/pi_provider/isara_provider.ts`.

Configuration defaults to `~/.config/github-orchestrator/config.toml`. Override it with `GHO_CONFIG` or `gho --config /path/to/config.toml COMMAND`. Initialization refuses to overwrite an existing config. State and workspaces live in separate, dedicated directories under your home, outside the normal checkout. See [configuration and diagnostics](docs/operations.md#configuration-and-diagnostics).

`doctor` checks prerequisites and GitHub access without a model call. `doctor --sandbox` also fetches the base and creates a temporary Worktrunk worktree to probe the real OS sandbox. A successful probe does not verify model access or end-to-end delivery.

## Plan with Pi

The planner is an explicit skill, not another scheduler. Start your usual interactive Pi session with this skill added (use an absolute path from outside this checkout):

```sh
pi --skill ./agent-context/planner/SKILL.md
```

Ask it to inspect the repository, propose small issues with implementation steps and checks, and discuss the dependency order with you. After you agree, it can use `gho task create` to create the issues. It must not approve execution. The worker skill/context stays separate; your normal interactive planner session is **not** the isolated worker environment.

## Daily workflow

1. **Plan in GitHub.** Use real issues, assign them to `rowantran`, and add them to the configured Project. Record prerequisites with GitHub's native **blocked by** relationships, not just prose or checkboxes. To create an issue deliberately from a reviewed body file:

   ```sh
   gho task create --title "One bounded change" --body-file /path/to/task.md
   # Add --blocked-by 41 for a prerequisite; repeat for more.
   ```

   This command writes to GitHub. Creating a task does not approve it.

2. **Inspect and approve exact inputs.** Substitute your issue number and the fingerprint printed by `context`:

   ```sh
   gho status
   gho inspect 42
   gho context 42
   # Read the generated bundle before approving.
   gho approve 42 --fingerprint FINGERPRINT_FROM_CONTEXT
   ```

   Review the issue, explicit repository guidance, worker prompts, tool definitions, and mandatory Isara bootstrap. Plan or reviewed-context changes invalidate the approval, including changes to fingerprinted provider files. See [fingerprint coverage](docs/architecture.md#launch-policy-and-approvals) for its limits. A Project status is never approval.

3. **Run approved work.** These commands select one issue; omit `--issue` to consider the current queue:

   ```sh
   gho run --issue 42 --dry-run
   gho run --issue 42
   gho runs
   gho logs RUN_ID
   ```

   `run` waits for its attempts and exits with status 1 if any result is failed, blocked, or interrupted. It does not publish or continuously watch GitHub. Dependencies must be satisfied before launch. A code prerequisite needs verified merged code; only genuinely non-code work can use operator `gho ack`. See [approval and dependencies](docs/operations.md#approval-and-dependencies).

4. **Review, then publish.** Find the worktree in `gho runs --json`. Inspect the full diff, untracked files, test results, and retained logs. A worker's `ready_for_review` result is not proof of correctness.

   ```sh
   gho publish RUN_ID
   ```

   The confirmation authorizes host-side commit, push, and draft PR creation. Review and merge the PR yourself through your normal GitHub process.

5. **Observe merge and clean up deliberately.**

   ```sh
   gho sync
   gho clean RUN_ID
   ```

   Cleanup accepts only runs recorded as merged. It does not force worktree removal or delete the branch; sessions and captured logs are retained. Failures and interrupted work are kept for review, not automatically retried.

## Optional TaskNotes bridge

The queue works without Obsidian. To link tasks, pass `--vault /absolute/path/to/vault` at initialization, or add `[obsidian]` with `vault = "/absolute/path/to/vault"` to the config. Then:

```sh
(cd obsidian-plugin && npm ci && npm test && npm run build)
gho notes install
# Enable GitHub Orchestrator Bridge in Obsidian Community plugins yourself.
gho notes link "Tasks/example.md" 42 43
gho notes list
```

`notes link` replaces the note's complete issue set. `task create --note "Tasks/example.md"` adds the new issue to an existing association instead. Notes must have `type: task`.

`gho sync --complete-notes` can request completion only after **every linked issue** satisfies the same completed-plus-merged-code or explicit non-code acknowledgment rule as dependencies. It skips pending/accepted requests. A failed or stale request needs receipt review and explicit `--retry-note-completion`. The plugin uses the TaskNotes runtime API, not direct YAML status edits. Its receipt confirms local acceptance only. Any existing Notion Task Sync integration remains responsible for Notion; this bridge neither calls Notion nor confirms its persistence. See the [plugin contract](obsidian-plugin/README.md) and [operations guide](docs/operations.md#optional-tasknotes-operations).

## Development and further reading

```sh
uv run pytest
uv run ruff check .
(cd pi && npm ci --ignore-scripts && npm test)
(cd obsidian-plugin && npm ci && npm test && npm run build)
```

On a configured macOS development machine, opt into the real Worktrunk and Isara/Seatbelt checks:

```sh
GHO_ISARA_CHECKOUT=/absolute/path/to/isara uv run pytest tests/test_workspace.py tests/test_sandbox.py -q
```

These checks include an actual Pi session inside the resolved sandbox, using a local fake provider. They test copied extension loading, prompt/tool audits, caches, sessions, and denied host writes without minting credentials or calling an external model.

The tests use temporary repositories/vaults and test doubles. They are not evidence that a paid model call, real GitHub write, or live Obsidian/Notion completion has succeeded. Qualify your own setup deliberately; never weaken the sandbox to pass a check.

- [Architecture](docs/architecture.md): ownership, state, worker boundary, and extension points.
- [Operations](docs/operations.md): configuration, commands, review, and safe recovery.
- [Worker context contract](docs/context.md): rendered inputs, tools, audit, and result schema.
- [Worker extension](pi/README.md) and [TaskNotes bridge](obsidian-plugin/README.md): component details.

All authored model instructions, tool descriptions, schemas, and prompt templates live in `agent-context/`. Runtime tool output, Pi framing, and provider behavior remain upstream; keeping authored resources separate does not make all model context trusted or fully owned.
