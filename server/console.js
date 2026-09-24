import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { createWorkflowService, preview } from './workflows.js';
import { loadRegistry, canView, grants, networkView } from './networks.js';

export function createConsole(config, dependencies = {}) {
  const app = express(), auth = createAuth(config, dependencies.auth), workflows = createWorkflowService(config, dependencies.workflows);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  auth.install(app);
  app.get('/api/networks', (req, res) => {
    const user = auth.session(req)?.user;
    res.json({ networks: config.networks.filter((n) => canView(config, user, n)).map((n) => networkView(n, user, config)), executionEnabled: !!config.workflow?.enabled });
  });
  function target(req, res, next) {
    const n = config.networks.find((n) => n.name === req.params.name), user = auth.session(req)?.user;
    if (!n || !canView(config, user, n)) return res.status(404).json({ error: 'Network not found' });
    req.network = n; next();
  }
  function permitted(req, res, next) {
    if (!grants(config, req.session.user, req.network.name).includes(req.body.action)) return res.status(403).json({ error: 'This operation is not permitted for this network' });
    next();
  }
  app.get('/api/networks/:name', target, (req, res) => res.json(networkView(req.network, auth.session(req)?.user, config)));
  app.get('/api/networks/:name/operations', auth.requireUser, target, async (req, res) => {
    if (!grants(config, req.session.user, req.network.name).length) return res.status(403).json({ error: 'Operator access required' });
    res.json({ operations: await workflows.reconcile(req.network.name) });
  });
  app.post('/api/networks/:name/preview', auth.requireUser, auth.csrf, target, permitted, (req, res) => {
    try { res.json({ ...preview(req.network, req.body.action), executionEnabled: !!config.workflow?.enabled }); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  app.post('/api/networks/:name/operations', auth.requireUser, auth.csrf, target, permitted, async (req, res) => {
    try { res.status(202).json(await workflows.dispatch(req.network, req.body.action, req.body.planId, req.body.requestId, req.session.user)); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  app.get('/api/health', (req, res) => res.json({ service: 'dash-network-console', status: 'ok' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(dist)) { app.use(express.static(dist)); app.get('/{*path}', (req, res) => res.sendFile(dist + '/index.html')); }
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status(error.status === 400 ? 400 : 500).json({ error: 'Request could not be processed' }); });
  return app;
}
export function startConsole(path) {
  const app = createConsole(loadRegistry(path));
  return app.listen(process.env.PORT || 3001, process.env.BIND_ADDRESS || '127.0.0.1', () => console.log('Multi-network console listening; public and operator projections are separate.'));
}
