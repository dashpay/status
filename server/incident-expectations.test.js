import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycle } from './incident-service.js';
import { deriveIssues, loadIncidentState } from './incidents.js';
import { DEFAULT_SETTINGS, devnetEntry } from '../shared/settings.js';
import { evaluateNetwork } from '../shared/evaluate.js';
import { expectations } from '../shared/monitoring.js';

const now = Date.parse('2026-10-06T15:40:00Z');
const stamp = (ms) => new Date(ms).toISOString();
const opId = '11111111-1111-1111-1111-111111111111';
const n = devnetEntry('devnet-sakura', { status: 'ready', images: { drive: 'dashpay/drive@sha256:manifest' } });
const settings = { ...structuredClone(DEFAULT_SETTINGS), networks: [n] };
const reset = {
  id: opId, network: n.name, createdAt: stamp(now - 120_000), confirmedAt: stamp(now - 90_000),
  finishedAt: stamp(now - 60_000), updatedAt: stamp(now - 60_000), status: 'succeeded', progress: {},
  request: { action: 'platform-reset' }, review: { native: true, targetImages: {
    'validators-001': { drive: 'dashpay/drive@sha256:child', helper: 'dashpay/dashmate-helper@sha256:helper' },
  } },
};
const observation = (ms, image = 'dashpay/drive@sha256:child') => ({
  generatedAt: stamp(ms), discovery: { at: stamp(ms), error: null }, endpoints: [], hosts: [{
    name: 'validators-001', instanceId: 'i-fixture', state: 'running', role: 'service', arch: 'arm64',
    probe: { at: stamp(ms), ok: true, data: { containers: [{ name: 'drive', repo: 'dashpay/drive', image, running: true, state: 'running' }] } },
  }],
});
const hostIssues = (result) => result.issues.filter((i) => i.code === 'host_health');
const derive = (operations, state = observation(now), time = now) => deriveIssues({ settings, states: { [n.name]: state }, operations, now: time });

test('producer reads completed native reset intent and resolves only on a newer healthy sample', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incident-expectations-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const dir of ['state', 'ops']) mkdirSync(join(dataDir, dir));
  const write = (path, data) => writeFileSync(join(dataDir, path), JSON.stringify(data));
  write('settings.json', settings);
  write(`state/${n.name}.json`, observation(now));
  const run = async (time) => {
    await cycle({ dataDir, now: time, ci: { summary: () => ({}) }, fetcher: () => { throw new Error('unexpected network call'); } });
    return hostIssues(loadIncidentState(dataDir));
  };
  let issues = await run(now);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'open');
  assert.deepEqual(issues[0].evidence.faults, ['["images",""]']);
  write(`ops/${opId}.json`, reset);
  assert.equal((await run(now))[0].status, 'open');
  write(`state/${n.name}.json`, observation(now + 30_000));
  assert.equal((await run(now + 30_000))[0].status, 'open');
  const settled = now + 21 * 60_000;
  write(`state/${n.name}.json`, observation(settled));
  issues = await run(settled);
  assert.equal(issues[0].status, 'resolved');
  assert.equal(issues[0].revision, 2);
  const web = evaluateNetwork(n, observation(now + 30_000), settings, now + 30_000, {}, expectations([reset], now + 30_000));
  assert.equal(web.rows[0].convergence[0].status, 'matched');
  assert.equal(hostIssues(derive([reset])).length, 0, 'transient helper is not a missing service');
});

test('incident image intent preserves true drift, later upgrades and exact network isolation', () => {
  assert.equal(hostIssues(derive([reset])).length, 0);
  assert.equal(hostIssues(derive([reset], observation(now, 'dashpay/drive@sha256:wrong'))).length, 1);
  assert.equal(hostIssues(derive([{ ...reset, network: 'devnet-other' }])).length, 1);
  assert.equal(hostIssues(derive([{ ...reset, confirmedAt: undefined, status: 'review' }])).length, 1);
  const later = { ...reset, createdAt: stamp(now - 30_000), request: { action: 'upgrade' }, review: {
    changes: [{ node: 'validators-001', component: 'drive', to: 'dashpay/drive@sha256:next' }],
  } };
  assert.equal(hostIssues(derive([later, reset])).length, 1, 'old child must drift after later upgrade');
  assert.equal(hostIssues(derive([later, reset], observation(now, 'dashpay/drive@sha256:next'))).length, 0);
});

test('matched reset pins do not clear stale or missing observations', () => {
  const stale = observation(now);
  stale.hosts[0].probe.at = stamp(now - 240_000);
  const d = derive([reset], stale);
  const checks = Object.values(d.checks).filter((c) => c.kind === 'host');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].clear, false);
  assert.deepEqual(checks[0].healthyRules, []);
  stale.generatedAt = stamp(now - 240_000);
  const missing = derive([reset], stale);
  assert.ok(missing.issues.some((i) => i.code === 'collector_stale'));
  assert.equal(Object.values(missing.checks).filter((c) => c.kind === 'host').length, 0);
});

test('unapplied terminal plans do not override the reset; unapproved images still alert', () => {
  const changes = [{ node: 'validators-001', component: 'drive', to: 'dashpay/drive@sha256:next' }];
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const upgrade = { ...reset, createdAt: stamp(now - 15_000), status, request: { action: 'upgrade' },
      progress: { phase: 'platform', completed: [] }, review: { changes }, artifacts: { phases: [{ changes }] } };
    const operations = [upgrade, reset];
    assert.equal(hostIssues(derive(operations)).length, 0);
    assert.equal(hostIssues(derive(operations, observation(now, changes[0].to))).length, 1);
    assert.equal(hostIssues(derive([{ ...upgrade, status: 'succeeded' }, reset])).length, 1);
  }
});

test('producer ignores malformed operation files and mismatched durable record identities', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incident-intent-invalid-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const dir of ['state', 'ops']) mkdirSync(join(dataDir, dir));
  const write = (path, data) => writeFileSync(join(dataDir, path), JSON.stringify(data));
  write('settings.json', settings);
  write(`state/${n.name}.json`, observation(now));
  write('ops/not-an-operation.json', reset);
  write(`ops/${opId}.json`, { ...reset, id: '22222222-2222-2222-2222-222222222222' });
  writeFileSync(join(dataDir, 'ops/33333333-3333-3333-3333-333333333333.json'), '{');
  await cycle({ dataDir, now, ci: { summary: () => ({}) } });
  assert.equal(hostIssues(loadIncidentState(dataDir))[0].status, 'open');
});
