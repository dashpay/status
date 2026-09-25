// Explicit release payload: never include .env, networks/, reports or local state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function releaseIdentity(version, revision) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:rc|beta|alpha|ci)\.[0-9]+)?$/.test(version)) throw new Error('Use vMAJOR.MINOR.PATCH or -rc.N/-beta.N/-alpha.N');
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('An exact 40-character Git revision is required');
  return { version, revision };
}

export function packageRelease(version, revision, output = 'release-dist') {
  const identity = releaseIdentity(version, revision);
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build on native Linux AMD64/ARM64');
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Release bundles require Node 22');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== revision) throw new Error('Requested revision differs from checkout');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'server', 'src', 'package.json', 'package-lock.json', 'vite.config.js', 'index.html']);
  const epoch = execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[0-9]+$/.test(epoch)) throw new Error('Invalid commit timestamp');
  for (const required of ['dist/index.html', 'server/index.js', 'node_modules/express/package.json']) fs.accessSync(required);
  // Publishing requires production dependencies only, not the browser tooling.
  if (fs.existsSync('node_modules/vite')) throw new Error('Run npm prune --omit=dev before packaging');
  fs.mkdirSync(output); // Refuse reuse/overwrite of an existing output directory.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'status-release-'));
  try {
    const root = path.join(temporary, 'dash-status'); fs.mkdirSync(root);
    for (const name of ['dist', 'node_modules', 'package.json', 'package-lock.json']) fs.cpSync(name, path.join(root, name), { recursive: true, verbatimSymlinks: true });
    const files = execFileSync('git', ['ls-files', '-z', 'server'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of files) {
      if (!/^server\/[a-zA-Z0-9_./-]+\.js$/.test(name) || name.includes('.test.')) continue;
      if (!fs.lstatSync(name).isFile()) throw new Error('Server source must be a regular tracked file');
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.copyFileSync(name, path.join(root, name));
    }
    const manifest = { ...identity, platform: 'linux', architecture: process.arch === 'x64' ? 'amd64' : 'arm64', nodeMajor: 22, buildNode: process.versions.node, libc: 'glibc', builtFrom: new Date(Number(epoch) * 1000).toISOString(), service: 'dash-network-console' };
    const base = `dash-status-${version}-linux-${manifest.architecture}`;
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
    const archive = path.join(path.resolve(output), base + '.tar.gz');
    execFileSync('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', temporary, 'dash-status']);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`);
    fs.writeFileSync(path.join(output, base + '.json'), JSON.stringify({ ...manifest, archive: path.basename(archive), sha256 }, null, 2) + '\n');
    return archive;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, revision, output] = process.argv.slice(2);
  console.log(packageRelease(version, revision, output));
}
