// Separate on-demand service. No secret cache or files; pinned SSH only.
import { readFileSync, readdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import ssh2 from 'ssh2';
import { mergeDevnets, validateSettings, operatorFor, readJSON } from '../shared/settings.js';

const REMOTE = readFileSync(new URL('./devnet-keys.py', import.meta.url), 'utf8');
export function keyScope(dataDir, privateDir, name, user) {
  if (!/^devnet-[a-z0-9-]+$/.test(name)) throw Error('scope');
  // Key access must fail closed on malformed settings, never inherit defaults.
  const settings = mergeDevnets(validateSettings(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))), readJSON(join(dataDir, 'devnets.json'), {}));
  const n = settings.networks.find(n => n.name === name);
  const reg = readJSON(join(dataDir, 'devnets.json'), {})[name];
  if (!n || n.kind !== 'dashnet' || n.chainType !== 'devnet' || !reg || reg.status !== 'ready' || !operatorFor(settings, user, name)) throw Error('scope');
  const ops = join(dataDir, 'ops');
  if (readdirSync(ops).filter(f => f.endsWith('.json')).some(f => { const r = readJSON(join(ops, f)); return r?.network === name && ['queued', 'preparing', 'confirmed', 'running', 'queued-run'].includes(r.status); })) throw Error('busy');
  const work = join(privateDir, 'devnets', name);
  const plan = readJSON(join(work, 'deployment.json'));
  const records = readdirSync(work).filter(f => /^deployed\..*\.json$/.test(f)).sort();
  const deployment = readJSON(join(work, records.at(-1) || 'missing'))?.deployment;
  if (!plan || !deployment || deployment.planId !== plan.id || !plan.targets?.length) throw Error('deployment');
  const chain = plan.coreNetwork.startsWith('devnet-') ? plan.coreNetwork : `devnet-${plan.coreNetwork}`;
  if (chain !== n.coreNetwork) throw Error('chain');
  const hosts = plan.targets.filter(t => ['validator', 'wallet'].includes(t.role)).map(t => ({
    name: t.name, role: t.role, instanceId: t.instanceId, publicIp: t.sshAddress || t.peerAddress,
    proTxHash: deployment.nodes[t.name]?.proTxHash, operatorPublicKey: deployment.nodes[t.name]?.operatorPublicKey, platformNodeId: deployment.nodes[t.name]?.platformNodeId,
  }));
  const validators = hosts.filter(h => h.role === 'validator');
  if (!validators.length || hosts.filter(h => h.role === 'wallet').length !== 1 || validators.some(h => !h.proTxHash || !h.operatorPublicKey || !h.platformNodeId)) throw Error('identities');
  return { network: name, chain, hosts, validators, sporkAddress: deployment.sporkAddress, payoutAddress: deployment.payoutAddress, faucetAddress: reg.walletAddress };
}

export function readHost(host, request, privateDir) {
  return new Promise((resolve, reject) => {
    const pin = readJSON(join(privateDir, 'hostkeys.json'), {})[host.instanceId];
    if (!pin) return reject(Error('missing verified SSH pin'));
    const client = new ssh2.Client();
    let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); client.end(); err ? reject(Error('Devnet key read or identity verification failed')) : resolve(value); };
    const timer = setTimeout(() => finish(Error('timeout')), 90_000);
    client.on('error', () => finish(Error('ssh')));
    client.on('close', () => { if (!done) finish(Error('closed')); });
    client.on('ready', () => {
      // JSON is shell-quoted; keys never appear in the command or request.
      const arg = JSON.stringify({ ...request, host }).replace(/'/g, "'\\''");
      client.exec(`sudo -n python3 - '${arg}'`, (err, stream) => {
        if (err) return finish(err);
        let out = '';
        stream.on('data', chunk => { out += chunk; if (out.length > 1024 * 1024) { stream.close(); finish(Error('size')); } });
        stream.stderr.resume(); // never log a remote diagnostic
        stream.on('close', code => {
          if (code !== 0) return finish(Error('remote'));
          try { finish(null, JSON.parse(out)); } catch { finish(Error('format')); }
        });
        stream.end(REMOTE);
      });
    });
    client.connect({ host: host.publicIp, username: 'ubuntu', privateKey: readFileSync(join(privateDir, 'id_ed25519')), readyTimeout: 12_000,
      algorithms: { serverHostKey: [pin.type] }, hostVerifier: raw => raw.toString('base64') === pin.key });
  });
}

export async function collectKeys({ dataDir, privateDir, network, user, read = readHost }) {
  const scope = keyScope(dataDir, privateDir, network, user);
  const wallet = scope.hosts.find(h => h.role === 'wallet');
  const walletKeys = await read(wallet, scope, privateDir);
  const rows = [];
  for (let i = 0; i < scope.validators.length; i += 4) {
    rows.push(...await Promise.all(scope.validators.slice(i, i + 4).map(async h => ({
      name: h.name, proTxHash: h.proTxHash, operatorPublicKey: h.operatorPublicKey, platformNodeId: h.platformNodeId,
      ...walletKeys.validators[h.name], ...await read(h, scope, privateDir),
    }))));
  }
  // Recheck grants and deployment identity after the slow SSH work.
  if (JSON.stringify(keyScope(dataDir, privateDir, network, user)) !== JSON.stringify(scope)) throw Error('scope changed');
  return { network, chain: scope.chain, verifiedAt: new Date().toISOString(), validators: rows, networkKeys: walletKeys.networkKeys };
}

export function startKeyService({ dataDir, privateDir, socketPath }) {
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || req.url !== '/keys') { res.writeHead(404).end(); return; }
    if (busy) { res.writeHead(409).end(); return; }
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2048) throw Error('size'); }
      const { network, user } = JSON.parse(body);
      const result = await collectKeys({ dataDir, privateDir, network, user });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch { res.writeHead(503).end(JSON.stringify({ error: 'Keys unavailable: devnet must be idle and all identities must verify' })); }
    finally { busy = false; }
  });
  server.requestTimeout = 30_000;
  try { unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return server;
}
