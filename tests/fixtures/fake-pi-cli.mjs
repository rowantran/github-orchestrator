// Start the installed normal CLI with isolated test-only configuration and no credentials.
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  GHO_REPORT_PATH: process.env.GHO_REPORT_PATH,
  GHO_PHASE_TOKEN: process.env.GHO_PHASE_TOKEN,
  GHO_AGENT_ROLE: process.env.GHO_AGENT_ROLE,
  GHO_LOCK_FD: process.env.GHO_LOCK_FD,
  GHO_LOCK_PATH: process.env.GHO_LOCK_PATH,
};
const stdio = ["pipe", "pipe", "pipe"];
// This fixture wraps the normal CLI only to isolate credentials; preserve the driver's fd.
if (env.GHO_LOCK_FD === "3") stdio.push(3);
const child = spawn("pi", process.argv.slice(2), { env, stdio });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));
