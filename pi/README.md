<!-- Purpose: maintain and test the isolated worker extension. Audience: maintainers. Injection: documentation only. -->
# Worker extension

`worker.ts` registers seven standard Pi tools with metadata from `../agent-context/`. It verifies the explicit parent context before an agent run and writes `.gho/effective-context.json`. It does not change the system prompt or create a model request.

The parent must pass `--gho-context <absolute-worktree>/.gho/input/context.json` and disable resource discovery and built-in tools. Keep the explicit Isara provider first and this extension last. See [`../docs/context.md`](../docs/context.md) for the complete rendering, sandbox, manifest, audit, and result contracts.

```sh
cd pi
npm ci --ignore-scripts
npm test
```

Development dependencies pin Pi 0.87.1. Unit tests use temporary files, local tools, a fake extension API, and a subprocess failure check. `test/runtime.test.ts` also launches the actual pinned Pi CLI with the parent’s Pi arguments and an explicitly loaded, entirely local fake provider. It loads copied extension/resource files from `.gho/input/` without nearby `node_modules`, uses a private home/config directory, disables automatic network activity, and fails on attempted network connections. The fake stream checks the audit against Pi’s provider-facing prompt and tool schemas before returning a fixed assistant message. No external model, credentials, or API is used; OS sandbox behavior is tested separately by the parent.

Run just the runtime integration with `node --test test/runtime.test.ts`. Pi supplies SDK imports through its extension loader. Do not ship development `node_modules/` in the Python wheel.
