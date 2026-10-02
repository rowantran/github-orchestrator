import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Report, Role } from '../types.js';

/** Shared phase-report contract for the Pi RPC extension and Pi Durable workers. */
export const reportKinds = ['skeleton_ready', 'implementation_ready', 'review_passed', 'changes_requested', 'needs_input'] as const;
export type ReportKind = typeof reportKinds[number];
export interface ReportParams { kind: string; summary: string; findings?: string[] }

const descriptionPath = fileURLToPath(new URL('../../../agent-context/runtime/report-tool.md', import.meta.url));

/** The authored tool description, without its resource header comment. */
export async function reportDescription(): Promise<string> {
  const description = (await readFile(descriptionPath, 'utf8')).replace(/^<!--[^]*?-->\s*/, '').trim();
  if (!description) throw new Error('Empty orchestration report description');
  return description;
}

/** Validate a model-supplied report for one role and phase token. */
export function buildReport(params: ReportParams, role: Role, phaseToken: string): Report {
  if (!(reportKinds as readonly string[]).includes(params.kind) || typeof params.summary !== 'string' || !params.summary.trim()
    || params.summary.length > 16384 || (params.findings !== undefined && (!Array.isArray(params.findings)
      || params.findings.length > 100 || params.findings.some(finding => typeof finding !== 'string'
        || !finding.trim() || finding.length > 4096)))) throw new Error('Invalid phase report');
  if ((role === 'reviewer' && ['skeleton_ready', 'implementation_ready'].includes(params.kind))
    || (role === 'implementer' && ['review_passed', 'changes_requested'].includes(params.kind))) {
    throw new Error('Report kind does not match agent role');
  }
  const report: Report = { phaseToken, kind: params.kind as ReportKind, summary: params.summary };
  if (params.findings !== undefined) report.findings = [...params.findings];
  return report;
}

/** Publish one complete immutable result; readers never observe a partial JSON document. */
export async function writeReport(reportPath: string, report: Report): Promise<void> {
  const directory = dirname(reportPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(report)}\n`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    try {
      // link() is atomic and does not replace a result from another invocation.
      await link(temporary, reportPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await readFile(reportPath, 'utf8') !== contents) throw new Error('Conflicting phase report already exists');
    }
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
