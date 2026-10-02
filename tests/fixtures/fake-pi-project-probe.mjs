import { fstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export default function projectProbe(pi) {
  pi.registerCommand("gho-project-probe", {
    handler: async (_args, ctx) => {
      const guard = statSync(process.env.GHO_LOCK_PATH);
      const inherited = fstatSync(3);
      const script = "try { const s=require('node:fs').fstatSync(3); console.log(JSON.stringify({dev:s.dev,ino:s.ino})); } catch { console.log('null'); }";
      const helper = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
      if (helper.status !== 0) throw new Error("Fixture helper failed");
      const helperDescriptor = JSON.parse(helper.stdout);
      ctx.ui.notify(JSON.stringify({
        projectExtension: true, pid: process.pid,
        inheritedGuard: inherited.dev === guard.dev && inherited.ino === guard.ino,
        helperInheritedGuard: helperDescriptor?.dev === guard.dev && helperDescriptor?.ino === guard.ino,
      }), "info");
    },
  });
}
