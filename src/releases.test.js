import test from 'node:test';
import assert from 'node:assert/strict';
import { newestRelease, reported } from './releases.js';

const tags = (...names) => names.map((name) => ({ name }));

test('newest release stays in the running major line and avoids nightlies', () => {
  const core = tags('24.0.0-rc.1', '24-nightly', '23.1.8', '23.1.7', '23.1.8-nightly.2026.09.22', 'latest', '23');
  assert.equal(newestRelease(core, '23.1.7'), '23.1.8', 'Core 23.1.7 -> 23.1.8, not 24 rc');
  assert.equal(newestRelease(core, '23.1.8'), null, 'already newest');
  const drive = tags('4.2.0-beta.4', '4.2.0-beta.6', '4.2.0-beta.10', '4.1.3', '4.2.0-dev.12');
  assert.equal(newestRelease(drive, '4.2.0-beta.5'), '4.2.0-beta.10', 'prerelease lines compare numerically');
  assert.equal(newestRelease(tags('1.8.1', '1.8.2', '1.9.0-beta.1'), '1.8.1'), '1.8.2', 'stable networks stay stable');
});

test('running versions come from what nodes report', () => {
  const h = { core: { version: '/Dash Core:23.1.8(devnet.devnet-x)/' }, dapi: { driveVersion: '4.2.0-beta.5' }, platform: { version: '1.8.1' }, containers: [{ component: 'gateway', version: '@e969ae71c1ce' }] };
  assert.equal(reported(h, 'core'), '23.1.8');
  assert.equal(reported(h, 'drive'), '4.2.0-beta.5');
  assert.equal(reported(h, 'tenderdash'), '1.8.1');
  assert.equal(reported(h, 'gateway'), null, 'digest-only pins have no release');
});
