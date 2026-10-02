# Working on GitHub Orchestrator

- Read README.md and docs/architecture.md before changes.
- The TypeScript orchestration service owns deterministic scheduling, Pi RPC processes, and phase transitions. The supervisor agent operates it through the CLI; it does not launch workers itself. Rust remains a legacy regression reference during migration.
- All authored model instructions and templates belong in agent-context/. Each resource begins with a purpose/audience/injection comment. Do not place model-facing prose in Rust or TypeScript.
- GitHub is the task store. Do not add a local database. Persist execution checkpoints and agent event journals as private runtime files under the Git common directory; persist Pi sessions under each worktree's ignored `.gho/` directory.
- Never create real GitHub issues/PRs or change real Obsidian notes in tests. Use temporary repositories and vaults.
- Run `npm test`, `npm run test:browser` (Playwright CLI), the dashboard and Obsidian plugin tests/build, and the legacy checks: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`. Tests must not call paid models or create real GitHub work.
