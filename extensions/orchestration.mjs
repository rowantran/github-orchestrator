import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { fstatSync, statSync } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { acquireLock } from "../dist/orchestrator/store.js";

const kinds = ["skeleton_ready", "implementation_ready", "review_passed", "changes_requested", "needs_input"];
const descriptionPath = new URL("../agent-context/runtime/report-tool.md", import.meta.url);

/** Publish one complete immutable result; readers never observe a partial JSON document. */
export async function writeReport(reportPath, report) {
  const directory = dirname(reportPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(report)}\n`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally { await file.close(); }
    try {
      // link() is atomic and does not replace a result from another invocation.
      await link(temporary, reportPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await readFile(reportPath, "utf8") !== contents) throw new Error("Conflicting phase report already exists");
    }
    const folder = await open(directory, "r");
    try { await folder.sync(); } finally { await folder.close(); }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export default async function orchestration(pi) {
  const reportPath = process.env.GHO_REPORT_PATH;
  const phaseToken = process.env.GHO_PHASE_TOKEN;
  const role = process.env.GHO_AGENT_ROLE;
  // Loading the package in an ordinary Pi session must not add orchestration tools.
  if (!reportPath && !phaseToken) return;
  if (!reportPath || !isAbsolute(reportPath) || !phaseToken || phaseToken.length > 256) {
    throw new Error("Invalid orchestration report configuration");
  }
  const description = (await readFile(descriptionPath, "utf8")).replace(/^<!--[^]*?-->\s*/, "").trim();
  if (!description) throw new Error("Empty orchestration report description");
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
      if (!kinds.includes(params.kind) || typeof params.summary !== "string" || !params.summary.trim()
        || params.summary.length > 16384 || (params.findings !== undefined && (!Array.isArray(params.findings)
          || params.findings.length > 100 || params.findings.some((finding) => typeof finding !== "string"
            || !finding.trim() || finding.length > 4096)))) throw new Error("Invalid phase report");
      if ((role === "reviewer" && ["skeleton_ready", "implementation_ready"].includes(params.kind))
        || (role === "implementer" && ["review_passed", "changes_requested"].includes(params.kind))) {
        throw new Error("Report kind does not match agent role");
      }
      const report = { phaseToken, kind: params.kind, summary: params.summary };
      if (params.findings !== undefined) report.findings = [...params.findings];
      await writeReport(reportPath, report);
      return { content: [{ type: "text", text: JSON.stringify(report) }], details: report, terminate: true };
    },
  });
  let releaseWriter;
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
