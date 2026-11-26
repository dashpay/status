// API tokens: network operations for bots, without a browser session.
//
//   data/api-tokens.json   token id -> { label, hash (sha256 of the token), owner { id, login },
//                                        role, networks, createdAt, expiresAt, lastUsedAt }
//
// A token acts for the admin account that issued it and can only narrow that
// account's access (shared/settings.js accessFor): removing or demoting the
// account takes its tokens with it. Only the hash is stored; the token itself is
// shown once, when issued. Tokens operate networks. They never manage access
// or other tokens and never read private keys, and of the settings an admin
// token changes only the versions a new devnet starts with (server/web.js).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { ROLES, readJSON, writeAtomic } from '../shared/settings.js';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const NETWORK = /^[a-z][a-z0-9-]{0,62}$/;
const BEARER = /^Bearer (dst_([a-f0-9]{8})_[A-Za-z0-9_-]{43})$/;
const MAX_TOKENS = 50;
const USED_EVERY_MS = 60_000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// True for any request that presents an API token, valid or not.
export const presentsApiToken = (header) => /^Bearer dst_/.test(header || '');

export function createApiTokens({ dataDir, clock = Date.now }) {
  const path = join(dataDir, 'api-tokens.json');
  const all = () => readJSON(path, {});
  const save = (tokens) => writeAtomic(path, JSON.stringify(tokens, null, 1), 0o600);
  const view = ([id, t]) => ({ id, label: t.label, owner: t.owner, role: t.role, networks: t.networks, createdAt: t.createdAt, expiresAt: t.expiresAt || null, lastUsedAt: t.lastUsedAt || null });

  function issue(owner, { label, role, networks, expiresDays } = {}) {
    if (!Number.isInteger(owner?.id) || typeof owner.login !== 'string') throw new Error('a token needs the account that issues it');
    if (typeof label !== 'string' || !LABEL.test(label.trim())) throw new Error('label: 1-40 letters, digits, spaces and . _ -');
    if (!ROLES.includes(role)) throw new Error(`role must be ${ROLES.join(', ')}`);
    const nets = role === 'admin' ? ['*'] : networks;
    if (!Array.isArray(nets) || !nets.length || nets.length > 40 || !nets.every((n) => n === '*' || (typeof n === 'string' && NETWORK.test(n)))) throw new Error('grant at least one network');
    if (expiresDays != null && (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 365)) throw new Error('expiry must be 1 to 365 days, or empty for none');
    const tokens = all();
    if (Object.keys(tokens).length >= MAX_TOKENS) throw new Error(`at most ${MAX_TOKENS} tokens; revoke one first`);
    let id;
    do id = randomBytes(4).toString('hex'); while (Object.hasOwn(tokens, id));
    const token = `dst_${id}_${randomBytes(32).toString('base64url')}`;
    const now = clock();
    tokens[id] = { label: label.trim(), hash: sha256(token), owner: { id: owner.id, login: owner.login }, role, networks: [...new Set(nets)], createdAt: new Date(now).toISOString(),
      ...(expiresDays ? { expiresAt: new Date(now + expiresDays * 86400_000).toISOString() } : {}) };
    save(tokens);
    return { ...view([id, tokens[id]]), token };
  }

  function revoke(id) {
    const tokens = all();
    if (!Object.hasOwn(tokens, id)) throw new Error('no such token');
    delete tokens[id];
    save(tokens);
  }

  // The token's own record, or null. Whether its owner still has access is
  // decided per request against the current settings, not here.
  function authenticate(header) {
    const m = BEARER.exec(header || '');
    if (!m) return null;
    const tokens = all();
    const t = Object.hasOwn(tokens, m[2]) ? tokens[m[2]] : null;
    const want = Buffer.from(String(t?.hash || ''), 'hex'), got = Buffer.from(sha256(m[1]), 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const now = clock();
    if (t.expiresAt && Date.parse(t.expiresAt) <= now) return null;
    if (!(now - Date.parse(t.lastUsedAt) < USED_EVERY_MS)) {
      // Best effort: a read-only data directory must not turn a valid token away.
      try { t.lastUsedAt = new Date(now).toISOString(); save(tokens); } catch { /* keep serving */ }
    }
    return view([m[2], t]);
  }

  return { issue, revoke, authenticate, list: () => Object.entries(all()).map(view).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}
