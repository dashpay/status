import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { releaseIdentity } from './package-release.mjs';
const { version, revision } = releaseIdentity(process.env.RELEASE_VERSION, process.env.RELEASE_REVISION);
let checksums = '';
for (const arch of ['amd64', 'arm64']) {
  const base = `dash-status-${version}-linux-${arch}`;
  const manifest = JSON.parse(fs.readFileSync(`release-dist/${base}.json`));
  assert.equal(manifest.revision, revision); assert.equal(manifest.version, version); assert.equal(manifest.architecture, arch); assert.equal(manifest.nodeMajor, 22);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(`release-dist/${base}.tar.gz`)).digest('hex');
  assert.equal(manifest.sha256, actual);
  checksums += `${actual}  ${base}.tar.gz\n`;
}
for (const arch of ['amd64', 'arm64']) {
  const base = `dash-status-${version}-docker-${arch}`;
  const manifest = JSON.parse(fs.readFileSync(`release-dist/${base}.json`));
  assert.equal(manifest.kind, 'DockerImage'); assert.equal(manifest.revision, revision); assert.equal(manifest.version, version);
  assert.equal(manifest.architecture, arch); assert.equal(manifest.nodeMajor, 22);
  assert.match(manifest.configDigest, /^sha256:[a-f0-9]{64}$/);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(`release-dist/${base}.tar.gz`)) hash.update(chunk);
  assert.equal(manifest.sha256, hash.digest('hex'));
  checksums += `${manifest.sha256}  ${base}.tar.gz\n`;
}
fs.writeFileSync('release-dist/SHA256SUMS', checksums);
fs.writeFileSync('release-dist/NOTES.md', `## Staged release\n\nSource: \`${revision}\`\n\n- Native Linux AMD64 and ARM64 bundles, including built frontend and production dependencies.\n- Requires Node.js 22 and Ubuntu 24.04-compatible glibc. Runtime/configuration/credentials are not bundled.\n- Both unpacked artifacts passed HTTP health/frontend smoke checks; application and browser tests passed.\n- Verify SHA256SUMS before installation. See deploy/RELEASING.md at the source revision.\n\n**Draft only.** Publishing this release does not deploy the website. No staging environment exists. Production promotion requires a separately reviewed host rollout and rollback plan.\n`);
fs.appendFileSync('release-dist/NOTES.md', '\n## Docker images\n\nNative AMD64/ARM64 Docker image archives include Node 22. No host Node upgrade or registry credential is needed. Verify SHA256SUMS and load the matching `*-docker-ARCH.tar.gz` with `docker load`. Use scripts/image-archive.py from the source revision to verify the loaded content against the release configDigest; pin its returned local image ID. Engine image-ID formats differ, but exact configuration bytes and layer identities must match. Both legacy collector and multi-network console were smoke-tested after save/load as non-root/read-only containers. Private configuration is mounted at runtime. See deploy/DOCKER.md for cutover and rollback. These are Docker-save archives, not registry-published tags.\n');
