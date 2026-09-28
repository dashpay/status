// The public web process holds no cloud, SSH or repository credentials. A separate
// trusted broker prepares immutable plans and dispatches the reviewed request.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, openSync, closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from './networks.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const repos = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper' };
const active = new Set(['queued', 'dispatching', 'submitted', 'unknown', 'in_progress', 'waiting', 'pending']);
export function validateSelection(n, action, selection) {
  if (!['upgrade', 'deploy', 'doctor', 'import', 'enroll'].includes(action)) throw new Error('Unsupported operation');
  const snapshot = readJSON(n.snapshot);
  if (snapshot.fleet?.metadata?.name !== n.name) throw new Error('Snapshot scope mismatch');
  const names = selection?.nodes;
  if (!Array.isArray(names) || !names.length || names.length > 200 || new Set(names).size !== names.length) throw new Error('Select one or more nodes');
  const targets = names.map((name) => snapshot.fleet.targets.find((t) => t.name === name));
  if (targets.some((t) => !t)) throw new Error('Selected node is not enrolled in this network inventory');
  const components = selection.components || [], images = selection.images || {};
  if (['upgrade', 'deploy'].includes(action)) {
    if (!components.length || components.length > 6 || new Set(components).size !== components.length || components.some((c) => !repos[c])) throw new Error('Select components');
    if (targets.some((t) => components.some((c) => !t.containers[c]))) throw new Error('A selected component does not exist on every selected node');
    if (Object.keys(images).some((c) => !components.includes(c))) throw new Error('Image outside component selection');
    if (action === 'upgrade') for (const c of components) {
      const image = images[c];
      if (typeof image !== 'string' || image.length > 250 || !new RegExp('^(docker\\.io/)?' + repos[c] + '(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$').test(image)) throw new Error('Use a versioned ' + repos[c] + ' image for ' + c);
    }
    if (action === 'deploy' && Object.keys(images).length) throw new Error('Recovery preserves the current images');
  } else if (components.length || Object.keys(images).length) throw new Error('Components apply only to upgrades and recovery');
  return { nodes: [...names].sort(), components: [...components].sort(), images };
}
export function createOperatorQueue(config) {
  const drafts = join(config.operationsDir, 'drafts'); mkdirSync(drafts, { recursive: true, mode: 0o700 });
  function create(path, value) {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(path.slice(0, path.lastIndexOf('/')), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  const list = (network) => readdirSync(config.operationsDir).filter((n) => uuid.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
    .map((n) => { try { return readJSON(join(config.operationsDir, n)); } catch { return null; } }).filter((r) => r?.network === network).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  function draft(n, id, user) {
    if (!uuid.test(id)) throw new Error('Invalid review ID');
    const d = readJSON(join(drafts, id + '.json'));
    if (d.network !== n.name || d.actor.id !== user.id) throw new Error('Review belongs to another operator or network');
    return d;
  }
  function prepare(n, action, selection, user) {
    const input = validateSelection(n, action, selection), id = randomUUID();
    const d = { id, network: n.name, action, selection: input, actor: { id: user.id, login: user.login }, status: 'preparing', createdAt: new Date().toISOString() };
    create(join(drafts, id + '.json'), d); return d;
  }
  function dispatch(n, action, expectedId, id, user, draftId) {
    if (!config.workflow?.enabled) throw new Error('Workflow execution is not enabled');
    if (!uuid.test(id)) throw new Error('Unique request ID required');
    const path = join(config.operationsDir, id + '.json');
    try {
      const old = readJSON(path);
      if (old.network !== n.name || old.actor.id !== user.id || old.action !== action || old.planId !== expectedId) throw new Error('Request ID belongs to another operation');
      return old;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const d = draft(n, draftId, user);
    if (d.status !== 'ready' || d.action !== action || d.review?.planId !== expectedId || !digest.test(expectedId)) throw new Error('Exact prepared plan required');
    if (!Number.isFinite(Date.parse(d.preparedAt)) || Date.parse(d.preparedAt) > Date.now() + 60_000 || Date.now() - Date.parse(d.preparedAt) > 30 * 60_000) throw new Error('Plan expired; prepare a fresh review');
    if (list(n.name).some((r) => active.has(r.status))) throw new Error('An operation is already active for this network');
    const r = { id, draftId, network: n.name, action, planId: expectedId, targets: d.review.targets, changes: d.review.changes,
      actor: { id: user.id, login: user.login }, status: 'queued', createdAt: new Date().toISOString() };
    create(path, r); return r;
  }
  function resume(n, action, oldId, id, user) {
    if (!config.workflow?.enabled || !uuid.test(id) || !uuid.test(oldId)) throw new Error('Invalid resume request');
    const old = readJSON(join(config.operationsDir, oldId + '.json'));
    if (old.network !== n.name || old.actor.id !== user.id || old.action !== action || old.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(old.conclusion)) throw new Error('Only a finished unsuccessful operation can be resumed');
    const path = join(config.operationsDir, id + '.json');
    try { const existing = readJSON(path); if (existing.resumeOf !== oldId || existing.actor.id !== user.id) throw new Error('Request ID already used'); return existing; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (list(n.name).some((r) => active.has(r.status))) throw new Error('An operation is already active for this network');
    // Exact retained artifact, not a fresh plan or implicit rollback.
    const d = draft(n, old.draftId, user);
    if (d.review?.planId !== old.planId || d.action !== action) throw new Error('Original reviewed plan unavailable');
    const record = { id, resumeOf: oldId, draftId: old.draftId, network: n.name, action, planId: old.planId, targets: old.targets, changes: old.changes, actor: old.actor, status: 'queued', createdAt: new Date().toISOString() };
    create(path, record); return record;
  }
  return { prepare, draft, dispatch, resume, list, reconcile: async (n) => list(n) };
}
