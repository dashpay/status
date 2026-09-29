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
  assert.equal(newestRelease(tags('4.1.3', '4.2.0-beta.6'), null), null, 'unknown running release: never guess (could downgrade)');
});

test('running versions come from what nodes report', () => {
  const h = { core: { version: '/Dash Core:23.1.8(devnet.devnet-x)/' }, dapi: { driveVersion: '4.2.0-beta.5' }, platform: { version: '1.8.1' }, containers: [{ component: 'gateway', version: '@e969ae71c1ce' }] };
  assert.equal(reported(h, 'core'), '23.1.8');
  assert.equal(reported(h, 'drive'), '4.2.0-beta.5');
  assert.equal(reported(h, 'tenderdash'), '1.8.1');
  assert.equal(reported(h, 'gateway'), null, 'digest-only pins have no release');
});

test('dashmate follows Drive on console devnets', async () => {
  const { helperFor, imageTag, withImage } = await import('./releases.js');
  const helperTags = tags('4.2.0-beta.5', '4.2.0-beta.6');
  const n = { dashmate: true, images: { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' } };
  assert.deepEqual(helperFor(n, '4.2.0-beta.6', helperTags), { c: 'helper', from: '4.2.0-beta.5', to: '4.2.0-beta.6' });
  assert.equal(helperFor(n, '4.2.0-beta.5', helperTags), null, 'already in step');
  assert.equal(helperFor(n, '4.2.0-beta.7', helperTags), null, 'no helper published for that release');
  assert.equal(helperFor({ ...n, dashmate: false }, '4.2.0-beta.6', helperTags), null, 'older devnets never run the helper');
  assert.equal(imageTag('docker.io/dashpay/drive:4.2.0-beta.6'), '4.2.0-beta.6');
  assert.equal(imageTag('dashpay/drive@sha256:' + 'a'.repeat(64)), null);
  const images = { drive: 'dashpay/drive:4.2.0-beta.5', helper: 'dashpay/dashmate-helper:4.2.0-beta.5' };
  assert.equal(withImage(images, 'drive', 'dashpay/drive:4.2.0-beta.6').helper, 'dashpay/dashmate-helper:4.2.0-beta.6');
  const pinned = withImage({ ...images, helper: 'dashpay/dashmate-helper:4.2.0-beta.4' }, 'drive', 'dashpay/drive:4.2.0-beta.6');
  assert.equal(pinned.helper, 'dashpay/dashmate-helper:4.2.0-beta.4', 'a helper chosen apart from Drive stays');
});
