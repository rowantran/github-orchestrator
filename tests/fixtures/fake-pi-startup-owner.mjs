// Each invocation is an independent service harness; it never sends a model prompt.
import { readFile } from "node:fs/promises";
import { PiAgent } from "../../dist/orchestrator/rpc.js";

const options = JSON.parse(await readFile(process.argv[2], "utf8"));
const agent = new PiAgent(options);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await agent.close();
  process.exit(0);
};
process.once("SIGTERM", () => { void stop(); });
try {
  await agent.start();
  process.stdout.write(`${JSON.stringify({ ready: true, pid: agent.pid, state: await agent.getState() })}\n`);
  process.stdin.once("end", () => { void stop(); });
  process.stdin.resume();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ready: false, error: error.message, stderr: agent.stderr })}\n`);
  await agent.close();
  process.exitCode = 1;
}
