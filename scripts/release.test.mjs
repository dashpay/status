import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseIdentity } from './package-release.mjs';

test('release identities reject shell syntax, moving refs and path escapes', () => {
  const revision = 'a'.repeat(40);
  for (const version of ['v1.2.3', 'v0.1.0-rc.1', 'v0.0.0-ci.12']) assert.equal(releaseIdentity(version, revision).version, version);
  for (const version of ['latest', 'v01.2.3', 'v1.2.3/../../x', 'v1.2.3\n', 'v1.2.3;true', '$(id)']) assert.throws(() => releaseIdentity(version, revision));
  for (const ref of ['master', 'a'.repeat(7), revision + '\n']) assert.throws(() => releaseIdentity('v1.2.3', ref));
});
