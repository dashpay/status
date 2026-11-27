// A test that no workflow runs passes for ever. Seven files in this repository
// were in that state at once; this fails when one is added and not wired in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist', 'artifacts']);
function* files(dir = '') {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const path = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) yield* files(path); else yield path;
  }
}
const workflows = readdirSync(join(root, '.github/workflows')).map((f) => readFileSync(join(root, '.github/workflows', f), 'utf8')).join('\n');
// `python3 -m unittest discover -s <directory> -p '<pattern>'`: the directory
// itself, not the ones below it (none of them is a package).
const discovered = [...workflows.matchAll(/unittest discover(?: -v)? -s (\S+) -p '([^']+)'/g)].map(([, dir, pattern]) => ({ dir,
  pattern: new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) }));

test('every Python test file is run by a workflow', () => {
  const tests = [...files()].filter((p) => /(^|\/)test_[^/]+\.py$/.test(p));
  assert.ok(tests.length >= 8, 'the test files were found');
  const unrun = tests.filter((p) => { const at = p.lastIndexOf('/'); return !discovered.some((d) => d.dir === p.slice(0, at) && d.pattern.test(p.slice(at + 1))); });
  assert.deepEqual(unrun, [], 'add a `python3 -m unittest discover -s <directory> -p <file>` step to .github/workflows/check.yml');
});

test('every browser script is run by a workflow', () => {
  const scripts = [...files('scripts')].filter((p) => /^scripts\/browser-[^/]+\.mjs$/.test(p));
  assert.ok(scripts.length >= 5, 'the scripts were found');
  assert.deepEqual(scripts.filter((p) => !workflows.includes(`node ${p}`)), [], 'add a `node scripts/<file>` step to .github/workflows/check.yml');
});
