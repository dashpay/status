// Turns agent state into what the board shows. Every status comes with the
// concrete facts that produced it; there is no status without a reason.
import { COMPONENT_REPOS, SIDECAR_REPOS } from './settings.js';

export const LEVELS = ['ok', 'warn', 'down', 'unreachable', 'stopped', 'deploying'];
// `info` facts are shown with the host but never change its status.
const RANK = { info: 0, ok: 0, stopped: 1, deploying: 1, warn: 2, down: 3, unreachable: 3 };
const BY_REPO = Object.fromEntries(Object.entries(COMPONENT_REPOS).map(([c, r]) => [r, c]));
// Older agents reported index.docker.io/ prefixes for digest-pulled images.
const COMPONENT_OF = new Proxy(BY_REPO, { get: (t, k) => (typeof k === 'string' ? t[k.replace(/^(index\.)?docker\.io\//, '')] : undefined) });
// What a dashmate sidecar container is for, if it is one.
export function sidecarOf(container) {
  const repo = String(container.repo || '').replace(/^(index\.)?docker\.io\/(library\/)?/, '');
  if (SIDECAR_REPOS[repo]) return SIDECAR_REPOS[repo];
  return repo === 'redis' && /rate_limiter_redis/.test(container.name || '') ? 'rate limiter store' : null;
}
const CORE_ROLES = new Set(['validator', 'masternode', 'seed', 'fullnode', 'web', 'wallet', 'miner', 'mixer']);

export function tagOf(image) {
  if (!image) return null;
  const [name, digest] = image.split('@');
  const last = name.split('/').pop();
  return last.includes(':') ? last.split(':').pop() : digest ? `@${digest.slice(7, 19)}` : 'latest';
}

// Human version of a container: the tag when there is one, else the version the
// service reports about itself (e.g. DAPI getStatus), else the short digest.
function versionOf(component, container, data, tags = {}) {
  const tag = tagOf(container.image);
  if (!tag?.startsWith('@')) return tag;
  const known = tags[container.image.split('@')[1]];
  if (known) return tagOf(known);
  const reported = { dapi: data.dapi?.dapiVersion, drive: data.dapi?.driveVersion, tenderdash: data.tenderdash?.version || data.dapi?.tenderdashVersion }[component];
  return reported ? `${reported.replace(/^unreleased-/, '').slice(0, 24)} ${tag}` : tag;
}

const pct = (used, total) => (total ? Math.round((used / total) * 1000) / 10 : null);

export function evaluateNetwork(network, state, settings, now = Date.now(), tags = {}) {
  const t = settings.thresholds;
  const hosts = state?.hosts || [];
  const live = (h) => (h?.probe?.ok ? h.probe.data : null);
  const coreTip = Math.max(0, ...hosts.map((h) => live(h)?.core?.blocks || 0));
  const platformTip = Math.max(0, ...hosts.map((h) => live(h)?.tenderdash?.height || live(h)?.dapi?.height || 0));
  const tipHost = hosts.find((h) => live(h)?.core?.blocks === coreTip);
  const platformHost = hosts.find((h) => (live(h)?.tenderdash?.height || 0) === platformTip && live(h)?.tenderdash?.blockTime);

  const building = ['creating', 'services'].includes(network.lifecycle?.status);
  const rows = hosts.map((h) => {
    const d = live(h) || {};
    const reasons = [];
    let level = 'ok';
    const flag = (l, text) => { reasons.push({ level: l, text }); if (RANK[l] > RANK[level]) level = l; };
    if (h.state !== 'running') flag('stopped', `instance ${h.state}`);
    else if (h.probe?.skipped) { /* reachable per EC2; host is not probed (vpn) */ }
    else if (!h.probe?.ok) flag('unreachable', `probe failed: ${h.probe?.error || 'no result yet'}`);
    else {
      const c = d.core;
      if (CORE_ROLES.has(h.role)) {
        if (!c) flag('down', (d.containers || []).some((k) => k.running) ? 'Core RPC not answering' : 'no Dash services running on host');
        else {
          if (c.chain && network.coreNetwork && !chainMatches(c.chain, network)) flag('down', `Core on chain "${c.chain}"`);
          if (c.ibd) flag('warn', `Core initial sync ${Math.round((c.progress || 0) * 1000) / 10}%`);
          const lag = coreTip - (c.blocks || 0);
          if (lag > t.coreLagBlocks) flag('warn', `Core ${lag} blocks behind tip`);
          if (c.synced === false) flag('warn', 'masternode sync not finished');
          const mn = c.masternode;
          if (['validator', 'masternode'].includes(h.role)) {
            if (!mn) flag('down', 'masternode status unavailable');
            else if (mn.state !== 'READY') flag('down', `masternode ${mn.state}`);
            if (mn?.posePenalty > 0) flag('warn', `PoSe penalty ${mn.posePenalty}`);
          }
          for (const w of c.wallets || []) {
            if (h.role === 'wallet' && /faucet/i.test(w.name) && (w.trusted ?? 0) < t.balanceWarn) flag('warn', `wallet ${w.name} balance ${w.trusted}`);
          }
        }
      }
      if (h.role === 'validator') {
        const td = d.tenderdash;
        if (!td) flag('down', 'Tenderdash RPC not answering');
        else {
          if (td.catchingUp) flag('warn', 'Tenderdash catching up');
          const lag = platformTip - (td.height || 0);
          if (lag > t.platformLagBlocks) flag('warn', `Platform ${lag} blocks behind tip`);
        }
        if (d.dapi && !d.dapi.ok) flag('down', `DAPI getStatus failed${d.dapi.error ? `: ${d.dapi.error}` : ''}`);
        // Short-lived (about 6 day) IP certificates renew with 3 days left.
        const tlsLeft = d.dapi?.tls?.expired ? 0 : d.dapi?.tls?.trusted && d.dapi.tls.expiresAt ? Date.parse(d.dapi.tls.expiresAt) - now : null;
        if (tlsLeft !== null && tlsLeft < 36 * 3600_000) flag(tlsLeft <= 0 ? 'down' : 'warn', tlsLeft <= 0 ? 'gateway certificate expired' : `gateway certificate expires in ${Math.max(1, Math.round(tlsLeft / 3600_000))} h; renewal is not succeeding`);
        if (h.dapiPublic && !h.dapiPublic.ok) flag('warn', `DAPI :443 not reachable from status host (${h.dapiPublic.error})`);
      }
      if (h.p2p && !h.p2p.ok) flag('warn', `P2P :${h.p2p.port} not reachable from status host (${h.p2p.error})`);
      for (const k of d.containers || []) {
        const why = `container ${k.name} ${k.state}${k.exitCode ? ` (exit ${k.exitCode})` : ''}`;
        // A stopped container is an orphan when a running one serves the same image repo.
        const replaced = (d.containers || []).some((o) => o !== k && o.running && o.repo === k.repo);
        if (!k.running) flag(replaced || k.state === 'created' ? 'info' : 'down', replaced ? `${why}; superseded by a running ${k.repo} container` : why);
        else if (k.health === 'unhealthy') flag('warn', `container ${k.name} unhealthy`);
      }
      const s = d.system;
      if (s) {
        for (const disk of s.disks || []) { const p = pct(disk.used, disk.size); if (p >= t.diskWarnPercent) flag('warn', `disk ${disk.mount} ${p}%`); }
        const mem = pct(s.memTotal - s.memAvailable, s.memTotal);
        if (mem >= t.memWarnPercent) flag('warn', `memory ${mem}%`);
      }
      if (d.insight && (d.insight.syncStatus !== 'finished' || coreTip - (d.insight.blocks || 0) > t.coreLagBlocks)) flag('warn', `Insight ${d.insight.syncStatus || 'unknown'} at ${d.insight.blocks}`);
      if (d.faucet?.kind === 'dash-faucet') {
        if (d.faucet.state === 'low_balance') flag('warn', `faucet balance ${d.faucet.balance} below payout reserve`);
        else if (d.faucet.status !== 200) flag('down', `faucet /api/status HTTP ${d.faucet.status}`);
      } else if (d.faucet && d.faucet.status >= 500) flag('down', `faucet HTTP ${d.faucet.status}`);
      if (d.quorumServer) {
        if (d.quorumServer.status !== 200) flag('down', `quorum server /health HTTP ${d.quorumServer.status}`);
        else if (!d.quorumServer.quorums) flag('warn', 'quorum server lists no quorums');
      }
      if (d.explorer) {
        if (d.explorer.status !== 200) flag('down', `explorer API /status HTTP ${d.explorer.status}`);
        else if (!d.explorer.indexerRunning) flag('down', 'explorer indexer not running');
        else if ((d.explorer.chainHeight || 0) - (d.explorer.indexedHeight || 0) > t.platformLagBlocks) flag('warn', `explorer indexer ${(d.explorer.chainHeight || 0) - (d.explorer.indexedHeight || 0)} blocks behind`);
      }
      if (network.chainType === 'mainnet') {
        const m = d.mainnet || {};
        const signals = network.mainnetSignals || {};
        const chainLockAge = Number.isFinite(m.chainLockAgeSeconds) ? m.chainLockAgeSeconds : null;
        const coreStall = m.coreStall === true;
        const platformStall = m.platformStall === true;
        if (!Number.isFinite(m.chainLockHeight) || m.chainLockHeight <= 0) flag('down', 'mainnet ChainLock unavailable');
        if (chainLockAge !== null && chainLockAge > 1800) flag('warn', `mainnet ChainLock is ${Math.round(chainLockAge)}s old`);
        if (m.platformSyncing === true) flag('warn', 'mainnet observer Platform is catching up; live chain status not yet known');
        if (m.bigBans == null) flag('warn', 'mainnet PoSe census unavailable');
        if (chainLockAge === null) flag('warn', 'mainnet ChainLock age unavailable');
        if (coreStall) flag('down', 'mainnet Core chain stalled');
        if (platformStall) flag('down', 'mainnet Platform chain stalled');
        if (!Number.isFinite(m.platformHeight) || m.platformHeight <= 0) flag('down', 'mainnet Platform height unavailable');
        if (m.quorumServer?.status !== 200 || !m.quorumServer?.quorums || !m.quorumServer?.listed) flag('down', `mainnet quorum list HTTP ${m.quorumServer?.status ?? 'unavailable'}`);
        const banned = m.newBans;
        const banThreshold = Number.isFinite(signals.bigBanThreshold) ? signals.bigBanThreshold : 20;
        if (banned != null && banned >= banThreshold) flag('warn', `mainnet newly PoSe-banned masternodes ${banned} in one hour`);
      }
    }
    // A console devnet under construction is not failing: say what is happening.
    if (building && level !== 'ok' && level !== 'stopped') {
      reasons.unshift({ level: 'deploying', text: `devnet ${network.lifecycle.status}; services start as the creation operation reaches them` });
      level = 'deploying';
    }
    return { host: h, data: d, level, reasons };
  });

  const counts = Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.level === l).length]));
  let reportStale = false;
  if (network.source === 'report') {
    const observed = Date.parse(state?.generatedAt || '');
    const window = /^([0-9]+)(s|m|h)$/.exec(network.observationWindow || '30m');
    const maxAge = network.chainType === 'mainnet' ? 180_000 : window ? Number(window[1]) * (window[2] === 'h' ? 3600_000 : window[2] === 'm' ? 60_000 : 1000) : 30 * 60_000;
    const stale = !Number.isFinite(observed) || now - observed > maxAge || observed > now + 60_000;
    reportStale = stale;
    if (stale) {
      const row = rows.find((r) => r.host.role === 'fullnode');
      if (row) { row.level = 'unreachable'; row.reasons.push({ level: 'unreachable', text: 'mainnet observer report is stale' }); }
    }
  }
  const refreshedCounts = Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.level === l).length]));
  Object.assign(counts, refreshedCounts);
  const versions = {};
  for (const r of rows) for (const k of r.data.containers || []) {
    const component = COMPONENT_OF[k.repo];
    if (!component) continue;
    const v = versionOf(component, k, r.data, tags);
    versions[component] ??= {};
    versions[component][v] = (versions[component][v] || 0) + 1;
  }
  const tipData = live(tipHost) || {};
  const validatorRows = rows.filter((r) => r.host.role === 'validator');
  const summary = {
    core: coreTip ? { height: coreTip, blockTime: tipData.core?.blockTime ? tipData.core.blockTime * 1000 : null, chainLock: Math.max(0, ...rows.map((r) => r.data.core?.chainLockHeight || 0)) || null, difficulty: tipData.core?.difficulty, protocol: tipData.core?.protocol, chain: tipData.core?.chain } : null,
    platform: platformTip ? { height: platformTip, blockTime: platformHost ? Date.parse(live(platformHost).tenderdash.blockTime) : null, chainId: validatorRows.map((r) => r.data.tenderdash?.network).find(Boolean) || null, protocol: validatorRows.map((r) => r.data.tenderdash?.protocolApp).find(Boolean) || null, validatorSet: validatorRows.map((r) => r.data.tenderdash?.validatorSetSize).find(Boolean) || null } : null,
    counts, versions,
    masternodes: {
      ready: rows.filter((r) => r.data.core?.masternode?.state === 'READY').length,
      total: rows.filter((r) => ['validator', 'masternode'].includes(r.host.role) && r.host.state === 'running').length,
      pose: rows.filter((r) => r.data.core?.masternode?.posePenalty > 0).length,
    },
    dapi: { ok: validatorRows.filter((r) => r.data.dapi?.ok).length, total: validatorRows.filter((r) => r.host.state === 'running').length },
  };
  const mainnetRow = rows.find((r) => r.host.role === 'fullnode' && r.data.mainnet);
  if (network.chainType === 'mainnet' && mainnetRow) {
    const m = mainnetRow.data.mainnet || {};
    summary.mainnet = {
      chainLock: m.chainLockHeight ?? null,
      chainLockAgeSeconds: m.chainLockAgeSeconds ?? null,
      platformHeight: m.platformHeight ?? mainnetRow.data.tenderdash?.height ?? null,
      bigBans: m.bigBans ?? m.quorumServer?.banned ?? null,
      quorumCount: m.quorumServer?.quorums ?? null,
      coreStall: m.coreStall ?? null,
      platformStall: m.platformStall ?? null,
      platformSyncing: m.platformSyncing ?? null, newBans: m.newBans ?? null,
    };
  }
  const level = rows.reduce((a, r) => (r.host.duplicate || r.host.role === 'vpn' ? a : RANK[r.level] > RANK[a] ? r.level : a), 'ok');
  return { level: reportStale ? 'unreachable' : building ? 'deploying' : level === 'stopped' ? 'ok' : level, rows, summary, tags, generatedAt: state?.generatedAt || null, ageSeconds: state?.generatedAt ? Math.round((now - Date.parse(state.generatedAt)) / 1000) : null };
}

function chainMatches(chain, network) {
  if (network.chainType === 'devnet') return chain === network.coreNetwork || chain === 'devnet';
  return chain === network.coreNetwork;
}

// Projection. Public: facts useful to infra engineers, without instance IDs,
// private addresses, raw probe errors or (unless enabled) wallet balances.
export function projectNetwork(network, evaluation, state, operator) {
  const hosts = evaluation.rows.map(({ host: h, data: d, level, reasons }) => {
    const c = d.core || {}, td = d.tenderdash || {}, s = d.system || {};
    const row = {
      name: h.name, role: h.role, level, reasons: reasons.map((r) => ({ level: r.level, text: operator ? r.text : publicReason(r.text, network) })),
      publicIp: h.publicIp, instanceType: h.instanceType, arch: h.arch, state: h.state, az: h.az, duplicate: !!h.duplicate,
      probedAt: h.probe?.at || null, probeMs: h.probe?.ms ?? null,
      core: d.core ? { height: c.blocks, headers: c.headers, chainLock: c.chainLockHeight, version: c.subversion, protocol: c.protocol, peers: c.connections, peersIn: c.connectionsIn, ibd: c.ibd, synced: c.synced, sizeOnDisk: c.sizeOnDisk, mempool: c.mempool, bestBlock: c.bestBlockHash, blockTime: c.blockTime } : null,
      masternode: c.masternode ? { state: c.masternode.state, type: c.masternode.type, proTxHash: c.masternode.proTxHash, pose: c.masternode.posePenalty, lastPaid: c.masternode.lastPaidHeight, registered: c.masternode.registeredHeight, service: c.masternode.service } : null,
      platform: d.tenderdash ? { height: td.height, blockTime: td.blockTime, peers: td.peers, catchingUp: td.catchingUp, network: td.network, protocol: td.protocolApp, version: td.version, votingPower: td.votingPower, inValidatorSet: td.inValidatorSet, nodeId: td.nodeId } : null,
      dapi: d.dapi ? { ok: d.dapi.ok, latencyMs: d.dapi.latencyMs, height: d.dapi.height, dapiVersion: d.dapi.dapiVersion, driveVersion: d.dapi.driveVersion, tls: d.dapi.tls || null, error: operator ? d.dapi.error : undefined } : null,
      insight: d.insight || null, faucet: d.faucet ? (operator || network.showBalances ? d.faucet : { ...d.faucet, balance: undefined, utxos: undefined }) : null, quorumServer: d.quorumServer || null, explorer: d.explorer || null,
      wallets: c.wallets && (network.showBalances || operator) ? c.wallets.filter((w) => w.name).map((w) => ({ name: w.name, trusted: w.trusted, pending: w.pending, immature: w.immature, coinjoin: w.coinjoin })) : c.wallets ? { count: c.wallets.filter((w) => w.name).length } : null,
      system: d.system ? { load: s.load, cpus: s.cpus, memPercent: pct(s.memTotal - s.memAvailable, s.memTotal), memTotal: s.memTotal, swapPercent: s.swapTotal ? pct(s.swapTotal - s.swapFree, s.swapTotal) : null, disks: (s.disks || []).map((x) => ({ mount: x.mount, percent: pct(x.used, x.size), size: x.size, avail: x.avail })), uptime: s.uptime, os: s.os, kernel: s.kernel } : null,
      containers: (d.containers || []).map((k) => ({ name: k.name, component: COMPONENT_OF[k.repo] || null, sidecar: sidecarOf(k), image: k.image, version: COMPONENT_OF[k.repo] ? versionOf(COMPONENT_OF[k.repo], k, d, evaluation.tags) : tagOf(k.image), digest: k.digest, state: k.state, running: k.running, restarts: k.restarts, startedAt: k.startedAt, health: k.health })),
      p2p: h.p2p ? { port: h.p2p.port, ok: h.p2p.ok, ms: h.p2p.ms } : null,
      dapiPublic: h.dapiPublic ? { ok: h.dapiPublic.ok, ms: h.dapiPublic.ms } : null,
      mainnet: d.mainnet ? {
        chainLockHeight: d.mainnet.chainLockHeight, chainLockAgeSeconds: d.mainnet.chainLockAgeSeconds,
        platformHeight: d.mainnet.platformHeight, bigBans: d.mainnet.bigBans,
        coreStall: d.mainnet.coreStall ?? null, platformStall: d.mainnet.platformStall ?? null,
        platformSyncing: d.mainnet.platformSyncing ?? null, newBans: d.mainnet.newBans ?? null,
        quorumServer: d.mainnet.quorumServer || null,
      } : null,
    };
    if (operator) Object.assign(row, { instanceId: h.instanceId, privateIp: h.privateIp, nameTag: h.nameTag, keyName: h.keyName, launchTime: h.launchTime, tagged: h.tagged, probeError: h.probe?.error || null, probeErrors: d.errors || [], lastGood: h.lastGood ? { at: h.lastGood.at } : null });
    return row;
  });
  return {
    name: network.name, displayName: network.displayName, description: network.description || '', chainType: network.chainType, coreNetwork: network.coreNetwork,
    public: network.public, deployable: network.deployable, kind: network.kind || 'managed', upgradeScopes: network.upgradeScopes || null, images: network.images || null, dashmate: !!network.dashmate, lifecycle: network.lifecycle || null, observationWindow: network.observationWindow, operationTimeout: network.operationTimeout, level: evaluation.level, generatedAt: evaluation.generatedAt, ageSeconds: evaluation.ageSeconds,
    pollSeconds: state?.pollSeconds || null, discovery: state?.discovery ? { at: state.discovery.at, error: operator ? state.discovery.error : state.discovery.error ? 'discovery failed' : null } : null,
    summary: evaluation.summary, endpoints: (state?.endpoints || []).map((e) => ({ label: e.label, kind: e.kind, url: e.url, status: e.status, ok: e.ok, ms: e.ms, error: e.error, height: e.height, version: e.version, chainId: e.chainId })),
    hosts, journal: operator ? state?.journal || null : undefined,
  };
}

function publicReason(text, network) {
  if (text.startsWith('probe failed')) return 'host not reachable by status agent';
  if (!network.showBalances && /balance/i.test(text)) return /faucet/i.test(text) ? 'faucet balance below threshold' : 'wallet balance below threshold';
  return text.replace(/: .*$/, '');
}
