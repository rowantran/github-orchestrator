import { spawn } from 'node:child_process';

export interface Command { argv: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export interface Runner { run(command: Command): Promise<string> }
export class CommandError extends Error {
  constructor(readonly program: string, readonly code: number | null, readonly stderr: string) {
    super(`${program} failed${code === null ? '' : ` (${code})`}: ${stderr.trim()}`);
  }
}
/** All subprocesses have a deadline, bounded output, closed stdin, and no shell evaluation. */
export class SystemRunner implements Runner {
  async run(command: Command): Promise<string> {
    const [program, ...args] = command.argv;
    if (!program) throw new Error('Empty command.');
    const timeout = command.timeoutMs ?? 60_000;
    if (!(timeout > 0)) throw new Error('Command deadline exceeded; no success assumed.');
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        cwd: command.cwd, env: { ...process.env, ...command.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
      });
      let stdout = '', stderr = '', size = 0, settled = false;
      const stop = () => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { stop(); reject(error); } else resolve(stdout);
      };
      const timer = setTimeout(() => finish(new Error(`${program} timed out after ${timeout}ms; no success assumed.`)), timeout);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const consume = (chunk: string, err: boolean) => {
        size += Buffer.byteLength(chunk);
        if (size > 64 * 1024 * 1024) { finish(new Error(`${program} exceeded output limit; no success assumed.`)); return; }
        if (err) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      child.stdout.on('data', chunk => consume(chunk, false)); child.stderr.on('data', chunk => consume(chunk, true));
      child.once('error', error => finish(new Error(`Cannot run ${program}: ${error.message}`)));
      child.once('close', code => finish(code === 0 ? undefined : new CommandError(program, code, stderr)));
    });
  }
}
/** One total subprocess budget, used for a complete dashboard refresh. */
export class DeadlineRunner implements Runner {
  private readonly deadline: number;
  constructor(private readonly runner: Runner, timeoutMs: number) { this.deadline = Date.now() + timeoutMs; }
  run(command: Command): Promise<string> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Operation deadline exceeded; no success assumed.'));
    return this.runner.run({ ...command, timeoutMs: Math.min(command.timeoutMs ?? 60_000, remaining) });
  }
}
export const systemRunner = new SystemRunner();
