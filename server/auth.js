import { randomBytes, timingSafeEqual } from 'node:crypto';
const nonce = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')));

export function createAuth(config, { clientId = process.env.GITHUB_OAUTH_CLIENT_ID, clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET, fetcher = fetch, clock = Date.now } = {}) {
  const sessions = new Map(), states = new Map();
  const secure = config.origin.startsWith('https:');
  const options = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
  const sessionName = secure ? '__Host-dash-session' : 'dash-session';
  const stateName = secure ? '__Host-dash-login' : 'dash-login';
  const prune = () => { for (const map of [sessions, states]) for (const [key, value] of map) if (value.expires <= clock()) map.delete(key); };
  function session(req) { prune(); return sessions.get(cookies(req)[sessionName]) || null; }
  function requireUser(req, res, next) {
    const s = session(req);
    if (!s) return res.status(401).json({ error: 'Sign in required' });
    req.session = s; next();
  }
  function csrf(req, res, next) {
    if (req.headers.origin !== config.origin || !equal(req.headers['x-csrf-token'], req.session?.csrf)) return res.status(403).json({ error: 'Request verification failed' });
    next();
  }
  function install(app) {
    app.get('/api/session', (req, res) => {
      const s = session(req); res.set('Cache-Control', 'no-store').json({ user: s?.user || null, csrf: s?.csrf || null, loginAvailable: !!(clientId && clientSecret) });
    });
    app.get('/api/auth/github', (req, res) => {
      prune();
      if (!clientId || !clientSecret) return res.status(503).json({ error: 'GitHub sign-in is not configured' });
      if (states.size >= 1000) return res.status(429).json({ error: 'Try again shortly' });
      const state = nonce(), binding = nonce();
      states.set(state, { binding, expires: clock() + 10 * 60_000 });
      res.cookie(stateName, binding, { ...options, maxAge: 10 * 60_000 });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: config.origin + '/api/auth/callback', scope: 'read:user', state }).toString();
      res.redirect(url.href);
    });
    app.get('/api/auth/callback', async (req, res) => {
      prune(); const saved = states.get(req.query.state); states.delete(req.query.state);
      res.clearCookie(stateName, options);
      if (!saved || !equal(saved.binding, cookies(req)[stateName]) || typeof req.query.code !== 'string' || req.query.code.length > 1024) return res.status(400).json({ error: 'Login expired or invalid' });
      try {
        const exchange = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: req.query.code, redirect_uri: config.origin + '/api/auth/callback' }) });
        if (!exchange.ok) throw new Error('OAuth exchange');
        const token = await exchange.json(); if (!token.access_token) throw new Error('No token');
        const response = await fetcher('https://api.github.com/user', { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error('Identity unavailable');
        const u = await response.json(); if (!Number.isSafeInteger(u.id) || typeof u.login !== 'string') throw new Error('Identity invalid');
        if (sessions.size >= 5000) throw new Error('Session capacity');
        const id = nonce(); sessions.set(id, { user: { id: u.id, login: u.login }, csrf: nonce(), expires: clock() + 8 * 60 * 60_000 });
        res.cookie(sessionName, id, { ...options, maxAge: 8 * 60 * 60_000 });
        res.redirect('/');
      } catch { res.status(502).json({ error: 'GitHub sign-in failed; retry from the sign-in button' }); }
    });
    app.post('/api/auth/logout', requireUser, csrf, (req, res) => { sessions.delete(cookies(req)[sessionName]); res.clearCookie(sessionName, options); res.json({ ok: true }); });
  }
  return { install, session, requireUser, csrf };
}
