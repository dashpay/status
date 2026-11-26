// Wake hooks: a signed delivery from outside wakes a listener that cannot be
// reached from outside. This host is public; the machines that do the work are
// not. A sender (GitHub) posts to /api/hooks/<name>; a listener holds a request
// to /api/hooks/<name>/wait open from its side and is answered when one arrives.
//
// A wake carries no instruction and no data: nothing of a delivery is stored or
// forwarded. A listener learns that something happened, and looks for itself.
// So the worst a forged, replayed or spurious delivery can do is one extra look.
// The payload is read to check its signature. It is parsed only for a hook that
// has `match` rules, only after the sender is authenticated, and only to decide
// whether this delivery wakes anyone.
//
// Two kinds of sender. GitHub signs the body (HMAC-SHA256, X-Hub-Signature-256).
// XenForo cannot sign: it sends the configured secret itself in XF-Webhook-Secret
// on every delivery, so that secret is only as private as the TLS connection and
// XenForo's own database. Good enough for a wake; it would not be for a command.
//
// Not the incident pipeline: nothing here is queued, retried or acted on.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

export const HOOK_NAME = /^[a-z][a-z0-9-]{0,39}$/;
// GitHub: "pull_request". XenForo: content type and action, "user.insert".
const EVENT = /^[a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})?$/;
// A field longer than this, or the elements of a list past this many, are not
// tested: a rule matches short names and labels, and what it is tested against
// was written by outsiders.
const MATCH_VALUE = 256, MATCH_LIST = 200;
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;
const SOURCES = ['github', 'xenforo', 'console'];
const MATCH_PATH = /^[A-Za-z0-9_]{1,60}(?:\.[A-Za-z0-9_]{1,60}){0,5}$/;
const SIGNATURE = /^sha256=[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// nginx on the status host caps a request body at 1 MB already; this is the
// limit when something else is in front. A larger delivery wakes nobody, which
// is why a listener keeps a slow timer of its own.
export const MAX_BODY = 5 * 1024 * 1024;
const WAIT_MS = 50_000;
// One listener holds one request. A few more are allowed for a restart that
// overlaps the old request; a listener that loops cannot take another's place.
export const MAX_WAITS_PER_LISTENER = 4;
// What a name that is not a hook is checked against, so that it costs and
// answers the same as one that is: hook names are not public.
const NO_SECRET = randomBytes(32), NO_LISTENERS = [{ id: null, digest: randomBytes(32) }];

const reply = (status, body) => ({ status, body });
const sha256 = (text) => createHash('sha256').update(text).digest();

// hooks.json in `dir`:
//   { "schemaVersion": 1, "hooks": { "<name>": {
//       "source": "github",                             // or "xenforo"
//       "events": ["pull_request", "push"],            // optional: every event wakes when absent
//       "match": [ { "path": "workflow_job.labels",    // optional: wake only when a rule matches
//                    "pattern": "^release-",
//                    "event": "workflow_job" } ],       //   a rule's own event is optional
//       "listeners": { "<listener id>": "<sha256 of its token, hex>" } } } }
// and beside it <name>.secret, the sender's secret. Listener tokens are stored
// as digests: this host can check one and cannot use one.
//
// A hook with source "console" has no sender outside: the console itself wakes
// it (`fire`), for work that follows what the console sees. It has listeners
// and nothing else: no secret file, no events, no rules, and a delivery posted
// to its name is refused like one to a name that is not a hook.
//
// A `match` rule names one field of the JSON payload by a dotted path and a
// regular expression. It matches when the field is a string or number that the
// expression matches, or a list with such an element. Any one rule is enough.
export function parseHooks(doc) {
  if (doc?.schemaVersion !== 1 || !doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) throw new Error('hooks.json: schemaVersion 1 and a hooks object are required');
  const out = new Map();
  for (const [name, h] of Object.entries(doc.hooks)) {
    if (!HOOK_NAME.test(name)) throw new Error(`hooks.json: invalid hook name ${JSON.stringify(name).slice(0, 60)}`);
    if (!SOURCES.includes(h?.source)) throw new Error(`hooks.json: ${name}: source must be one of ${SOURCES.join(', ')}`);
    // A misspelt key would be a rule or a filter that silently does not apply.
    const unknown = (object, known) => Object.keys(object).find((key) => !known.includes(key));
    if (unknown(h, ['source', 'events', 'match', 'listeners'])) throw new Error(`hooks.json: ${name}: unknown key ${JSON.stringify(unknown(h, ['source', 'events', 'match', 'listeners'])).slice(0, 60)}`);
    // GitHub names an event in one word; XenForo's are content type and action.
    const event = (e) => typeof e === 'string' && EVENT.test(e) && e.includes('.') === (h.source === 'xenforo');
    if (h.source === 'console' && (h.events !== undefined || h.match !== undefined)) throw new Error(`hooks.json: ${name}: a console hook has listeners only`);
    if (h.events !== undefined && (!Array.isArray(h.events) || !h.events.length || !h.events.every(event))) throw new Error(`hooks.json: ${name}: events must be a list of this sender's event names`);
    if (h.match !== undefined && (!Array.isArray(h.match) || !h.match.length || h.match.length > 16)) throw new Error(`hooks.json: ${name}: match must be a list of one to sixteen rules`);
    const match = h.match?.map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || unknown(rule, ['path', 'pattern', 'event'])
          || typeof rule.path !== 'string' || !MATCH_PATH.test(rule.path) || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 200
          || (rule.event !== undefined && (!event(rule.event) || (h.events && !h.events.includes(rule.event))))) throw new Error(`hooks.json: ${name}: a match rule is a dotted path, a pattern and optionally one of the hook's events`);
      try { return { path: rule.path.split('.'), pattern: new RegExp(rule.pattern), event: rule.event ?? null }; }
      catch { throw new Error(`hooks.json: ${name}: the pattern for ${rule.path} is not a regular expression`); }
    }) ?? null;
    const listeners = h.listeners && typeof h.listeners === 'object' && !Array.isArray(h.listeners) ? Object.entries(h.listeners) : null;
    if (!listeners || !listeners.every(([id, digest]) => HOOK_NAME.test(id) && typeof digest === 'string' && DIGEST.test(digest))) throw new Error(`hooks.json: ${name}: listeners must map an id to the sha256 of its token`);
    out.set(name, { source: h.source, events: h.events ? new Set(h.events) : null, match, listeners: listeners.map(([id, digest]) => ({ id, digest: Buffer.from(digest, 'hex') })) });
  }
  return out;
}

// Does any rule of the hook match this payload? Own properties only, so a path
// cannot reach into prototypes.
export function matches(rules, event, payload) {
  return rules.some((rule) => {
    if (rule.event && rule.event !== event) return false;
    let value = payload;
    for (const key of rule.path) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
      value = value[key];
    }
    // A value that is too long is no match; cutting it could make it one.
    return (Array.isArray(value) ? value.slice(0, MATCH_LIST) : [value]).some((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= MATCH_VALUE && rule.pattern.test(String(v)));
  });
}

// A listener asks again at least every 50 seconds. One that has not asked for
// this long is away, and deliveries to its hook wake nobody.
export const LISTENER_AWAY_MS = 120_000;
// A refused delivery is worth showing for a day; after that it is old news.
const REFUSAL_SHOWN_MS = 24 * 3600_000;

export function createHooks({ dir = process.env.WAKE_HOOKS_DIR, dataDir, clock = Date.now, waitMs = WAIT_MS, log = (entry) => console.info(JSON.stringify(entry)), onChange = () => {} } = {}) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const startedAt = clock();
  // What happened since this process started, for the status page. Kept in
  // memory, and only for hooks in the configuration: a guessed name counts nothing.
  const tallies = new Map(), seen = new Map();
  const tally = (name) => tallies.get(name) || tallies.set(name, { woke: 0, ignored: 0, refused: 0, last: null, lastDeliveryAt: null, lastRefusedAt: null }).get(name);
  const delivered = (name, outcome) => {
    const t = tally(name);
    t[outcome] += 1;
    t.last = outcome;
    t[outcome === 'refused' ? 'lastRefusedAt' : 'lastDeliveryAt'] = clock();
  };
  // Read again whenever the file changes, so a hook is added without a restart.
  // A file that does not parse configures nothing: every route then answers as
  // if no hook existed, and the fault is logged once per version of the file.
  let cache = { key: null, hooks: new Map(), invalid: false };
  const configured = () => {
    if (!dir) return cache.hooks;
    const file = join(dir, 'hooks.json');
    let key;
    try { const st = statSync(file); key = `${st.mtimeMs}|${st.size}|${st.ino}`; } catch { key = 'absent'; }
    if (key === cache.key) return cache.hooks;
    let hooks = new Map(), invalid = false;
    if (key !== 'absent') {
      try { hooks = parseHooks(JSON.parse(readFileSync(file, 'utf8'))); }
      catch (e) { invalid = true; log({ event: 'hooks-config-invalid', error: String(e.message).slice(0, 200), at: iso() }); }
    }
    cache = { key, hooks, invalid };
    return hooks;
  };
  const secretOf = (name) => {
    // 16 to 200 printable ASCII characters: what a header can carry unchanged.
    try { const s = readFileSync(join(dir, `${name}.secret`), 'utf8').trim(); return /^[\x21-\x7e]{16,200}$/.test(s) ? s : null; } catch { return null; }
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
  // `quiet`: the console's own wake. It tells no open page that a count moved,
  // since the public answer does not hold it.
  const wake = (name, event, delivery, quiet = false) => {
    const state = { seq: stateOf(name).seq + 1, at: iso(), event };
    states.set(name, state);
    // A wake that cannot be recorded still wakes: the listener is what matters.
    try { writeAtomic(join(dataDir, 'hooks', `${name}.json`), JSON.stringify(state)); }
    catch (e) { log({ event: 'hook-state-not-saved', hook: name, error: String(e.message).slice(0, 200), at: state.at }); }
    const waiting = [...(waiters.get(name) || [])];
    for (const w of waiting) w.done();
    log({ event: 'hook-wake', hook: name, on: event, delivery, seq: state.seq, listenersWaiting: waiting.length, at: state.at });
    if (!quiet) onChange(name);
    return state;
  };

  // Faults of a configured hook, said at most once a minute each. Only ever for
  // names in the configuration, so a caller cannot fill the log by guessing.
  const noted = new Map();
  const note = (name, event) => {
    const key = `${name}|${event}`;
    if (clock() - (noted.get(key) ?? -Infinity) < 60_000) return;
    noted.set(key, clock());
    log({ event, hook: name, at: iso() });
  };

  // A delivery. `headers` are the request's, lower-cased as Node gives them;
  // `body` is the request stream, hashed as it arrives and held only for a hook
  // with `match` rules. A name that is not a hook is taken through the same
  // steps as one that is and gets the answer of a wrong signature.
  async function receive(name, headers, body) {
    const header = (key) => (typeof headers?.[key] === 'string' ? headers[key] : '');
    // What the caller presents: GitHub's signature of the body, or XenForo's secret itself.
    const signature = SIGNATURE.test(header('x-hub-signature-256')) ? header('x-hub-signature-256') : null;
    const shown = header('xf-webhook-secret').length >= 16 && header('xf-webhook-secret').length <= 200 ? header('xf-webhook-secret') : null;
    if (!signature && !shown) return reply(401, { error: 'Invalid signature' });
    if (/^\d+$/.test(header('content-length')) && Number(header('content-length')) > MAX_BODY) return reply(413, { error: 'Delivery too large' });
    const hook = HOOK_NAME.test(name || '') ? configured().get(name) : null;
    // Nothing from outside is a delivery to a console hook: it goes the way of
    // a name that is not a hook, and counts nothing.
    const external = hook && hook.source !== 'console' ? hook : null;
    const secret = external ? secretOf(name) : null;
    if (external && !secret) note(name, 'hook-secret-missing');
    const mac = createHmac('sha256', secret || NO_SECRET), kept = hook?.match ? [] : null;
    let size = 0;
    try { for await (const chunk of body) { size += chunk.length; if (size <= MAX_BODY) { mac.update(chunk); kept?.push(chunk); } } }
    catch { return reply(400, { error: 'Delivery was not read' }); }
    if (size > MAX_BODY) return reply(413, { error: 'Delivery too large' });
    // Both comparisons are made whatever kind the hook is, on values of fixed length.
    const signed = timingSafeEqual(Buffer.from(`sha256=${mac.digest('hex')}`), Buffer.from(signature || `sha256=${'0'.repeat(64)}`));
    const same = timingSafeEqual(sha256(shown || ''), sha256(secret || NO_SECRET));
    if (!secret || !(hook.source === 'github' ? signature && signed : shown && same)) {
      if (secret) note(name, 'hook-signature-rejected');
      if (external) delivered(name, 'refused');
      return reply(401, { error: 'Invalid signature' });
    }
    // From here on the caller holds the hook's secret. The headers below are
    // not covered by it: they sort deliveries, they prove nothing.
    const github = hook.source === 'github';
    const event = github ? header('x-github-event') : `${header('xf-content-type')}.${header('xf-webhook-event')}`;
    // XenForo numbers its webhooks, not its deliveries.
    const delivery = github ? header('x-github-delivery') : /^\d{1,10}$/.test(header('xf-webhook-id')) ? `xf-${header('xf-webhook-id')}` : '';
    if (!EVENT.test(event) || !DELIVERY.test(delivery)) return reply(400, { error: 'Invalid delivery headers' });
    // GitHub's own test delivery when a webhook is created.
    if (github && event === 'ping') { delivered(name, 'ignored'); return reply(200, { accepted: true, ping: true }); }
    if (hook.events && !hook.events.has(event)) { delivered(name, 'ignored'); return reply(202, { accepted: true, ignored: true }); }
    if (hook.match) {
      let payload;
      try { payload = JSON.parse(Buffer.concat(kept).toString('utf8')); } catch { return reply(400, { error: 'Delivery is not JSON' }); }
      if (!matches(hook.match, event, payload)) { delivered(name, 'ignored'); return reply(202, { accepted: true, ignored: true }); }
    }
    delivered(name, 'woke');
    return reply(202, { accepted: true, seq: wake(name, event, delivery).seq });
  }

  // The console's own wake, for a hook with source "console". Null when the
  // name is not such a hook: the caller's work then waits for its own timer.
  function fire(name, event) {
    const hook = HOOK_NAME.test(name || '') ? configured().get(name) : null;
    if (hook?.source !== 'console' || !EVENT.test(event || '')) return null;
    delivered(name, 'woke');
    return wake(name, event, 'console', true);
  }

  const listenerOf = (hook, authorization) => {
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization || '')?.[1];
    const digest = sha256(token || '');
    // No early exit, and the same work for a name that is not a hook.
    let found = null;
    for (const l of hook ? hook.listeners : NO_LISTENERS) if (timingSafeEqual(l.digest, digest) && hook && token) found = l.id;
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
    seen.set(`${name}|${listener}`, clock());
    if (after !== undefined && stateOf(name).seq === Number(after)) {
      const set = waiters.get(name) || waiters.set(name, new Set()).get(name);
      if ([...set].filter((w) => w.listener === listener).length >= MAX_WAITS_PER_LISTENER) return reply(429, { error: 'This listener already holds its requests on this hook' });
      let timer;
      const waiter = { listener };
      await Promise.race([
        new Promise((resolve) => { waiter.done = resolve; set.add(waiter); }),
        new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
        closed,
      ]);
      clearTimeout(timer);
      set.delete(waiter);
      seen.set(`${name}|${listener}`, clock());
    }
    return reply(200, { hook: name, listener, ...stateOf(name) });
  }

  // For the status page: what exists, whether each hook can do its job right
  // now, and what arrived since this process started. No secret and no token
  // digest. A hook is `down` when a delivery to it would not wake a listener.
  const list = () => {
    const now = clock();
    return [...configured()].map(([name, hook]) => {
      const t = tally(name), hasSecret = hook.source === 'console' || !!secretOf(name), held = [...(waiters.get(name) || [])];
      const listeners = hook.listeners.map((l) => {
        const last = seen.get(`${name}|${l.id}`) ?? null, waiting = held.filter((w) => w.listener === l.id).length;
        return { id: l.id, waiting, lastSeenAt: last === null ? null : iso(last), connected: waiting > 0 || (last !== null && now - last < LISTENER_AWAY_MS) };
      });
      const away = listeners.filter((l) => !l.connected), ids = away.map((l) => l.id).join(', ');
      let level = 'ok', reason = null;
      if (!hasSecret) [level, reason] = ['down', 'No usable secret file on the status host: every delivery is refused.'];
      else if (!listeners.length) [level, reason] = ['down', 'No listener is configured.'];
      // After a restart of this process a listener needs a moment to come back.
      else if (away.length && now - startedAt < LISTENER_AWAY_MS && away.every((l) => l.lastSeenAt === null)) [level, reason] = ['info', `The console restarted; waiting for listener ${ids} to ask again.`];
      else if (away.length) [level, reason] = ['down', away.length === listeners.length
        ? `Listener ${ids} is not connected: a delivery wakes nobody, and the work runs on its own timer until it is back.`
        : `Listener ${ids} is not connected: a delivery does not wake it, and its work runs on its own timer until it is back.`];
      // The newest delivery by order of arrival, not by comparing two clock readings.
      else if (t.last === 'refused' && Math.abs(now - t.lastRefusedAt) < REFUSAL_SHOWN_MS) [level, reason] = ['warn', 'The newest delivery was refused: its signature or secret was wrong.'];
      return { name, level, reason, source: hook.source, events: hook.events ? [...hook.events].sort() : null, matchRules: hook.match?.length || 0,
        listeners, listenersWaiting: listeners.reduce((n, l) => n + l.waiting, 0), hasSecret, ...stateOf(name),
        deliveries: { woke: t.woke, ignored: t.ignored, refused: t.refused, lastAt: t.lastDeliveryAt === null ? null : iso(t.lastDeliveryAt), lastRefusedAt: t.lastRefusedAt === null ? null : iso(t.lastRefusedAt) } };
    });
  };
  // Everything the page needs, from one look. `summary` goes with the list to an
  // account that has access. `open` is for everyone else, and holds nothing that
  // a caller without a secret can move: a refused delivery changes `refused` and
  // a hook's `warn`, and if those showed here, sending a bad signature to a
  // guessed name and reading the counts again would tell which names exist. So
  // `open` counts a hook that is listening whether or not it is on `warn`,
  // leaves refusals out, and gives times to the minute. `invalid`: hooks.json is
  // there and does not parse, so no hook exists; that names nothing.
  // A console hook is left out of `open` altogether: the console wakes it for
  // what it sees, on private networks too, and its count moving would tell
  // everyone the minute something broke there.
  const status = () => {
    const hooks = list();
    const newest = (values) => values.filter(Boolean).sort().pop() || null;
    const minute = (at) => (at ? `${at.slice(0, 16)}:00.000Z` : null);
    const sum = (rows) => {
      const count = (level) => rows.filter((h) => h.level === level).length, total = (key) => rows.reduce((n, h) => n + h.deliveries[key], 0);
      return { shared: { hooks: rows.length, listening: count('ok') + count('warn'), down: count('down'), starting: count('info'), woke: total('woke'), ignored: total('ignored') },
        warn: count('warn'), refused: total('refused'), lastWakeAt: newest(rows.map((h) => h.at)), lastDeliveryAt: newest(rows.map((h) => h.deliveries.lastAt)) };
    };
    const all = sum(hooks), outside = sum(hooks.filter((h) => h.source !== 'console'));
    return { invalid: cache.invalid, hooks, startedAt: iso(startedAt),
      summary: { ...all.shared, warn: all.warn, refused: all.refused, lastWakeAt: all.lastWakeAt, lastDeliveryAt: all.lastDeliveryAt },
      open: { ...outside.shared, lastWakeAt: minute(outside.lastWakeAt), lastDeliveryAt: minute(outside.lastDeliveryAt), startedAt: minute(iso(startedAt)) } };
  };
  const close = () => { for (const set of waiters.values()) for (const w of [...set]) w.done(); };

  return { receive, fire, wait, list, status, close };
}
