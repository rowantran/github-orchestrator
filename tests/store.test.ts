import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, atomicJson } from '../orchestrator/store.js';

const exec = promisify(execFile);
const storeUrl = new URL('../orchestrator/store.js', import.meta.url).href;
const supported = process.platform === 'linux' || process.platform === 'darwin';
interface Reply { id: number; ok: boolean; error?: string; }
interface Worker {
  child: ChildProcess;
  request(action: 'acquire' | 'release'): Promise<Reply>;
  stop(): Promise<void>;
}

// The fixture owns no agents, models, credentials, repository, or external API calls.
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'gho-store-'));
  const workers: Worker[] = [];
  const releases: Array<() => Promise<void>> = [];
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.stop()));
    await Promise.all(releases.map(release => release()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async lock(path = root) {
      const release = await acquireLock(path);
      releases.push(release);
      return release;
    },
    async worker(): Promise<Worker> {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', `
        const { acquireLock } = await import(${JSON.stringify(storeUrl)});
        let release;
        process.on('disconnect', () => process.exit(0));
        process.on('message', async ({ id, action }) => {
          try {
            if (action === 'acquire') release = await acquireLock(process.argv[1]);
            else if (action === 'release') await release?.();
            process.send({ id, ok: true });
          } catch (error) { process.send({ id, ok: false, error: error.message }); }
        });
        process.send({ ready: true });
      `, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (text: string) => { stderr += text; });
      const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
      let sequence = 0;
      const worker: Worker = {
        child,
        async stop() {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await closed;
        },
        request(action) {
          const id = ++sequence;
          return new Promise<Reply>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
            const message = (value: unknown) => {
              const reply = value as Reply;
              if (reply.id === id) { cleanup(); resolve(reply); }
            };
            const exit = () => { cleanup(); reject(new Error(`Lock worker exited: ${stderr}`)); };
            const timer = setTimeout(() => { cleanup(); reject(new Error(`Lock worker timed out: ${stderr}`)); }, 15_000);
            child.on('message', message).once('exit', exit);
            child.send({ id, action }, error => { if (error) { cleanup(); reject(error); } });
          });
        },
      };
      workers.push(worker);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', exit); };
        const message = (value: unknown) => { if ((value as { ready?: boolean }).ready) { cleanup(); resolve(); } };
        const error = (cause: Error) => { cleanup(); reject(cause); };
        const exit = () => error(new Error(`Lock worker failed to start: ${stderr}`));
        const timer = setTimeout(() => error(new Error(`Lock worker startup timed out: ${stderr}`)), 15_000);
        child.on('message', message).once('error', error).once('exit', exit);
      });
      return worker;
    },
  };
}

function winner(replies: Reply[]): number {
  const winners = replies.flatMap((reply, index) => reply.ok ? [index] : []);
  assert.equal(winners.length, 1, JSON.stringify(replies));
  for (const reply of replies) if (!reply.ok) assert.match(reply.error!, /already running/);
  return winners[0]!;
}

test('same-process simultaneous acquisition has exactly one owner and release is idempotent', { skip: !supported }, async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => f.lock()));
  const owners = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(owners.length, 1);
  for (const result of attempts) if (result.status === 'rejected') assert.match(String(result.reason), /already running/);
  const before = await stat(join(f.root, 'service.guard'));
  assert.equal(before.mode & 0o777, 0o600);
  const owner = JSON.parse(await readFile(join(f.root, 'service.lock'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.nonce, 'string');
  const release = owners[0]!.value;
  await Promise.all([release(), release()]);
  await assert.rejects(readFile(join(f.root, 'service.lock')), { code: 'ENOENT' });
  const next = await f.lock();
  await release(); // An old release must not remove a new owner's descriptor or unlock it.
  await assert.rejects(acquireLock(f.root), /already running/);
  assert.equal((await stat(join(f.root, 'service.guard'))).ino, before.ino);
  await next();
});

test('independent processes cannot acquire together before or after release', { skip: !supported }, async t => {
  const f = await fixture(t);
  const workers = await Promise.all(Array.from({ length: 6 }, () => f.worker()));
  const first = winner(await Promise.all(workers.map(worker => worker.request('acquire'))));
  assert.equal(JSON.parse(await readFile(join(f.root, 'service.lock'), 'utf8')).pid, workers[first]!.child.pid);
  await assert.rejects(acquireLock(f.root), /already running/);
  assert.equal((await workers[first]!.request('release')).ok, true);
  const second = winner(await Promise.all(workers.map(worker => worker.request('acquire'))));
  assert.equal((await workers[second]!.request('release')).ok, true);
});

test('SIGKILL leaves stale metadata but concurrent restart has only one new owner', { skip: !supported }, async t => {
  const f = await fixture(t);
  const owner = await f.worker();
  assert.equal((await owner.request('acquire')).ok, true);
  const inode = (await stat(join(f.root, 'service.guard'))).ino;
  const saved = await readFile(join(f.root, 'service.lock'), 'utf8');
  const contenders = await Promise.all(Array.from({ length: 6 }, () => f.worker()));
  for (const reply of await Promise.all(contenders.map(worker => worker.request('acquire')))) {
    assert.equal(reply.ok, false);
    assert.match(reply.error!, /already running/);
  }
  await owner.stop();
  assert.equal(await readFile(join(f.root, 'service.lock'), 'utf8'), saved);
  const next = winner(await Promise.all(contenders.map(worker => worker.request('acquire'))));
  assert.equal((await stat(join(f.root, 'service.guard'))).ino, inode);
  assert.equal(JSON.parse(await readFile(join(f.root, 'service.lock'), 'utf8')).pid, contenders[next]!.child.pid);
  await contenders[next]!.stop();
  const release = await f.lock();
  await release();
});

test('missing or corrupt owner metadata cannot steal a held kernel lock', { skip: !supported }, async t => {
  const f = await fixture(t);
  await f.lock();
  await writeFile(join(f.root, 'service.lock'), '{incomplete');
  await assert.rejects(acquireLock(f.root), /already running/);
  await rm(join(f.root, 'service.lock'));
  await assert.rejects(acquireLock(f.root), /already running/);
});

test('restart ignores stale, corrupt, and reused-PID metadata when no kernel lock is held', { skip: !supported }, async t => {
  const f = await fixture(t);
  for (const contents of ['', '{partial', JSON.stringify({ pid: process.pid, nonce: 'former-owner' }), JSON.stringify({ pid: 2147483647 })]) {
    await writeFile(join(f.root, 'service.lock'), contents);
    const release = await f.lock();
    const owner = JSON.parse(await readFile(join(f.root, 'service.lock'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.nonce, 'former-owner');
    await release();
  }
});

test('symlink aliases to a runtime directory share the same kernel lock', { skip: !supported }, async t => {
  const f = await fixture(t);
  const actual = join(f.root, 'actual');
  const alias = join(f.root, 'alias');
  await mkdir(actual);
  await symlink(actual, alias);
  await f.lock(actual);
  await assert.rejects(acquireLock(alias), /already running/);
});

test('failed owner metadata publication closes the locked descriptor and removes temporary files', { skip: !supported }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'service.lock'));
  await assert.rejects(acquireLock(f.root));
  assert.deepEqual((await readdir(f.root)).sort(), ['service.guard', 'service.lock']);
  await rm(join(f.root, 'service.lock'), { recursive: true });
  await f.lock();
});

test('missing flock fails closed without publishing ownership or leaking the descriptor', { skip: !supported }, async t => {
  const f = await fixture(t);
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    const { acquireLock } = await import(${JSON.stringify(storeUrl)});
    try {
      await acquireLock(process.argv[1]);
      throw new Error('Unexpected ownership without flock');
    } catch (error) {
      console.log(JSON.stringify({ message: error.message, code: error.cause?.code }));
    }
  `, f.root], { env: { ...process.env, PATH: f.root }, timeout: 15_000 });
  const result = JSON.parse(stdout);
  assert.match(result.message, /Install flock on PATH/);
  assert.equal(result.code, 'ENOENT');
  await assert.rejects(readFile(join(f.root, 'service.lock')), { code: 'ENOENT' });
  await f.lock();
});

test('atomicJson replaces complete private JSON and cleans up after serialization failure', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'checkpoint.json');
  await atomicJson(path, { phase: 'planning' });
  await atomicJson(path, { phase: 'awaiting_approval' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { phase: 'awaiting_approval' });
  if (supported) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(atomicJson(path, circular), /circular/i);
  assert.deepEqual(await readdir(f.root), ['checkpoint.json']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { phase: 'awaiting_approval' });
});

test('atomicJson syncs contents then rename then parent directory and propagates directory sync failure', { skip: !supported }, async t => {
  const f = await fixture(t);
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const root = process.argv[1], events = [];
    const open = fs.open, rename = fs.rename;
    let fail = false;
    fs.open = async (...args) => {
      const file = await open(...args), sync = file.sync.bind(file);
      file.sync = async () => {
        const directory = args[0] === root;
        events.push(directory ? 'directory-sync' : 'file-sync');
        if (directory && fail) throw new Error('injected directory sync failure');
        return sync();
      };
      return file;
    };
    fs.rename = async (...args) => { events.push('rename'); return rename(...args); };
    syncBuiltinESMExports();
    const { atomicJson } = await import(${JSON.stringify(storeUrl)});
    await atomicJson(join(root, 'checkpoint.json'), { version: 1 });
    fail = true;
    let error;
    try { await atomicJson(join(root, 'checkpoint.json'), { version: 2 }); }
    catch (cause) { error = cause.message; }
    console.log(JSON.stringify({ events, error, files: await fs.readdir(root) }));
  `, f.root], { timeout: 15_000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.events, ['file-sync', 'rename', 'directory-sync', 'file-sync', 'rename', 'directory-sync']);
  assert.equal(result.error, 'injected directory sync failure');
  assert.deepEqual(result.files, ['checkpoint.json']);
});
