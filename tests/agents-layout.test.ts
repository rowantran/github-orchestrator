import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../orchestrator/', import.meta.url));
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []))).flat();
}
const imports = (text: string) => [...text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(match => match[1]!);

test('worker runtimes are separate folders behind the shared agents interface', async () => {
  for (const file of await files(source)) {
    const path = relative(source, file).split(sep).join('/');
    const specifiers = imports(await readFile(file, 'utf8'));
    if (path.startsWith('agents/durable/')) {
      assert.ok(!specifiers.some(spec => spec.includes('/rpc/') || spec.startsWith('../rpc')), `${path} must not import the RPC runtime`);
    } else if (path.startsWith('agents/rpc/')) {
      assert.ok(!specifiers.some(spec => spec.includes('/durable/') || spec.startsWith('../durable') || spec.includes('pi-durable')), `${path} must not import the durable runtime`);
    } else if (path.startsWith('agents/')) {
      // Shared modules may load runtimes only lazily, through their index.
      for (const spec of specifiers) if (spec.includes('/durable/') || spec.includes('/rpc/')) assert.match(spec, /^\.\/(durable|rpc)\/index\.js$/, `${path}: ${spec}`);
    } else {
      for (const spec of specifiers) {
        assert.ok(!spec.includes('agents/durable') && !spec.includes('agents/rpc') && !spec.startsWith('@earendil-works/pi-durable'),
          `${path} must use agents/index.js or agents/types.js, not ${spec}`);
      }
    }
  }
});
