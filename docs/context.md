<!-- Purpose: define the worker's reviewed context and parent/extension contract. Audience: operators and maintainers. Injection: documentation only; never automatically load this page into a worker. -->
# Worker context

The parent creates one sandboxed Pi process per attempt. The worker edits and tests code, then writes `.gho/result.json`. It does not commit, push, modify GitHub, or change approval state. The parent and operator own delivery and approval.

## Reviewed resources

| File | Audience and use |
| --- | --- |
| `agent-context/worker-system.md` | Worker role, restrictions, and explicit repository guidance; rendered into `--system-prompt`. |
| `agent-context/worker-append.md` | Worker handoff instructions; supplied as an additional `--append-system-prompt`. |
| `agent-context/worker-task.md` | Immutable issue snapshot and result schema; rendered and supplied as `@task.md`. |
| `agent-context/tool-definitions.json` | All seven tool names, labels, descriptions, snippets, guidelines, and complete parameter schemas. |
| `agent-context/strings.json` | Extension flag description, authored failures, and audit explanations. |
| `agent-context/result.schema.json` | JSON Schema for `.gho/result.json`. |
| `agent-context/planner/SKILL.md` | Explicit planner-only skill. Never loaded into isolated workers. Approval remains operator-only. |
| `pi/worker.ts` | Tool execution adapters and pre-request auditing; no authored prompt prose. |

Each Markdown prompt starts with a purpose/audience/injection HTML comment. The parent must remove **only that leading comment and following whitespace before substitution**. JSON resources have a top-level `_purpose` field. The extension selects tool/string values without injecting the header. The parent removes `_purpose` from the result schema before inserting it into the task. The planner skill uses normal Pi frontmatter; it is a separate, explicitly loaded resource, not a worker prompt.

## Parent rendering contract

The parent owns rendering. Replace these eight placeholders once, literally, without HTML escaping and without recursively processing inserted values:

| Placeholder | Value | Template |
| --- | --- | --- |
| `{{issue_url}}` | `context.issue.url` | `worker-task.md` |
| `{{issue_title}}` | `context.issue.title` | `worker-task.md` |
| `{{issue_body}}` | Verbatim `context.issue.body` | `worker-task.md` |
| `{{base_commit}}` | `context.base_commit` | `worker-task.md` |
| `{{branch}}` | `context.branch` | `worker-task.md` |
| `{{run_id}}` | `context.run_id` | `worker-task.md` |
| `{{context_files}}` | Explicit repository instruction snapshots, as below | `worker-system.md` |
| `{{result_schema}}` | JSON serialization of `result.schema.json` without `_purpose` | `worker-task.md` |

`worker-append.md` has no placeholders. Fail on unknown placeholders in the source template; do not reject or reinterpret brace tokens in user data. For example, an issue containing `{{branch}}` must retain that literal text.

Render each context file as `### {path}\n\n{content}`, joining entries with `\n\n`. An empty list renders as an empty string. Preserve the path and complete content verbatim: do not strip metadata from repository guidance, truncate it, or silently replace safety instructions. The extension checks that every path and content appears in the effective system prompt. The parent must choose and snapshot the relevant repository guidance; this extension does not discover additional instructions.

Before launch, write UTF-8 JSON to `<worktree>/.gho/input/context.json`:

```json
{
  "schema": 1,
  "run_id": "run-unique-attempt-id",
  "issue": {
    "url": "https://github.com/owner/repository/issues/42",
    "title": "Implement one bounded change",
    "body": "The complete issue body"
  },
  "base_commit": "FULL_BASE_COMMIT_SHA",
  "branch": "gho/42",
  "context_files": [
    {"path": "AGENTS.md", "content": "The complete reviewed repository instructions"}
  ],
  "expected_bootstrap": "The exact nonempty mandatory bootstrap supplied by this Isara launcher"
}
```

All fields are required. `schema` is the integer `1`; the issue body and context-file contents may be empty strings. Other strings must be nonempty. Context-file paths must be unique. Paths identify the original guidance and need not be absolute. `expected_bootstrap` is a verification value, not a request to inject or replace the launcher prompt.

The context flag itself must be the absolute path `<cwd>/.gho/input/context.json`. The extension rejects symlinks at `.gho`, `.gho/input`, or `context.json`. The parent also snapshots the rendered prompts and task under `.gho/input/`, makes inputs immutable through the sandbox, and prevents concurrent workers in this worktree.

Copy `worker.ts`, `context.ts`, and `resources.ts` into `.gho/input/pi/`, and `agent-context/*.json` into `.gho/input/agent-context/`. Load the copied `pi/worker.ts`, not the live source checkout. `resources.ts` resolves the sibling resource directory from `import.meta.url`; Pi’s extension loader resolves the SDK imports without a copied package manifest or `node_modules`.

## Launch contract

Use Pi **0.87.1** and Node **22.19+**. The parent supplies:

```text
isara pi run --profile locked --
  --mode json
  --no-extensions --no-skills --no-prompt-templates --no-themes
  --no-context-files --no-approve --no-builtin-tools
  --extension <absolute-isara-provider-entry>
  --extension <absolute-worktree>/.gho/input/pi/worker.ts
  --provider isara --model <exact-model-id>
  --system-prompt <absolute-rendered-worker-system.md>
  --append-system-prompt <absolute-rendered-worker-append.md>
  --session-dir <absolute-session-directory>
  --session-id <unique-attempt-id>
  --gho-context <absolute-worktree>/.gho/input/context.json
  @<absolute-rendered-task.md>
```

This is an argument list, not a shell script. All resource files must exist before launch. The parent selects thinking level, time limits, and cancellation policy separately. `--no-builtin-tools` retains the seven registered extension tools; do not substitute `--no-tools`. `--no-extensions` still permits the two explicit extensions.

The parent uses a task-local `bin/pi` shim to set the isolated Pi home inside the sandbox: Isara scrubs inherited `PI_*` variables. Global settings, credentials, context, and resources must not load. Explicit system and append inputs also prevent `SYSTEM.md`/`APPEND_SYSTEM.md` discovery. The worker is loaded after Isara and must remain the last extension that observes or changes the prompt.

**Keep the mandatory bootstrap.** Isara adds its own `--append-system-prompt`. The worker neither overwrites nor removes it. The extension checks its exact text in both the effective prompt and append section. Disabling automatic AGENTS discovery does not prevent Isara's bootstrap from instructing the model to read repository guidance. Those subsequent reads are ordinary tool context, not automatic prompt injection. Do not hide this distinction in previews.

The parent owns the operating-system boundary: worker cwd writable, `.gho/input/` and `.gho/bin/` denied writes, shared Git metadata read-only, and no host home, keychain, or socket access. The extension does not grant permissions or try to enforce these controls with shell-command matching. If mandatory repository guidance conflicts with worker permissions, the worker must report a blocker.

## Pre-request audit

The `before_agent_start` handler:

1. Reads and validates the parent manifest and worktree paths.
2. Rejects automatically loaded context files, skills, arbitrary prompt sections, a forced replacement prompt, or a missing explicit system prompt.
3. Checks the mandatory bootstrap and all explicit repository guidance without changing either.
4. Checks that exactly `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` are active and selected, with the reviewed descriptions, full schemas, snippets, and guidelines.
5. Atomically writes `<worktree>/.gho/effective-context.json` with mode `0600`, outside the read-only input directory.

The audit has `schema: 1`, `run_id`, `cwd`, `context_path`, `issue`, `base_commit`, `branch`, `context_files`, `expected_bootstrap`, the full `system_prompt`, full expanded `task_prompt`, and `tools` entries containing `name`, `description`, `parameters`, `promptSnippet`, and `promptGuidelines`. It also records explicit `checks`, human-readable `assumptions`, and a non-injected `_purpose` header. Each successful invocation of the hook replaces the snapshot; normal workers have one submitted task per process. The snapshot is written before the agent begins, without a model call.

Failure prints an owned diagnostic to stderr and exits `1` synchronously. Merely throwing from this lifecycle handler is insufficient: Pi 0.87.1 reports handler errors and continues. No prompt is replaced as a failure mechanism.

**This is audit evidence, not an attestation.** Tools run in the same process and can overwrite the writable audit output. The parent copies it to host logs after the worker exits and checks the run identity and expected inputs. A missing or inconsistent audit is a failed run, even if another result file claims success. The snapshot covers this hook boundary, not later extension mutations, compaction, additional file reads, or every provider request. The persistent Pi session is the broader execution record. Logs and snapshots can contain issue text, source contents, and sensitive data; keep them private.

## Result contract

`.gho/result.json` has exactly four fields:

```json
{
  "status": "ready_for_review",
  "summary": "Changed the parser and added regression coverage.",
  "tests": ["npm test: passed 12 tests"],
  "blockers": []
}
```

`status` is `ready_for_review` or `blocked`. `summary` is nonempty. `tests` and `blockers` are arrays of nonempty strings. A blocked result needs at least one blocker; a review-ready result has no blockers. Report checks not run and why. A review-ready result is a request for human review, not issue completion or approval. The parent validates the schema, process outcome, audit, and repository diff independently.

JSON mode's exit code alone does not establish success. Inspect final assistant errors and wait for `agent_settled` and process exit. Preserve the event log separately from the session file.

## Accepted upstream boundary and tests

Tool implementations are Pi's `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, and `createLsTool`, constructed with worker cwd. Only their `execute` functions are reused; registration metadata and schemas come from `agent-context/tool-definitions.json`.

Runtime tool outputs/errors, command output, file content, native argument-validation errors, Pi framing, and provider request conversion remain upstream behavior. They are not promised to originate in the resource directory. Resource isolation is not a security sandbox, an output sanitizer, or protection against prompt injection.

From `pi/`, run `npm ci --ignore-scripts` and `npm test`. Unit tests typecheck the extension, compare schema shapes with pinned Pi, check resource metadata and all placeholders, execute local file tools in temporary directories, and invoke the complete audit hook with a fake extension API. Failure tests include a child process to prove that audit rejection exits before continuation.

`pi/test/runtime.test.ts` additionally launches the actual pinned Pi 0.87.1 CLI using the Pi portion of `Runner.argv`, an explicit local fake provider instead of Isara, and an emulated mandatory bootstrap append. It tests the copied layout without nearby `node_modules`, a private `HOME`/`PI_CODING_AGENT_DIR`, disabled discovery, and unwanted ambient-resource sentinels. Pi runs its real event lifecycle and local fake stream, but no external model, network service, authentication exchange, or real credentials are used. A preload guard fails the child on attempted network connections, in addition to Pi’s offline and telemetry settings. The fake provider checks that the audit already exists and exactly matches its effective prompt and selected tool schemas before returning a fixed stop message. The test checks exit status, JSON events, `agent_settled`, the audit, and session persistence. It deliberately does not launch Isara or test the operating-system sandbox; the parent verifies that boundary separately.

The opt-in `tests/test_sandbox.py` suite also composes the real `ContextBuilder` bundle, `Runner.argv`, task-local Pi shim, copied extension, and local fake provider inside the actual Isara-resolved SRT policy. It checks the audit before streaming, output events, sessions, caches, denied input writes, and unchanged input files. It does not invoke credential minting or an external model. Set `GHO_ISARA_CHECKOUT` as shown in the root README to run it on macOS.

`pi/test/prompt-surface.test.ts` scans runtime TypeScript recursively, excluding tests and dependencies. It rejects inline registration metadata, parameter schemas/descriptions, authored errors, and prose. Registration tests additionally prove that changing resource metadata changes the exposed tool contract. This is a conservative source-shape rule, not general information-flow analysis; review extensions to the loader or new message-injection paths explicitly.
