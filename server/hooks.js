// Wake hooks: a signed delivery from outside wakes a listener that cannot be
// reached from outside. This host is public; the machines that do the work are
// not. A sender (GitHub) posts to /api/hooks/<name>; a listener holds a request
// to /api/hooks/<name>/wait open from its side and is answered when one arrives.
//
// A wake carries no instruction and no data: the payload is read only to check
// its signature and is never parsed, stored or forwarded. A listener learns that
// something happened, and looks for itself. So the worst a forged, replayed or
// spurious delivery can do is one extra look.
//
// Not the incident pipeline: nothing here is queued, retried or acted on.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

export const HOOK_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const EVENT = /^[a-z_]{1,40}$/;
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;
const SIGNATURE = /^sha256=[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// nginx on the status host caps a request body at 1 MB already; this is the
// limit when something else is in front. A larger delivery wakes nobody, which
// is why a listener keeps a slow timer of its own.
export const MAX_BODY = 5 * 1024 * 1024;
const WAIT_MS = 50_000;
const MAX_WAITERS = 8;

const reply = (status, body) => ({ status, body });
const sha256 = (text) => createHash('sha256').update(text).digest();

// hooks.json in `dir`:
//   { "schemaVersion": 1, "hooks": { "<name>": {
//       "source": "github",
//       "events": ["pull_request", "push"],            // optional: every event wakes when absent
//       "listeners": { "<listener id>": "<sha256 of its token, hex>" } } } }
// and beside it <name>.secret, the secret the sender signs with. Listener tokens
// are stored as digests: this host can check one and cannot use one.
export function parseHooks(doc) {
  if (doc?.schemaVersion !== 1 || !doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) throw new Error('hooks.json: schemaVersion 1 and a hooks object are required');
  const out = new Map();
  for (const [name, h] of Object.entries(doc.hooks)) {
    if (!HOOK_NAME.test(name)) throw new Error(`hooks.json: invalid hook name ${JSON.stringify(name).slice(0, 60)}`);
    if (h?.source !== 'github') throw new Error(`hooks.json: ${name}: source must be "github"`);
    if (h.events !== undefined && (!Array.isArray(h.events) || !h.events.length || !h.events.every((e) => typeof e === 'string' && EVENT.test(e)))) throw new Error(`hooks.json: ${name}: events must be a list of event names`);
    const listeners = h.listeners && typeof h.listeners === 'object' && !Array.isArray(h.listeners) ? Object.entries(h.listeners) : null;
    if (!listeners || !listeners.every(([id, digest]) => HOOK_NAME.test(id) && typeof digest === 'string' && DIGEST.test(digest))) throw new Error(`hooks.json: ${name}: listeners must map an id to the sha256 of its token`);
    out.set(name, { events: h.events ? new Set(h.events) : null, listeners: listeners.map(([id, digest]) => ({ id, digest: Buffer.from(digest, 'hex') })) });
  }
  return out;
}

export function createHooks({ dir = process.env.WAKE_HOOKS_DIR, dataDir, clock = Date.now, waitMs = WAIT_MS, log = (entry) => console.info(JSON.stringify(entry)) } = {}) {
  const iso = () => new Date(clock()).toISOString();
  // Read again whenever the file changes, so a hook is added without a restart.
  // A file that does not parse configures nothing: every route then answers as
  // if no hook existed, and the fault is logged once per version of the file.
  let cache = { key: null, hooks: new Map() };
  const configured = () => {
    if (!dir) return cache.hooks;
    const file = join(dir, 'hooks.json');
    let key;
    try { const st = statSync(file); key = `${st.mtimeMs}|${st.size}|${st.ino}`; } catch { key = 'absent'; }
    if (key === cache.key) return cache.hooks;
    let hooks = new Map();
    if (key !== 'absent') {
      try { hooks = parseHooks(JSON.parse(readFileSync(file, 'utf8'))); }
      catch (e) { log({ event: 'hooks-config-invalid', error: String(e.message).slice(0, 200), at: iso() }); }
    }
    cache = { key, hooks };
    return hooks;
  };
  const secretOf = (name) => {
    try { const s = readFileSync(join(dir, `${name}.secret`), 'utf8').trim(); return s.length >= 16 ? s : null; } catch { return null; }
  };

  // seq counts wakes. It is kept on disk so that a listener that was away over
  // a restart of this process still sees that it missed one. A listener compares
  // for "different", not "greater": a lost file starts the count again.
  const states = new Map();
  const waiters = new Map();
  const stateOf = (name) => {
    if (!states.has(name)) {
      const s = readJSON(join(dataDir, 'hooks', `${name}.json`));
      states.set(name, Number.isSafeInteger(s?.seq) && s.seq >= 0 ? { seq: s.seq, at: typeof s.at === 'string' ? s.at : null, event: typeof s.event === 'string' && EVENT.test(s.event) ? s.event : null } : { seq: 0, at: null, event: null });
    }
    return states.get(name);
  };
  const wake = (name, event, delivery) => {
    const state = { seq: stateOf(name).seq + 1, at: iso(), event };
    states.set(name, state);
    // A wake that cannot be recorded still wakes: the listener is what matters.
    try { writeAtomic(join(dataDir, 'hooks', `${name}.json`), JSON.stringify(state)); }
    catch (e) { log({ event: 'hook-state-not-saved', hook: name, error: String(e.message).slice(0, 200), at: state.at }); }
    const waiting = [...(waiters.get(name) || [])];
    for (const w of waiting) w.done();
    log({ event: 'hook-wake', hook: name, source: event, delivery, seq: state.seq, listenersWaiting: waiting.length, at: state.at });
    return state;
  };

  // A delivery. `body` is the request stream: it is hashed as it arrives and
  // never held. Everything is decided from the headers and the signature.
  async function receive(name, { signature, event, delivery } = {}, body) {
    const hook = HOOK_NAME.test(name || '') ? configured().get(name) : null;
    const secret = hook && secretOf(name);
    if (!secret) return reply(404, { error: 'Unknown hook' });
    if (!SIGNATURE.test(signature || '')) return reply(401, { error: 'Invalid signature' });
    if (!EVENT.test(event || '') || !DELIVERY.test(delivery || '')) return reply(400, { error: 'Invalid delivery headers' });
    const mac = createHmac('sha256', secret);
    let size = 0;
    try { for await (const chunk of body) { size += chunk.length; if (size <= MAX_BODY) mac.update(chunk); } }
    catch { return reply(400, { error: 'Delivery was not read' }); }
    if (size > MAX_BODY) return reply(413, { error: 'Delivery too large' });
    if (!timingSafeEqual(Buffer.from(`sha256=${mac.digest('hex')}`), Buffer.from(signature))) return reply(401, { error: 'Invalid signature' });
    // GitHub's own test delivery when a webhook is created.
    if (event === 'ping') return reply(200, { accepted: true, ping: true });
    if (hook.events && !hook.events.has(event)) return reply(202, { accepted: true, ignored: true });
    return reply(202, { accepted: true, seq: wake(name, event, delivery).seq });
  }

  const listenerOf = (hook, authorization) => {
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization || '')?.[1];
    if (!hook || !token) return null;
    const digest = sha256(token);
    // No early exit: every listener is compared.
    let found = null;
    for (const l of hook.listeners) if (timingSafeEqual(l.digest, digest)) found = l.id;
    return found;
  };

  // A listener's request. Answered at once when the count differs from the one
  // it has (or it has none); otherwise held until a wake or `waitMs`, whichever
  // is first, and then answered with the count as it is. `closed` resolves when
  // the listener goes away. An unknown hook and a wrong token are one answer:
  // hook names are not public.
  async function wait(name, authorization, after, closed = new Promise(() => {})) {
    const hook = HOOK_NAME.test(name || '') ? configured().get(name) : null;
    const listener = listenerOf(hook, authorization);
    if (!listener) return reply(401, { error: 'Listener authorization required' });
    if (after !== undefined && !/^(0|[1-9]\d{0,15})$/.test(after)) return reply(400, { error: 'after must be a count this endpoint returned' });
    if (after !== undefined && stateOf(name).seq === Number(after)) {
      const set = waiters.get(name) || waiters.set(name, new Set()).get(name);
      if (set.size >= MAX_WAITERS) return reply(429, { error: 'Too many listeners are waiting on this hook' });
      let timer;
      const waiter = {};
      await Promise.race([
        new Promise((resolve) => { waiter.done = resolve; set.add(waiter); }),
        new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
        closed,
      ]);
      clearTimeout(timer);
      set.delete(waiter);
    }
    return reply(200, { hook: name, listener, ...stateOf(name) });
  }

  // For the operators' own view: what exists and when it last woke anyone.
  const list = () => [...configured()].map(([name, hook]) => ({ name, events: hook.events ? [...hook.events].sort() : null,
    listeners: hook.listeners.map((l) => l.id), listenersWaiting: waiters.get(name)?.size || 0, signed: !!secretOf(name), ...stateOf(name) }));
  const close = () => { for (const set of waiters.values()) for (const w of [...set]) w.done(); };

  return { receive, wait, list, close };
}
