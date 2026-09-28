// Persistent SSH sessions to every discovered host.
//
// Host keys are pinned per EC2 instance ID on first contact and never silently
// replaced. When the agent key is not yet authorized on a host, it is pushed
// once through EC2 Instance Connect (authenticated by the instance IAM role)
// and appended to the ubuntu user's authorized_keys, so new hosts need no
// manual key distribution.
import ssh2 from 'ssh2';
const { Client, utils } = ssh2;
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from '@aws-sdk/client-ec2-instance-connect';
import { existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, writeAtomic } from '../shared/settings.js';

const USER = 'ubuntu';
const CONNECT_TIMEOUT = 12_000;
const PROVISION_BACKOFF = 15 * 60_000;

export function loadOrCreateKey(dir) {
  const path = join(dir, 'id_ed25519');
  if (!existsSync(path)) {
    const k = utils.generateKeyPairSync('ed25519', { comment: 'dash-status-agent' });
    writeAtomic(path, k.private, 0o600);
    writeAtomic(path + '.pub', k.public + '\n', 0o644);
  }
  chmodSync(path, 0o600);
  const priv = readFileSync(path, 'utf8');
  const pub = readFileSync(path + '.pub', 'utf8').trim();
  return { path, priv, pub };
}

function keyType(buf) {
  const len = buf.readUInt32BE(0);
  return buf.subarray(4, 4 + len).toString();
}

export function createPool({ key, stateDir, region, accountId, log = console.log }, connect = (cfg) => { const c = new Client(); c.connect(cfg); return c; }) {
  const pinsPath = join(stateDir, 'hostkeys.json');
  const pins = readJSON(pinsPath, {});
  const sessions = new Map();
  const provisioned = new Map();
  const ic = new EC2InstanceConnectClient({ region });
  const savePins = () => writeAtomic(pinsPath, JSON.stringify(pins, null, 1), 0o600);

  function open(host) {
    return new Promise((resolve, reject) => {
      let mismatch = null;
      const client = connect({
        host: host.publicIp, port: 22, username: USER, privateKey: key.priv, readyTimeout: CONNECT_TIMEOUT,
        keepaliveInterval: 15_000, keepaliveCountMax: 3,
        algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'] },
        hostVerifier: (raw) => {
          const type = keyType(raw), value = raw.toString('base64');
          const pin = pins[host.instanceId];
          if (!pin) {
            pins[host.instanceId] = { type, key: value, address: host.publicIp, pinnedAt: new Date().toISOString() };
            savePins();
            return true;
          }
          if (pin.type === type && pin.key === value) return true;
          mismatch = `host key for ${host.instanceId} changed (pinned ${pin.type} ${fingerprint(pin.key)}, got ${type} ${fingerprint(value)})`;
          return false;
        },
      });
      client.on('error', () => {}); // late socket errors must never crash the agent
      client.once('ready', () => resolve(client));
      client.once('error', (e) => reject(mismatch ? Object.assign(new Error(mismatch), { hostKey: true }) : e));
    });
  }

  async function provision(host) {
    const last = provisioned.get(host.instanceId) || 0;
    if (Date.now() - last < PROVISION_BACKOFF) throw new Error('agent key not authorized; Instance Connect retry pending');
    provisioned.set(host.instanceId, Date.now());
    await ic.send(new SendSSHPublicKeyCommand({ InstanceId: host.instanceId, InstanceOSUser: USER, SSHPublicKey: key.pub }));
    const client = await open(host);
    const line = key.pub.replace(/'/g, '');
    await run(client, `umask 077; mkdir -p ~/.ssh; grep -qxF '${line}' ~/.ssh/authorized_keys 2>/dev/null || echo '${line}' >> ~/.ssh/authorized_keys`, null, 15_000);
    log(`ssh: authorized agent key on ${host.name} (${host.instanceId}) via Instance Connect`);
    return client;
  }

  async function session(host) {
    const current = sessions.get(host.instanceId);
    if (current?.address === host.publicIp) return current.promise;
    current?.promise.then((c) => c.end()).catch(() => {});
    const promise = open(host).catch((e) => {
      if (e.hostKey || e.level !== 'client-authentication') throw e;
      return provision(host);
    });
    const entry = { address: host.publicIp, promise };
    sessions.set(host.instanceId, entry);
    promise.then((c) => {
      const drop = () => { if (sessions.get(host.instanceId) === entry) sessions.delete(host.instanceId); };
      c.once('close', drop); c.once('end', drop); c.on('error', drop);
    }, () => { if (sessions.get(host.instanceId) === entry) sessions.delete(host.instanceId); });
    return promise;
  }

  async function exec(host, command, stdin, timeoutMs = 60_000, onStderr) {
    const client = await session(host);
    try { return await run(client, command, stdin, timeoutMs, onStderr); }
    catch (e) { if (e.channel) { sessions.delete(host.instanceId); client.end(); } throw e; }
  }

  // Known hosts for dashnet use the CLI's instance-scoped alias.
  function knownHosts(hosts) {
    return hosts.filter((h) => pins[h.instanceId]).map((h) => `${h.instanceId}.${region}.${accountId}.dashnet ${pins[h.instanceId].type} ${pins[h.instanceId].key}`).join('\n') + '\n';
  }

  function close() { for (const s of sessions.values()) s.promise.then((c) => c.end()).catch(() => {}); sessions.clear(); }
  // Drop a session whose host key pin was replaced; the next exec reconnects and verifies.
  function drop(instanceId) { sessions.get(instanceId)?.promise.then((c) => c.end()).catch(() => {}); sessions.delete(instanceId); }
  return { exec, knownHosts, close, drop, pins, savePins };
}

function run(client, command, stdin, timeoutMs, onStderr) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(Object.assign(err, { channel: true }));
      const out = [], errOut = [];
      let size = 0;
      const timer = setTimeout(() => { stream.close(); reject(new Error(`timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      stream.on('data', (d) => { size += d.length; if (size < 16 << 20) out.push(d); });
      let pending = '';
      stream.stderr.on('data', (d) => {
        if (errOut.length < 64) errOut.push(d);
        if (!onStderr) return;
        pending += d.toString();
        let i;
        while ((i = pending.indexOf('\n')) >= 0) { onStderr(pending.slice(0, i)); pending = pending.slice(i + 1); }
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(errOut).toString();
        if (code === 0) resolve(stdout);
        else reject(new Error((stderr || stdout).trim().split('\n').slice(-1)[0]?.slice(0, 300) || `exit ${code}`));
      });
      if (stdin != null) stream.end(stdin); else stream.end();
    });
  });
}

export function fingerprint(base64) {
  return 'SHA256:' + createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64').replace(/=+$/, '');
}
