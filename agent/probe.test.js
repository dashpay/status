import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('read-only service probes preserve routing, local credentials and devnet address decoding', () => {
  const run = spawnSync('python3', [new URL('./test_probe.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
