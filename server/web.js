// Public board + operator console. Holds no cloud or SSH credentials: it reads
// agent state files, writes settings, and queues operation requests for the agent.
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { COMPONENTS, COMPONENT_REPOS, accessFor, adminFor, loadSettings, memberOf, operatorFor, readJSON, saveSettings, validateSettings, writeAtomic } from '../shared/settings.js';
import { evaluateNetwork, projectNetwork } from '../shared/evaluate.js';
import { validateRequest } from '../agent/ops.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createWeb({ dataDir, origin, auth: authDeps, fetcher = fetch, clock = Date.now } = {}) {
  const settingsPath = join(dataDir, 'settings.json');
  const dirs = { state: join(dataDir, 'state'), requests: join(dataDir, 'requests'), ops: join(dataDir, 'ops') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  let settings = loadSettings(settingsPath);
  const reloadSettings = () => { settings = loadSettings(settingsPath); return settings; };
  const app = express();
  const auth = createAuth({ origin }, authDeps);
  const clients = new Set();
  const cache = new Map();

  app.set('trust proxy', 'loopback');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:', 'https://avatars.githubusercontent.com'] } } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  auth.install(app);

  const user = (req) => auth.session(req)?.user || null;
  const isOperator = (req, network) => operatorFor(settings, user(req), network);
  const isMember = (req, network) => memberOf(settings, user(req), network);
  const isAdmin = (req) => adminFor(settings, user(req));
  const visible = (req) => settings.networks.filter((n) => n.public || isMember(req, n.name));
  const stateOf = (name) => readJSON(join(dirs.state, `${name}.json`));

  function view(network, operator) {
    const state = stateOf(network.name);
    const evaluation = evaluateNetwork(network, state, settings, clock(), readJSON(join(dirs.state, 'image-tags.json'), {}));
    return projectNetwork(network, evaluation, state, operator);
  }
  function brief(v) {
    const { hosts, ...rest } = v;
    return { ...rest, hostCount: hosts.length, roles: hosts.reduce((a, h) => { if (!h.duplicate) a[h.role] = (a[h.role] || 0) + 1; return a; }, {}),
      problems: hosts.filter((h) => !['ok', 'stopped'].includes(h.level) && !h.duplicate).map((h) => ({ name: h.name, role: h.role, level: h.level, reason: h.reasons.find((r) => r.level === h.level)?.text })) };
  }

  app.get('/api/health', (req, res) => res.json({ service: 'dash-status', status: 'ok' }));
  app.get('/api/me', (req, res) => {
    const u = user(req);
    res.json({ user: u, role: accessFor(settings, u)?.role || null, operatorOf: u ? settings.networks.filter((n) => isOperator(req, n.name)).map((n) => n.name) : [],
      memberOf: u ? settings.networks.filter((n) => isMember(req, n.name)).map((n) => n.name) : [], admin: isAdmin(req) });
  });
  app.get('/api/overview', (req, res) => {
    reloadSettings();
    res.json({ networks: visible(req).map((n) => brief(view(n, isMember(req, n.name)))), at: new Date(clock()).toISOString() });
  });
  app.get('/api/networks/:name', (req, res) => {
    const n = visible(req).find((x) => x.name === req.params.name);
    if (!n) return res.status(404).json({ error: 'Network not found' });
    res.json(view(n, isMember(req, n.name)));
  });

  // Live updates: agent state rewrites and operation changes are pushed.
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const client = { res, req, user: user(req) };
    clients.add(client);
    res.write(`retry: 3000\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); });
  });
  const push = (event, payload, filter = () => true) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) if (filter(c)) c.res.write(data);
  };
  const debounce = new Map();
  function onStateFile(file) {
    const name = file.replace(/\.json$/, '');
    clearTimeout(debounce.get(name));
    debounce.set(name, setTimeout(() => {
      reloadSettings();
      const n = settings.networks.find((x) => x.name === name);
      if (!n) return;
      push('network', { name, at: new Date(clock()).toISOString() }, (c) => n.public || memberOf(settings, c.user, name));
    }, 300));
  }
  function onOpFile(file) {
    const id = file.replace(/\.(json|log)$/, '');
    if (!UUID.test(id)) return;
    clearTimeout(debounce.get(id));
    debounce.set(id, setTimeout(() => {
      const r = readJSON(join(dirs.ops, `${id}.json`));
      if (r) push('op', { id, network: r.network, status: r.status, updatedAt: r.updatedAt }, (c) => memberOf(settings, c.user, r.network));
    }, 250));
  }
  const watchers = [];
  for (const [dir, fn] of [[dirs.state, onStateFile], [dirs.ops, onOpFile]]) {
    try { watchers.push(watch(dir, (_, f) => f && !f.endsWith('.tmp') && fn(f))); } catch { /* directory created by the agent later */ }
  }

  // Operator API.
  const requireAccess = (check, message) => (req, res, next) => {
    const s = auth.session(req);
    if (!s) return res.status(401).json({ error: 'Sign in required' });
    req.session = s;
    const network = req.params.name || readJSON(join(dirs.ops, `${req.params.id}.json`))?.network;
    if (!network || !check(settings, s.user, network)) return res.status(403).json({ error: message });
    req.network = network;
    next();
  };
  const requireMember = requireAccess(memberOf, 'Access to this network required');
  const requireOperator = requireAccess(operatorFor, 'Operator access required');
  const listOps = (network) => (existsSync(dirs.ops) ? readdirSync(dirs.ops) : []).filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(join(dirs.ops, f))).filter((r) => r && (!network || r.network === network))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const request = (payload) => writeAtomic(join(dirs.requests, `${payload.id}${payload.type === 'create' ? '' : '.' + payload.type + '-' + randomUUID().slice(0, 8)}.json`), JSON.stringify(payload));

  app.get('/api/networks/:name/ops', requireMember, (req, res) => res.json({ ops: listOps(req.params.name).slice(0, 100) }));
  const registry = () => readJSON(join(dataDir, 'devnets.json'), {});
  app.post('/api/networks/:name/ops', requireOperator, auth.csrf, (req, res) => {
    const n = settings.networks.find((x) => x.name === req.params.name);
    if (!n) return res.status(404).json({ error: 'Network not found' });
    const body = req.body || {};
    if (body.action === 'delete-devnet' && !isAdmin(req)) return res.status(403).json({ error: 'Only admins delete devnets' });
    const q = { id: randomUUID(), network: n.name, action: body.action, nodes: body.nodes || [], components: body.components || [], images: body.images || {}, options: body.options || {}, ...(body.confirmName ? { confirmName: body.confirmName } : {}) };
    try { validateRequest(settings, q, registry()); } catch (e) { return res.status(400).json({ error: e.message }); }
    const busy = listOps(n.name).find((r) => ['queued', 'preparing', 'confirmed', 'running'].includes(r.status));
    if (busy) return res.status(409).json({ error: `operation ${busy.id.slice(0, 8)} (${busy.request.action}) is ${busy.status} on this network`, id: busy.id });
    request({ type: 'create', ...q, actor: req.session.user });
    res.status(202).json({ id: q.id });
  });
  // New devnets (admins; billable). The agent prepares a plan that must be confirmed.
  app.get('/api/devnets/defaults', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins create devnets' });
    res.json({ defaults: reloadSettings().devnets, existing: [...settings.networks.map((n) => n.name), ...Object.keys(registry())] });
  });
  app.post('/api/devnets', (req, res, next) => { const s = auth.session(req); if (!s) return res.status(401).json({ error: 'Sign in required' }); req.session = s; next(); }, auth.csrf, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins create devnets' });
    const body = req.body || {};
    const q = { id: randomUUID(), network: body.name, action: 'create-devnet', nodes: [], devnet: body.devnet || {} };
    try { validateRequest(reloadSettings(), q, registry()); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (listOps(q.network).some((r) => !['failed', 'cancelled', 'rejected', 'succeeded'].includes(r.status))) return res.status(409).json({ error: 'an operation for this name is already active' });
    request({ type: 'create', ...q, actor: req.session.user });
    res.status(202).json({ id: q.id, network: q.network });
  });

  app.get('/api/ops/:id', requireMember, (req, res) => {
    const r = readJSON(join(dirs.ops, `${req.params.id}.json`));
    if (!r) return res.status(404).json({ error: 'Operation not found' });
    res.json({ ...r, log: tail(join(dirs.ops, `${req.params.id}.log`), 256 * 1024) });
  });
  app.get('/api/ops/:id/log', requireMember, (req, res) => {
    const path = join(dirs.ops, `${req.params.id}.log`);
    let offset = Number(req.query.offset) || 0;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = () => {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size <= offset) return;
      const fd = openSync(path, 'r'), buf = Buffer.alloc(Math.min(size - offset, 1 << 20));
      readSync(fd, buf, 0, buf.length, offset); closeSync(fd);
      offset += buf.length;
      res.write(`event: log\ndata: ${JSON.stringify({ text: buf.toString(), offset })}\n\n`);
    };
    send();
    const timer = setInterval(send, 1000);
    req.on('close', () => clearInterval(timer));
  });
  for (const type of ['confirm', 'cancel', 'resume']) {
    app.post(`/api/ops/:id/${type}`, requireOperator, auth.csrf, (req, res) => {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
      const r = readJSON(join(dirs.ops, `${req.params.id}.json`));
      if (type === 'confirm' && (r?.status !== 'review' || req.body?.planId !== r.review?.planId)) return res.status(409).json({ error: 'The plan changed or is not awaiting review' });
      request({ type, id: req.params.id, network: req.network, planId: req.body?.planId, actor: req.session.user });
      res.status(202).json({ ok: true });
    });
  }

  // Settings (admins edit everything; any operator may read).
  app.get('/api/settings', (req, res) => {
    if (!memberOf(settings, user(req))) return res.status(403).json({ error: 'Sign in with an account that has access' });
    res.json({ settings: reloadSettings(), admin: isAdmin(req) });
  });
  app.put('/api/settings', (req, res, next) => { const s = auth.session(req); if (!s) return res.status(401).json({ error: 'Sign in required' }); req.session = s; next(); }, auth.csrf, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can change settings' });
    try {
      const next = validateSettings(req.body?.settings);
      if (!next.operators.some((o) => o.id === req.session.user.id && o.role === 'admin')) throw new Error('You cannot remove your own admin access');
      settings = saveSettings(settingsPath, next);
      push('settings', { at: new Date(clock()).toISOString() });
      res.json({ settings });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // GitHub account lookup so admins can grant access by login.
  app.get('/api/github/users/:login', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can add users' });
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(req.params.login)) return res.status(400).json({ error: 'Not a valid GitHub login' });
    try {
      const r = await fetcher(`https://api.github.com/users/${req.params.login}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dash-status' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) return res.status(404).json({ error: `GitHub user ${req.params.login} not found` });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const u = await r.json();
      if (!Number.isSafeInteger(u.id) || typeof u.login !== 'string') throw new Error('Unexpected GitHub response');
      res.json({ id: u.id, login: u.login, name: u.name || null, type: u.type, avatar: u.avatar_url });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Image tags from Docker Hub for the upgrade form.
  app.get('/api/images/:component/tags', async (req, res) => {
    if (!operatorFor(settings, user(req))) return res.status(403).json({ error: 'Operator access required' });
    const repo = COMPONENT_REPOS[req.params.component];
    if (!repo || !COMPONENTS.includes(req.params.component)) return res.status(404).json({ error: 'Unknown component' });
    const hit = cache.get(repo);
    if (hit && clock() - hit.at < 10 * 60_000) return res.json(hit.value);
    try {
      const r = await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Docker Hub ${r.status}`);
      const body = await r.json();
      const value = { repo, tags: (body.results || []).map((t) => ({ name: t.name, updated: t.last_updated, digest: t.digest || null, arches: (t.images || []).map((i) => i.architecture).filter((a) => a && a !== 'unknown') })) };
      cache.set(repo, { at: clock(), value });
      res.json(value);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); } }));
    app.get('/{*path}', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status(error.status === 400 ? 400 : 500).json({ error: 'Request could not be processed' }); });
  app.close = () => { for (const w of watchers) w.close(); for (const c of clients) c.res.end(); };
  return app;
}

function tail(path, bytes) {
  try {
    const size = statSync(path).size;
    if (size <= bytes) return { text: readFileSync(path, 'utf8'), offset: size, truncated: false };
    const fd = openSync(path, 'r'), buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes); closeSync(fd);
    return { text: buf.toString().replace(/^[^\n]*\n/, ''), offset: size, truncated: true };
  } catch { return { text: '', offset: 0, truncated: false }; }
}

export function startWeb() {
  const dataDir = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
  const origin = process.env.PUBLIC_ORIGIN || 'https://status.testnet.networks.dash.org';
  const app = createWeb({ dataDir, origin });
  const server = app.listen(Number(process.env.PORT) || 3001, process.env.BIND_ADDRESS || '127.0.0.1', () => console.log(`dash-status web on ${process.env.PORT || 3001}`));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { app.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
  return server;
}
