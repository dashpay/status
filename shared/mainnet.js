// Public-data-only boundary. Failure samples are data, never manufactured health.
const integer = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const finite = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const text = (v, max = 80) => typeof v === 'string' ? v.slice(0, max) : null;
const boolean = (v) => typeof v === 'boolean' ? v : null;
const timestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function validateMainnetReport(input, now = Date.now()) {
  if (!input || input.network !== 'mainnet') throw new Error('mainnet report required');
  const at = timestamp(input.generatedAt);
  if (!at || Date.parse(at) > now + 60_000 || now - Date.parse(at) > 180_000) throw new Error('mainnet report timestamp invalid or stale');
  let core = null;
  if (input.core != null) {
    if (input.core.chain !== 'main' || integer(input.core.blocks) === null) throw new Error('mainnet Core chain and height required');
    const c = input.core;
    core = { chain: 'main', blocks: c.blocks, headers: integer(c.headers), chainLockHeight: integer(c.chainLockHeight),
      bestBlockHash: /^[a-f0-9]{64}$/i.test(c.bestBlockHash || '') ? c.bestBlockHash : null,
      blockTime: finite(c.blockTime), ibd: boolean(c.ibd), synced: boolean(c.synced),
      subversion: text(c.subversion), protocol: integer(c.protocol), connections: integer(c.connections) };
  }
  let platform = null;
  if (input.platform != null) {
    const p = input.platform;
    if (p.network !== 'evo1' || integer(p.height) === null) throw new Error('mainnet Platform chain and height required');
    platform = { height: p.height, blockTime: timestamp(p.blockTime), network: p.network,
      catchingUp: boolean(p.catchingUp), maxPeerHeight: integer(p.maxPeerHeight), peers: integer(p.peers), version: text(p.version) };
  }
  const q = input.quorumServer;
  const quorum = q && typeof q === 'object' ? Object.fromEntries(['status', 'quorums', 'listed', 'banned', 'enabled', 'versionFailures'].map((k) => [k, integer(q[k])])) : null;
  if (quorum) quorum.latencyMs = finite(q.latencyMs);
  const mainnet = { chainLockHeight: core?.chainLockHeight ?? null, chainLockAgeSeconds: finite(input.mainnet?.chainLockAgeSeconds),
    platformHeight: platform?.height ?? null, platformSyncing: platform?.catchingUp ?? null,
    bigBans: integer(input.mainnet?.bigBans), newBans: integer(input.mainnet?.newBans), banWindowSeconds: 3600,
    quorumServer: quorum, coreStall: core?.ibd === false ? boolean(input.mainnet?.coreStall) : null,
    platformStall: platform?.catchingUp === false ? boolean(input.mainnet?.platformStall) : null };
  return { network: 'mainnet', generatedAt: at, pollSeconds: 60, discovery: { at, error: null },
    endpoints: [{ label: 'Quorum list', kind: 'quorum', url: 'https://quorums.mainnet.networks.dash.org/masternodes',
      status: quorum?.status ?? null, ok: quorum?.status === 200 && quorum.quorums > 0 && quorum.listed > 0, ms: quorum?.latencyMs ?? null }],
    hosts: [{ name: 'mainnet-observer', role: 'fullnode', state: 'running', publicIp: null, privateIp: null,
      probe: { ok: true, at, ms: finite(input.probeMs) ?? 0, data: { core, tenderdash: platform, mainnet, containers: [], system: null } } }] };
}
