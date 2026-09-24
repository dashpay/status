import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function readJSON(path) {
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Input too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadRegistry(path) {
  const config = readJSON(path);
  const origin = new URL(config.origin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Explicit HTTPS origin required');
  if (!Array.isArray(config.networks) || !config.networks.length) throw new Error('Networks required');
  const names = new Set();
  for (const n of config.networks) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(n.name) || names.has(n.name) || typeof n.public !== 'boolean') throw new Error('Invalid network registration');
    names.add(n.name);
    for (const key of ['snapshot', 'health', 'plan', 'collection']) if (n[key]) n[key] = resolve(dirname(path), n[key]);
    if (!n.snapshot) throw new Error('Observation source required');
    for (const e of n.endpoints || []) {
      const url = new URL(e.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Public endpoints must be credential-free HTTPS without query strings');
    }
  }
  config.origin = origin.origin;
  config.operationsDir = resolve(dirname(path), config.operationsDir || 'operations');
  return config;
}
const finite = (v) => Number.isFinite(v) ? v : null;
export function grants(config, user, network) {
  const access = user ? config.operators?.[String(user.id)] : null;
  return Array.isArray(access?.networks) && access.networks.includes(network) ? access.actions || [] : [];
}
export function canView(config, user, n) {
  return n.public || grants(config, user, n.name).length > 0 || (user && n.viewers?.includes(String(user.id)));
}
// Construct a positive allow-list. Never return a spread operator snapshot.
export function projectNetwork(n, snapshot, health, now = Date.now(), operator = false) {
  if (snapshot.kind !== 'ExistingSnapshot' || snapshot.fleet?.metadata?.name !== n.name) throw new Error('Snapshot scope mismatch');
  const at = Date.parse(snapshot.observedAt);
  const maxAge = n.maxAgeSeconds || 600;
  const stale = !Number.isFinite(at) || now - at > maxAge * 1000 || at > now + 60_000;
  const targets = snapshot.fleet.targets;
  if (!Array.isArray(targets) || !targets.length) throw new Error('Missing targets');
  const verified = health?.snapshot?.id === snapshot.id && health.healthy === true &&
    Number.isFinite(Date.parse(health.observedAt)) && Math.abs(Date.parse(health.observedAt) - at) < maxAge * 1000;
  const nodes = targets.map((t) => {
    const o = snapshot.nodes?.[t.name];
    const unknown = !o || !!o.error || o.instanceId !== t.instanceId;
    const c = o?.chain || {};
    const missing = Object.keys(t.containers || {}).some((component) => !o?.components?.[component]);
    const degraded = missing || (o?.problems || []).length > 0 || Object.values(o?.components || {}).some((s) => !s.running) ||
      (t.role === 'validator' && (!c.dapiHealthy || c.catchingUp || c.masternodeState !== 'READY'));
    const status = stale ? 'stale' : unknown ? 'unknown' : degraded ? 'degraded' : verified ? 'healthy' : 'observed';
    const row = { name: t.name, role: t.role, status, coreHeight: finite(c.coreHeight), platformHeight: finite(c.platformHeight),
      dapi: unknown || stale ? 'unknown' : c.dapiHealthy ? 'available' : t.role === 'validator' ? 'unavailable' : 'not-applicable',
      services: Object.entries(o?.components || {}).map(([component, s]) => ({ component, image: String(s.image || ''), running: !!s.running, restarts: finite(s.restarts) })) };
    if (operator) row.operator = { instanceId: t.instanceId, address: t.address, architecture: t.architecture,
      error: o?.error || null, problems: o?.problems || [], filesFingerprint: o?.filesHash || null,
      proTxHash: c.proTxHash || null, coreGenesis: c.coreGenesis || null, platformChainId: c.platformChainId || null };
    return row;
  });
  const counts = Object.fromEntries(['healthy', 'observed', 'degraded', 'unknown', 'stale'].map((s) => [s, nodes.filter((n) => n.status === s).length]));
  const status = stale ? 'stale' : counts.unknown ? 'unknown' : counts.degraded ? 'degraded' : verified ? 'healthy' : 'observed';
  const heights = (key) => nodes.map((v) => v[key]).filter((v) => v !== null && v > 0);
  const range = (key) => { const values = heights(key); return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null; };
  const protocols = [...new Set(Object.values(snapshot.nodes || {}).map((v) => v.chain?.platformProtocol).filter(Boolean))];
  return { name: n.name, displayName: n.displayName || snapshot.fleet.metadata.displayName, description: n.description || snapshot.fleet.metadata.description,
    type: snapshot.fleet.chainType, status, observedAt: snapshot.observedAt, verifiedAt: verified ? health.observedAt : null,
    freshnessSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null, expectedNodes: targets.length, counts,
    core: range('coreHeight'), platform: range('platformHeight'), protocols, endpoints: (n.endpoints || []).map(({ label, url }) => ({ label, url })), nodes };
}
export function networkView(n, user, config, now = Date.now()) {
  const operator = grants(config, user, n.name).length > 0;
  let snapshot, health;
  try {
    snapshot = readJSON(n.snapshot);
    if (n.health) {
      try { health = readJSON(n.health); } catch { health = null; }
      if (health) {
        if (health.snapshot?.fleet?.metadata?.name !== n.name) throw new Error('Health scope mismatch');
        if (Date.parse(health.snapshot.observedAt) > Date.parse(snapshot.observedAt)) snapshot = health.snapshot;
      }
    }
    const view = projectNetwork(n, snapshot, health, now, operator);
    if (n.collection) {
      let collection;
      try { collection = readJSON(n.collection); } catch { collection = null; }
      if (collection?.failed && Date.parse(collection.completedAt || collection.attemptedAt) >= Date.parse(snapshot.observedAt)) {
        view.status = 'unknown'; view.notice = 'Latest observation could not be completed. Previous values are shown below.';
        view.verifiedAt = null;
        for (const node of view.nodes) { node.status = 'unknown'; node.dapi = 'unknown'; }
        view.counts = { unknown: view.expectedNodes };
      }
    }
    return { ...view, permissions: operator ? grants(config, user, n.name) : [], management: operator ? n.management || 'not-enrolled' : undefined };
  } catch {
    return { name: n.name, displayName: n.displayName || n.name, description: n.description || '', status: 'unknown',
      observedAt: null, expectedNodes: null, counts: {}, nodes: [], endpoints: [], permissions: operator ? grants(config, user, n.name) : [],
      notice: 'Observation unavailable. No targets are assumed healthy.' };
  }
}
