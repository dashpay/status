// Separate observer process: never invoked by a browser request, and never runs
// enrollment or mutation commands. Configuration and reports remain private.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON } from './networks.js';

function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o640 }); chmodSync(temp, 0o640); renameSync(temp, path);
}
export function execute(binary, args, logPath, timeoutMs) {
  return new Promise((accept, reject) => {
    const log = createWriteStream(logPath, { flags: 'w', mode: 0o600 }); let bytes = 0;
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      if (bytes < 1024 * 1024) log.write(data.subarray(0, 1024 * 1024 - bytes)); bytes += data.length;
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); log.end(); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); log.end(); accept(code ?? 1); });
  });
}
export async function collect(config, network, runner = execute) {
  const status = { attemptedAt: new Date().toISOString(), failed: true };
  const temp = network.snapshot + '.' + randomUUID() + '.tmp';
  const healthTemp = network.health + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(network.snapshot), { recursive: true, mode: 0o750 });
  mkdirSync(dirname(network.health), { recursive: true, mode: 0o750 });
  const args = ['--ssh-key', network.sshKey, '--known-hosts', network.knownHosts];
  if (config.profile) args.push('--profile', config.profile);
  try {
    const code = await runner(config.binary, ['managed-import', '--manifest', network.manifest, ...args, '--timeout', '5m', '--out', temp], network.snapshot + '.log', 330_000);
    const snapshot = readJSON(temp);
    if (snapshot.kind !== 'ExistingSnapshot' || snapshot.fleet?.metadata?.name !== network.name || !snapshot.fleet.targets?.length) throw new Error('Observation scope invalid');
    // A partial import is useful evidence: publish it with every unresolved node.
    chmodSync(temp, 0o640); renameSync(temp, network.snapshot);
    status.failed = false; status.importComplete = code === 0;
    if (code === 0) {
      await runner(config.binary, ['managed-doctor', '--snapshot', network.snapshot, ...args, '--observation-window', network.observationWindow || '4m', '--timeout', '12m', '--out', healthTemp], network.health + '.log', 750_000);
      const health = readJSON(healthTemp);
      if (health.snapshot?.fleet?.metadata?.name !== network.name || typeof health.healthy !== 'boolean') throw new Error('Health scope invalid');
      chmodSync(healthTemp, 0o640); renameSync(healthTemp, network.health); status.healthVerified = health.healthy;
    }
  } catch {
    status.failed = true; status.notice = 'Latest observation could not be completed';
  } finally {
    for (const path of [temp, healthTemp]) rmSync(path, { force: true });
    status.completedAt = new Date().toISOString();
    atomic(network.collection, status);
  }
  return status;
}
export async function main(path) {
  const config = readJSON(path), base = dirname(resolve(path));
  if (!config.binary || !Array.isArray(config.networks) || !config.networks.length) throw new Error('Collector configuration required');
  config.binary = resolve(base, config.binary);
  for (const network of config.networks) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(network.name)) throw new Error('Invalid network name');
    for (const key of ['snapshot', 'health', 'collection', 'manifest', 'sshKey', 'knownHosts']) {
      if (!network[key]) throw new Error('Collector path missing');
      network[key] = resolve(base, network[key]);
    }
    if (!/^[1-9][0-9]*(s|m)$/.test(network.observationWindow || '4m')) throw new Error('Invalid observation window');
  }
  // One systemd timer invocation waits for all networks. No overlapping loops.
  const results = await Promise.all(config.networks.map((n) => collect(config, n)));
  if (results.some((r) => r.failed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(() => { console.error('Observation collector failed; inspect private configuration and logs.'); process.exitCode = 1; });
}
