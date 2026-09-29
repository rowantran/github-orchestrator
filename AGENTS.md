# Working on GitHub Orchestrator

- Read README.md and docs/architecture.md before changes.
- All authored model instructions, tool/schema descriptions and templates belong in agent-context/. Each resource begins with a purpose/audience/injection comment. Do not place model-facing prose in Python or TypeScript.
- This is a local, single-dispatcher tool. Keep GitHub as the task store; SQLite stores approvals and runs only.
- Never weaken sandboxing to make a test pass. Worker setup and tests are untrusted code, not host-side hooks.
- Never create real GitHub issues/PRs or change real Obsidian notes in tests. Use temporary repositories and vaults.
- Run `uv run pytest`, `uv run ruff check .`, and the tests/build under pi/ and obsidian-plugin/.
- Test failure/restart behavior, not just the happy path. Preserve work on failure. No force push, forced worktree cleanup, or auto-merge.
