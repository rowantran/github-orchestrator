// A controlled stand-in for an extension that owns a detached background shell.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default function backgroundProbe(pi) {
  let child;
  let exited;
  let root;
  pi.registerCommand("gho-background-shell-probe", {
    handler: async (_args, ctx) => {
      if (child) throw new Error("Fixture background process already exists");
      root = ctx.cwd;
      const script = `require('node:fs').writeFileSync(${JSON.stringify(join(ctx.cwd, "background.pid"))},String(process.pid));setInterval(()=>{},1000)`;
      child = spawn(process.execPath, ["-e", script], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
      exited = new Promise((resolve) => child.once("exit", resolve));
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      ctx.ui.notify(JSON.stringify({ backgroundShell: true, pid: child.pid }), "info");
    },
  });
  // The installed background extension uses this same lifecycle event and group signal.
  pi.on("session_shutdown", async () => {
    if (!child?.pid) return;
    if (existsSync(join(root, "shutdown.hold"))) {
      writeFileSync(join(root, "shutdown.started"), String(process.pid));
      while (!existsSync(join(root, "shutdown.release"))) await delay(10);
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await exited;
  });
}
