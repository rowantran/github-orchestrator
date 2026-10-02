// Stand-in for the service process. Its abrupt death closes the Pi RPC stdin pipe.
import { readFile, writeFile } from "node:fs/promises";
import { PiAgent } from "../../dist/orchestrator/rpc.js";

const [optionsPath, resultPath] = process.argv.slice(2);
const options = JSON.parse(await readFile(optionsPath, "utf8"));
const agent = new PiAgent(options);
const notifications = [];
agent.subscribe((event) => {
  if (event.type === "extension_ui_request" && event.method === "notify") {
    try { notifications.push(JSON.parse(event.message)); } catch { /* Non-fixture notifications. */ }
  }
});
try {
  await agent.start();
  const { commands } = await agent.request("get_commands");
  for (const name of ["gho-project-probe", "gho-background-shell-probe"])
    if (!commands.some((command) => command.name === name)) throw new Error(`Missing fixture command: ${name}`);
  await agent.prompt("/gho-project-probe");
  await agent.prompt("/gho-background-shell-probe");
  await writeFile(resultPath, JSON.stringify({ pid: agent.pid, state: await agent.getState(), notifications }));
  setInterval(() => {}, 1000);
} catch (error) {
  process.stderr.write(`${error.message}\n${agent.stderr}\n`);
  await agent.close();
  process.exitCode = 1;
}
