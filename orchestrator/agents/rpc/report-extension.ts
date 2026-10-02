import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { acquireLock, type OwnedLock } from "../../store.js";
import type { Role } from "../../types.js";
import { buildReport, reportDescription, reportKinds as kinds, writeReport } from "../report.js";

export { writeReport };

/**
 * Pi extension loaded explicitly into RPC workers (`pi --extension`). It adds `gho_report` and guards the
 * worktree writer lock. The service passes the phase identity through GHO_* environment variables.
 */
export default async function orchestration(pi: ExtensionAPI): Promise<void> {
  const reportPath = process.env.GHO_REPORT_PATH;
  const phaseToken = process.env.GHO_PHASE_TOKEN;
  const role = process.env.GHO_AGENT_ROLE as Role;
  // Loading the package in an ordinary Pi session must not add orchestration tools.
  if (!reportPath && !phaseToken) return;
  if (!reportPath || !isAbsolute(reportPath) || !phaseToken || phaseToken.length > 256 || (role !== "implementer" && role !== "reviewer")) {
    throw new Error("Invalid orchestration report configuration");
  }
  const description = await reportDescription();
  pi.registerTool({
    name: "gho_report",
    label: "gho_report",
    description,
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.Union(kinds.map((kind) => Type.Literal(kind))),
      summary: Type.String({ minLength: 1, maxLength: 16384 }),
      findings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 100 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error("Phase report cancelled");
      const report = buildReport(params, role, phaseToken);
      await writeReport(reportPath, report);
      return { content: [{ type: "text", text: JSON.stringify(report) }], details: report, terminate: true };
    },
  });
  let releaseWriter: OwnedLock | undefined;
  let inheritedWriter = false;
  pi.on("session_start", async (_event, ctx) => {
    // The driver locks before Pi opens a session, then passes the shared description as fd 3.
    // Its inherited copy keeps ownership even if the service dies during Pi startup.
    const root = join(ctx.cwd, ".gho", "writer");
    if (!releaseWriter && !inheritedWriter) {
      const inherited = process.env.GHO_LOCK_FD;
      if (inherited !== undefined) {
        if (inherited !== "3") throw new Error("Invalid inherited writer descriptor");
        const guardPath = process.env.GHO_LOCK_PATH;
        if (!guardPath || !isAbsolute(guardPath)) throw new Error("Invalid inherited writer guard path");
        const descriptor = fstatSync(3), guard = statSync(guardPath), worktreeGuard = statSync(join(root, "service.guard"));
        if (guard.dev !== worktreeGuard.dev || guard.ino !== worktreeGuard.ino) throw new Error("Writer guard belongs to another worktree");
        if (!descriptor.isFile() || descriptor.dev !== guard.dev || descriptor.ino !== guard.ino) {
          throw new Error("Inherited writer descriptor does not match worktree guard");
        }
        // Only process exit closes this copy: later shutdown hooks still own background work.
        // This also preserves ownership through all cleanup if the parent service was killed.
        inheritedWriter = true;
      } else {
        // Manual extension loading can guard prompting, but cannot protect earlier CLI writes.
        releaseWriter = await acquireLock(root);
      }
    }
    ctx.ui.setStatus("gho:report", JSON.stringify({ phaseToken, reportPath }));
  });
  pi.on("session_shutdown", async () => {
    const release = releaseWriter;
    releaseWriter = undefined;
    await release?.();
  });
}
