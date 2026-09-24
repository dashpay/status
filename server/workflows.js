import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from './networks.js';

const digest = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const repo = 'dashpay/dash-network-go';
const workflow = 'managed.yml';
const actions = new Set(['enroll', 'upgrade', 'deploy', 'doctor', 'import']);
function artifact(path) {
  try { return readJSON(path); }
  catch { throw new Error('Reviewed input is unavailable or invalid'); }
}

export function tokenProvider(env = process.env, fetcher = fetch) {
  let cached;
  return async () => {
    if (env.DASHNET_WORKFLOW_TOKEN) return env.DASHNET_WORKFLOW_TOKEN;
    if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY_FILE) throw new Error('Workflow credentials not configured');
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const part = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 30, exp: now + 300, iss: env.GITHUB_APP_ID })}`;
    const key = createPrivateKey(readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE));
    const jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    if (!/^\d+$/.test(env.GITHUB_INSTALLATION_ID)) throw new Error('Installation ID invalid');
    const response = await fetcher(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ repositories: ['dash-network-go'], permissions: { actions: 'write', contents: 'read' } }) });
    if (!response.ok) throw new Error('Installation authentication unavailable');
    const value = await response.json(); if (!value.token || !Number.isFinite(Date.parse(value.expires_at))) throw new Error('Installation token invalid');
    cached = { token: value.token, expires: Date.parse(value.expires_at) }; return cached.token;
  };
}

export function preview(n, action) {
  if (!actions.has(action)) throw new Error('Unsupported operation');
  if (['upgrade', 'deploy'].includes(action)) {
    if (!n.plan) throw new Error('No reviewed operation plan is available');
    const p = artifact(n.plan);
    if (p.kind !== 'ExistingOperation' || p.operation !== action || p.snapshot?.fleet?.metadata?.name !== n.name || !digest.test(p.id)) throw new Error('Operation plan scope does not match');
    const changes = [];
    for (const t of p.snapshot.fleet.targets) for (const [component, to] of Object.entries(p.images?.[t.name] || {})) {
      const before = p.snapshot.nodes[t.name]?.components?.[component];
      if (!before) throw new Error('Plan observation incomplete');
      changes.push({ node: t.name, component, from: before.image, to });
    }
    return { network: n.name, action, planId: p.id, scope: p.scope, targets: [...new Set(changes.map((c) => c.node))], changes,
      preservesCore: !changes.some((c) => c.component === 'core'), recovery: 'Forward-only recovery; no automatic reset or downgrade.' };
  }
  const s = artifact(n.snapshot);
  if (s.fleet?.metadata?.name !== n.name || !digest.test(s.id)) throw new Error('Snapshot scope does not match');
  if (action === 'enroll' && s.fleet.targets.some((t) => !s.nodes[t.name] || s.nodes[t.name].error || s.nodes[t.name].problems?.length)) throw new Error('Every target must be observed before enrollment');
  return { network: n.name, action, planId: ['enroll', 'doctor'].includes(action) ? s.id : null,
    targets: s.fleet.targets.map((t) => t.name), changes: [], preservesCore: true,
    recovery: action === 'enroll' ? 'Adds host recovery records; no container restarts.' : 'Read-only network observation.' };
}

export function createWorkflowService(config, { fetcher = fetch, getToken = tokenProvider(process.env, fetcher) } = {}) {
  mkdirSync(config.operationsDir, { recursive: true, mode: 0o700 });
  const save = (record) => { const dest = join(config.operationsDir, record.id + '.json'); const tmp = dest + '.tmp'; writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); renameSync(tmp, dest); };
  const load = (id) => readJSON(join(config.operationsDir, id + '.json'));
  const active = new Set();
  async function api(path, options = {}) {
    const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, { ...options, signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
    if (!response.ok) {
      const error = new Error(`GitHub request failed (${response.status})`);
      error.refused = [400, 401, 403, 404, 422, 429].includes(response.status); throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  function list(network) {
    return readdirSync(config.operationsDir).filter((n) => uuid.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
      .map((n) => { try { return readJSON(join(config.operationsDir, n)); } catch { return null; } })
      .filter((r) => r?.network === network).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
  async function dispatch(n, action, expectedId, id, user) {
    if (!config.workflow?.enabled) throw new Error('Workflow execution is not enabled');
    if (!uuid.test(id)) throw new Error('A unique request ID is required');
    const plan = preview(n, action);
    if (plan.planId !== (expectedId || null)) throw new Error('Plan changed; review it again');
    let previous; try { previous = load(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous) {
      if (previous.network !== n.name || previous.action !== action || previous.planId !== plan.planId || previous.actor.id !== user.id) throw new Error('Request ID already belongs to another operation');
      return previous;
    }
    if (active.has(n.name) || list(n.name).some((r) => ['dispatching', 'submitted', 'unknown', 'queued', 'in_progress'].includes(r.status))) throw new Error('Reconcile the active operation before starting another');
    active.add(n.name);
    const record = { id, network: n.name, action, planId: plan.planId, actor: { id: user.id, login: user.login }, status: 'dispatching', createdAt: new Date().toISOString() };
    // Exclusive durable intent precedes the external request. A lost response
    // never causes a second dispatch on retry or after a server restart.
    try { writeFileSync(join(config.operationsDir, id + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) { active.delete(n.name); throw error; }
    try {
      await api(`actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { network: n.name, operation: action,
        confirm: ['enroll', 'upgrade', 'deploy'].includes(action) ? plan.planId : '', request_id: id, observation_window: n.observationWindow || '4m' } }) });
      record.status = 'submitted';
    } catch (error) {
      record.status = error.refused ? 'rejected' : 'unknown';
      record.notice = error.refused ? 'GitHub rejected the dispatch. Check workflow publication, credentials and environment configuration.' :
        'Dispatch outcome unknown. Reconcile GitHub runs before retrying; this request will not be dispatched twice.';
    }
    finally { active.delete(n.name); }
    save(record); return record;
  }
  async function reconcile(network) {
    const records = list(network);
    if (!records.some((r) => !['completed'].includes(r.status))) return records;
    let runs; try { runs = (await api(`actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`)).workflow_runs; } catch { return records; }
    for (const record of records) {
      if (record.status === 'completed') continue;
      const matches = runs.filter((r) => r.display_title?.endsWith(record.id) && r.head_branch === 'main');
      if (matches.length !== 1) continue;
      const run = matches[0]; record.status = run.status; record.conclusion = run.conclusion; record.runId = run.id;
      record.runUrl = `https://github.com/${repo}/actions/runs/${run.id}`; delete record.notice; save(record);
    }
    return list(network);
  }
  return { dispatch, list, reconcile, newRequestId: randomUUID };
}
