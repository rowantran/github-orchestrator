# Working on GitHub Orchestrator

- Read README.md and docs/architecture.md before changes.
- Keep `gho` small: register work, list ready work, create worktrees. Launching and managing implementer agents belongs to the orchestrator agent and its skill, not to Rust code.
- All authored model instructions and templates belong in agent-context/. Each resource begins with a purpose/audience/injection comment. Do not place model-facing prose in Rust or TypeScript.
- GitHub is the task store. Do not add a local database.
- Never create real GitHub issues/PRs or change real Obsidian notes in tests. Use temporary repositories and vaults.
- Run `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, and the tests/build under obsidian-plugin/.
