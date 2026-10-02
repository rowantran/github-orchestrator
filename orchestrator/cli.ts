import { Command, InvalidArgumentError } from 'commander';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Core, initConfig, loadConfig, parseIssue, issueUrl, systemRunner, type Config } from './core/index.js';
import { diagnoseAgents } from './agents/index.js';
import { descriptor, ensureService, findService, runtimeDirectory, serve, serviceRequest, type ServiceDescriptor, type ServiceOptions } from './service.js';
import { stopService, waitForAgents } from './wait.js';
import type { Mode, Role, Run } from './types.js';
import { checkVersion } from './version.js';

const json = (value: unknown) => { console.log(JSON.stringify(value, null, 2)); };
function integer(text: string): number { const n = Number(text); if (!Number.isSafeInteger(n) || n < 0) throw new InvalidArgumentError('Expected a nonnegative integer.'); return n; }
function positive(text: string): number { const n = integer(text); if (!n) throw new InvalidArgumentError('Expected a positive integer.'); return n; }
function collect(value: string, prior: string[]): string[] { return [...prior, value]; }
function role(value: string): Role { if (value !== 'implementer' && value !== 'reviewer') throw new InvalidArgumentError('Use implementer or reviewer.'); return value; }
function mode(value: string): Mode { if (value !== 'supervised' && value !== 'unsupervised') throw new InvalidArgumentError('Use supervised or unsupervised.'); return value; }
function issue(config: Config, value: string): number { const ref = parseIssue(value, config.repo); if (ref.repo !== config.repo) throw new Error('Execution must be in the configured repository.'); return ref.number; }

export async function main(argv = process.argv): Promise<void> {
  const program = new Command().name('gho').description('GitHub tasks → deterministic Pi workflows → human-reviewed pull requests.').version('0.2.0');
  program.option('--config-dir <path>', 'Directory containing global and per-repository TOML config');
  const settings = () => program.opts<{ configDir?: string }>();
  const config = () => loadConfig(process.cwd(), settings().configDir);
  const core = async () => new Core(await config());
  const serverOptions = (opts: { port?: number; tailscaleServe?: boolean }): ServiceOptions => ({ ...opts, configDir: settings().configDir });
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const cfg = await config();
    return serviceRequest<T>(await ensureService(cfg, serverOptions({})), path, body);
  };
  program.command('init').description('Create missing global and repository config; never overwrite').action(async () => json(await initConfig(process.cwd(), settings().configDir)));
  program.command('config').description('Print resolved configuration').action(async () => json(await config()));
  program.command('doctor').description('Check GitHub, worktree, and Pi prerequisites').action(async () => {
    const api = await core();
    const result = await api.doctor();
    const version = await checkVersion(systemRunner);
    result[version.ok ? 'checks' : 'warnings'].push(version.message);
    const { agents } = api.config;
    const runtime = await diagnoseAgents(agents.runtime, api.config.checkout,
      { planner: agents.planner_model, implementer: agents.implementer_model, reviewer: agents.reviewer_model });
    result.checks.push(...runtime.checks); result.warnings.push(...runtime.warnings);
    try { await systemRunner.run({ argv: ['flock', '--version'], cwd: api.config.checkout }); result.checks.push('flock available for OS-held worker locks'); }
    catch { result.warnings.push('flock is required for service ownership (Linux: util-linux; macOS: brew install flock).'); }
    json(result);
  });
  program.command('ready').description('List eligible tasks and their dependency state').option('--all', 'Include blocked and active work').option('--json', 'Print JSON').action(async opts => {
    const entries = await (await core()).ready(Boolean(opts.all));
    if (opts.json) json(entries);
    else for (const entry of entries) console.log(`#${entry.number}\t${entry.state}\t${entry.title}`);
  });
  program.command('worktree <issue>').description('Provision a worktree and task brief').option('--base <ref>', 'Explicit base; overrides dependency readiness').action(async (value, opts) => {
    const api = await core(); json(await api.createWorktree(issue(api.config, value), opts.base));
  });
  const task = program.command('task').description('Register work in GitHub');
  task.command('create').requiredOption('--title <title>').requiredOption('--body-file <path>')
    .option('--blocked-by <issue>', 'Dependency; repeat or comma-separate', collect, [])
    .option('--workstream <name>', 'Existing workstream; repeat for overlapping groups', collect, [])
    .option('--note <path>', 'Vault-relative task note')
    .action(async opts => {
      const api = await core();
      const created = await api.createTask({ title: opts.title, body: await readFile(opts.bodyFile, 'utf8'), blockedBy: opts.blockedBy.flatMap((s: string) => s.split(',').map(v => v.trim())), workstreams: opts.workstream, note: opts.note });
      console.log(issueUrl(created.reference));
    });
  const workstream = program.command('workstream').description('Manage overlapping GitHub label groups');
  workstream.command('create <name>').action(async name => { await (await core()).createWorkstream(name); console.log(`Workstream available: ${name}`); });
  workstream.command('list').option('--json').action(async opts => { const names = await (await core()).listWorkstreams(); if (opts.json) json(names); else names.forEach(name => console.log(name)); });
  workstream.command('add <name> <issues...>').action(async (name, issues) => { await (await core()).addToWorkstream(name, issues); json({ updated: issues.length, workstream: name }); });
  workstream.command('remove <name> <issues...>').action(async (name, issues) => { await (await core()).removeFromWorkstream(name, issues); json({ updated: issues.length, workstream: name }); });
  const notes = program.command('notes').description('Optional TaskNotes bridge');
  notes.command('link <note> <issues...>').action(async (note, issues) => json(await (await core()).notesLink(note, issues)));
  notes.command('list').action(async () => json(await (await core()).notesList()));
  notes.command('complete').option('--retry').action(async opts => json(await (await core()).notesComplete(Boolean(opts.retry))));
  notes.command('install').option('--yes', 'Confirm plugin installation').action(async opts => json(await (await core()).notesInstall(Boolean(opts.yes))));

  program.command('run <issues...>').description('Enroll tasks; the service starts them when their dependencies are ready')
    .option('--mode <mode>', 'supervised or unsupervised', mode, 'supervised')
    .action(async (values: string[], opts) => {
      const cfg = await config(); const service = await ensureService(cfg, serverOptions({}));
      const runs = [];
      for (const value of values) runs.push(await serviceRequest(service, `/api/runs/${issue(cfg, value)}/start`, { mode: opts.mode }));
      json(runs);
    });
  program.command('status [issue]').description('Show persisted task execution state').action(async value => {
    const cfg = await config();
    const running = await findService(await runtimeDirectory(cfg.checkout), cfg.repo);
    if (!running) throw new Error('Service is not running. Start it with gho service start.');
    json(await serviceRequest(running, value ? `/api/runs/${issue(cfg, value)}` : '/api/runs'));
  });
  program.command('approve <issue>').description('Approve one exact committed skeleton revision; never merge')
    .requiredOption('--sha <sha>', 'Full skeleton commit SHA')
    .action(async (value, opts) => json(await request(`/api/runs/${issue(await config(), value)}/approve`, { sha: opts.sha, actor: 'cli' })));
  for (const action of ['pause', 'resume'] as const) program.command(`${action} <issue>`).description(`${action === 'pause' ? 'Stop' : 'Resume'} a task without replacing its Pi session`)
    .action(async value => json(await request(`/api/runs/${issue(await config(), value)}/${action}`, {})));
  const agent = program.command('agent').description('Inspect or nudge a service-owned Pi agent');
  agent.command('show <issue>').option('--role <role>', 'Agent role', role, 'implementer').action(async (value, opts) => json(await request(`/api/runs/${issue(await config(), value)}/agents/${opts.role}`)));
  agent.command('message <issue> [text]').option('--role <role>', 'Agent role', role, 'implementer').option('--file <path>', 'Read message from a file').action(async (value, text, opts) => {
    if (opts.file && text) throw new Error('Use text or --file, not both.');
    const message = opts.file ? await readFile(opts.file, 'utf8') : text;
    if (!message) throw new Error('Provide a message or --file.');
    json(await request(`/api/runs/${issue(await config(), value)}/agents/${opts.role}/messages`, { text: message }));
  });
  agent.command('respond <issue> <dialog>').option('--role <role>', 'Agent role', role, 'implementer')
    .option('--value <text>').option('--confirm', 'Answer yes').option('--deny', 'Answer no').option('--cancel')
    .action(async (value, dialog, opts) => {
      if ([opts.value !== undefined, opts.confirm, opts.deny, opts.cancel].filter(Boolean).length !== 1) throw new Error('Choose exactly one dialog answer.');
      const response = { id: dialog, ...(opts.value !== undefined ? { value: opts.value } : opts.cancel ? { cancelled: true } : { confirmed: Boolean(opts.confirm) }) };
      json(await request(`/api/runs/${issue(await config(), value)}/agents/${opts.role}/responses`, response));
    });
  const service = program.command('service').description('Run the independent orchestration service');
  const serverFlags = (command: Command) => command.option('--port <port>', 'Dashboard port (0 selects a local port)', integer, 0).option('--tailscale-serve', 'Expose through a temporary tailnet-only Tailscale Serve session');
  serverFlags(service.command('start')).action(async opts => { const running = await ensureService(await config(), serverOptions(opts)); console.log(running.url); });
  service.command('status').action(async () => {
    const cfg = await config(); const running = await findService(await runtimeDirectory(cfg.checkout), cfg.repo);
    json(running ? { running: true, pid: running.pid, url: running.url } : { running: false });
  });
  service.command('stop').action(async () => {
    const cfg = await config(), root = await runtimeDirectory(cfg.checkout), running = await descriptor(root);
    if (running && running.repo !== cfg.repo) throw new Error('Service belongs to a different repository.');
    await stopService(root, running);
    json({ stopped: true });
  });
  serverFlags(program.command('serve').description('Run the service in the foreground')).action(async opts => serve(await config(), serverOptions(opts)));
  serverFlags(program.command('dashboard').description('Start/reuse the service and print its dashboard URL')).action(async opts => { const running = await ensureService(await config(), serverOptions(opts)); console.log(running.url); });

  const wait = program.command('wait').description('Wait without using model context');
  wait.command('agents [targets...]').option('--all').option('--since <cursor>').option('--timeout <seconds>', '', integer).option('--interval <seconds>', '', positive, 2)
    .action(async (targets: string[], opts) => {
      let running: ServiceDescriptor | undefined;
      json(await waitForAgents(async () => {
        if (!running) {
          const cfg = await config();
          running = await findService(await runtimeDirectory(cfg.checkout), cfg.repo) ?? undefined;
          if (!running) throw new Error('Service is not running. Start it with gho service start.');
        }
        return serviceRequest<Run[]>(running, '/api/runs');
      }, { targets, since: opts.since, all: Boolean(opts.all), timeoutMs: opts.timeout === undefined ? undefined : opts.timeout * 1000, intervalMs: opts.interval * 1000 }));
    });
  wait.command('review').option('--pr <number>', '', positive).option('--since <cursor>').option('--timeout <seconds>', '', integer).option('--interval <seconds>', '', positive, 30)
    .action(async opts => {
      const api = await core();
      let pr = opts.pr as number | undefined;
      if (!pr) {
        const branch = (await systemRunner.run({ argv: ['git', 'branch', '--show-current'], cwd: api.config.checkout })).trim();
        pr = (await api.github.openPullRequest(branch))?.number;
      }
      if (!pr) throw new Error('No open pull request from this branch.');
      const started = Date.now();
      let cursor = opts.since as string | undefined;
      while (true) {
        const result = await api.checkReviews(pr, cursor);
        cursor = result.cursor;
        if (result.result !== 'waiting') { json(result); return; }
        if (opts.timeout !== undefined && Date.now() - started >= opts.timeout * 1000) { json({ ...result, result: 'timeout' }); return; }
        await sleep(opts.interval * 1000);
      }
    });
  await program.parseAsync(argv);
}
