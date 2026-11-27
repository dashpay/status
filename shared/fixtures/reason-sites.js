// Observations that make the evaluator give every reason it can: one host per
// group of checks. Used by server/reason-contract.test.js, which lists the
// sentence each flag() call must produce from them.
import { DEFAULT_SETTINGS, devnetEntry } from '../settings.js';

export function reasonSites(now) {
  const at = (ms = now) => new Date(ms).toISOString(), secs = now / 1000;
  const settings = structuredClone(DEFAULT_SETTINGS);
  const testnet = { ...settings.networks.find((n) => n.name === 'testnet'), hostImages: { 'drift-1': { core: 'dashpay/dashd:23' } } };
  const mainnet = settings.networks.find((n) => n.name === 'mainnet');
  // A report older than its window: the web view says so, the incident
  // producer stops at "collector stale" before it evaluates anything.
  const late = { ...mainnet, name: 'mainnet-late' };
  const building = devnetEntry('devnet-building', { status: 'creating' });
  building.lifecycle = { status: 'creating' };
  settings.networks = [testnet, mainnet, late, building];

  let n = 0;
  const host = (name, role, data, extra = {}) => ({ name, role, state: 'running', instanceId: `i-${String(++n).padStart(4, '0')}`, arch: 'arm64',
    probe: { ok: true, at: at(), data }, ...extra });
  const core = (extra = {}) => ({ chain: 'test', blocks: 100, headers: 100, ibd: false, synced: true, chainLockHeight: 100, chainLockTime: secs - 60,
    peerDiversity: { outbound: 8 }, dkg: [{ aborted: false }], ...extra });
  const ready = { state: 'READY', posePenalty: 0 };
  const explorer = (extra) => ({ status: 200, indexerRunning: true, indexerState: 'running', indexerRestarting: false, ...extra });
  const dashd = (tag) => ({ name: 'core', repo: 'dashpay/dashd', image: `dashpay/dashd:${tag}`, running: true, state: 'running' });

  const hosts = [
    { ...host('stopped-1', 'seed', {}), state: 'stopped' },
    host('skipped-1', 'vpn', {}, { probe: { skipped: true } }),
    host('unreachable-1', 'seed', {}, { probe: { ok: false, at: at(), error: 'connect ETIMEDOUT 10.0.0.9:22' } }),
    host('unprobed-1', 'seed', {}, { probe: undefined }),
    host('stale-1', 'seed', { core: core() }, { probe: { ok: true, at: at(now - 600_000), data: { core: core() } } }),
    host('seed-1', 'seed', { containers: [{ name: 'core', running: true, state: 'running' }] }),
    host('seed-2', 'seed', { containers: [] }),
    host('masternode-1', 'masternode', { core: core({ chain: 'main', ibd: true, progress: 0.5, blocks: 80, headers: 90, synced: false,
      dkg: [{ aborted: true }], masternode: { state: 'POSE_BANNED', posePenalty: 12 } }) }),
    host('masternode-2', 'masternode', { core: core({ chainLockTime: secs - 3600, chainLockHeight: 50, peerDiversity: { outbound: 0 } }) }),
    host('wallet-1', 'wallet', { core: core({ wallets: [{ name: 'faucet', trusted: 5 }, { name: 'Faucet reserve 2', trusted: 99.5 }, { name: 'mining', trusted: 0 }] }) }),
    host('hp-masternode-1', 'validator', { core: core({ masternode: ready }), dapi: { ok: false, error: 'deadline exceeded', query: { ok: false }, tls: { expired: true } } },
      { dapiPublic: { ok: false, error: 'timeout' }, p2p: { port: 19999, ok: false, error: 'ECONNREFUSED' } }),
    host('hp-masternode-2', 'validator', { core: core({ masternode: ready }), tenderdash: { height: 20, catchingUp: true, protocolApp: 9, network: 'dash-testnet-51', round: 7 },
      dapi: { ok: false, query: { ok: true, protocol: 10 }, chainId: 'dash-testnet-50', tls: { trusted: true, expiresAt: at(now + 10 * 3600_000) } } }),
    host('hp-masternode-3', 'validator', { core: core({ masternode: ready }), tenderdash: { height: 50, catchingUp: false, protocolApp: 10, network: 'dash-testnet-51', round: 0, blockTime: at() },
      dapi: { ok: true, query: { ok: true, protocol: 10 }, chainId: 'dash-testnet-51' } }, { dapiPublic: { ok: true }, p2p: { port: 19999, ok: true } }),
    host('services-1', 'service', {
      containers: [
        { name: 'migrate', repo: 'x/explorer', state: 'exited', exitCode: 0, oneShot: true, restartPolicy: 'no', running: false },
        { name: 'api-old', repo: 'x/api', state: 'exited', exitCode: 137, running: false },
        { name: 'api', repo: 'x/api', state: 'running', running: true },
        { name: 'worker', repo: 'x/worker', state: 'exited', exitCode: 1, running: false },
        { name: 'idle', repo: 'x/idle', state: 'exited', running: false },
        { name: 'fresh', repo: 'x/fresh', state: 'created', running: false },
        { name: 'sick', repo: 'x/sick', state: 'running', running: true, health: 'unhealthy' },
      ],
      system: { disks: [{ mount: '/', used: 913, size: 1000 }, { mount: '/mnt/data volume', used: 99, size: 100 }, { mount: '/boot', used: 10, size: 100 }], memTotal: 100, memAvailable: 5 },
      insight: { syncStatus: 'syncing', blocks: 90, query: { ok: false } },
      faucet: { status: 502, queue: { ok: false, queued: 2, oldestQueuedAt: secs - 7200 } },
      services: [{ service: 'prometheus', ok: false }, { service: 'grafana', ok: null, reason: 'authentication required' }, { service: 'elasticsearch', ok: null },
        { service: 'alertmanager', ok: true, down: 2 }, { service: 'miner', ok: true, down: 0 }],
      quorumServer: { status: 503 }, explorer: { status: 500 },
    }, { observation: { continuous: true, core: { blocks: 100, stalledSeconds: 1800 }, platform: { blocks: 50, stalledSeconds: 2400 }, restarts: 2 } }),
    host('services-2', 'service', { insight: { blocks: 100 }, faucet: { kind: 'dash-faucet', state: 'low_balance', balance: 3, status: 200 },
      quorumServer: { status: 200, quorums: 0 }, explorer: explorer({ indexerRestarting: true }) }),
    host('services-3', 'service', { faucet: { kind: 'dash-faucet', state: 'error', status: 503 }, explorer: explorer({ indexerRunning: false }) }),
    host('explorer-1', 'service', { explorer: explorer({ indexerHealth: 'unhealthy' }) }),
    host('explorer-2', 'service', { explorer: explorer({ indexerHealth: 'starting' }) }),
    host('explorer-3', 'service', { explorer: explorer({}) }),
    host('explorer-4', 'service', { explorer: explorer({ chainHeight: 50, indexedHeight: 60 }) }),
    host('explorer-5', 'service', { explorer: explorer({ chainHeight: 50, indexedHeight: 20 }) }),
    host('mixer-1', 'mixer', { core: core({ coinjoin: { enabled: true, running: false } }) }),
    host('drift-1', 'service', { containers: [dashd(22)] }),
    host('rolling-1', 'service', { containers: [dashd(23)] }),
  ];
  // An upgrade of rolling-1 that is under way: its old image is expected.
  const operations = [{ id: 'op-rolling', network: 'testnet', status: 'running', createdAt: at(now - 300_000), confirmedAt: at(now - 240_000), updatedAt: at(now - 30_000),
    progress: {}, request: { action: 'upgrade' }, review: { changes: [{ node: 'rolling-1', component: 'core', from: 'dashpay/dashd:23', to: 'dashpay/dashd:24' }] } }];

  const observer = (name, signals) => host(name, 'fullnode', { core: { chain: 'main', blocks: 100 }, mainnet: signals });
  const signals = { chainLockHeight: 100, chainLockAgeSeconds: 2000.4, platformSyncing: true, bigBans: 3, coreStall: true, platformStall: true,
    platformHeight: 50, quorumServer: { status: 502 }, newBans: 25 };
  const fine = { chainLockHeight: 100, chainLockAgeSeconds: 5, platformSyncing: false, bigBans: 0, coreStall: false, platformStall: false,
    platformHeight: 50, quorumServer: { status: 200, quorums: 4, listed: 10 }, newBans: 0 };
  const state = (list, ms = now) => ({ generatedAt: at(ms), discovery: { at: at(ms), error: null }, endpoints: [], hosts: list });
  const states = {
    testnet: state(hosts),
    mainnet: state([observer('mainnet-observer', {}), observer('mainnet-observer-2', signals)]),
    'mainnet-late': state([observer('mainnet-observer', fine)], now - 600_000),
    'devnet-building': state([host('seed-1', 'seed', { containers: [] })]),
  };
  return { settings, states, operations };
}
