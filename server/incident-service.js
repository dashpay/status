// Single writer. No cloud, SSH, Docker or OpenClaw credentials in this process.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCi } from './ci.js';
import { loadSettings, readJSON } from '../shared/settings.js';
import { deriveIssues, reconcile, loadIncidentState, saveIncidentState, readSecret, signedHeaders, validateDestination } from './incidents.js';

export async function cycle({ dataDir, ci, destination, secret, fetcher = fetch, now = Date.now() }) {
  const settings = loadSettings(join(dataDir, 'settings.json'));
  const states = Object.fromEntries(settings.networks.map((n) => [n.name, readJSON(join(dataDir, 'state', `${n.name}.json`))]));
  const aws = readJSON(join(dataDir, 'aws', 'inventory.json'));
  if (aws) aws.health = readJSON(join(dataDir, 'aws', 'health.json'));
  const derived = deriveIssues({ settings, states, ci: (ci || createCi({ dataDir })).summary({ admin: true }), aws, now });
  const state = reconcile(loadIncidentState(dataDir), derived, now);
  // Commit events before any attempt; lost acknowledgements replay eventId safely.
  saveIncidentState(dataDir, state);
  if (destination && secret && (!state.delivery?.nextAttemptAt || Date.parse(state.delivery.nextAttemptAt) <= now)) {
    // A single oversized head event must not cause empty-heartbeat ACKs forever
    // while starving every valid event behind it. Preserve it for inspection.
    const oversized = state.outbox.filter((event) => Buffer.byteLength(JSON.stringify(event)) > 400_000);
    if (oversized.length) {
      const ids = new Set(oversized.map((event) => event.eventId));
      state.quarantined = [...(state.quarantined || []), ...oversized.map((event) => ({ event, at: new Date(now).toISOString(), reason: 'event exceeds delivery byte budget' }))];
      state.outbox = state.outbox.filter((event) => !ids.has(event.eventId));
      saveIncidentState(dataDir, state);
    }
    const events = [];
    let bytes = 0;
    for (const event of state.outbox.slice(0, state.delivery?.batchSize || 50)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 400_000) break;
      events.push(event); bytes += size;
    }
    const body = JSON.stringify({ schemaVersion: 1, producer: 'dash-status', sentAt: new Date(now).toISOString(), events });
    try {
      const response = await fetcher(validateDestination(destination), { method: 'POST', headers: signedHeaders(body, secret, now), body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const error = new Error(`receiver HTTP ${response.status}`);
        error.permanentPayload = [400, 413, 422].includes(response.status);
        throw error;
      }
      const ack = await response.json();
      if (!Array.isArray(ack.accepted) || events.some((e) => !ack.accepted.includes(e.eventId))) throw new Error('receiver acknowledgement incomplete');
      const sent = new Set(events.map((e) => e.eventId));
      state.outbox = state.outbox.filter((e) => !sent.has(e.eventId));
      state.delivery = { configured: true, lastAckAt: new Date(now).toISOString(), error: null, receiver: ack.health || null };
    } catch (e) {
      const attempts = (state.delivery?.attempts || 0) + 1;
      if (e.permanentPayload && events.length === 1) {
        state.quarantined = [...(state.quarantined || []), { event: events[0], at: new Date(now).toISOString(), reason: e.message }];
        state.outbox = state.outbox.filter((e) => e.eventId !== events[0].eventId);
      }
      state.delivery = { ...state.delivery, configured: true, attempts, batchSize: e.permanentPayload ? 1 : state.delivery?.batchSize,
        nextAttemptAt: new Date(now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4))).toISOString(), lastAttemptAt: new Date(now).toISOString(), error: e.name === 'TimeoutError' ? 'receiver timeout' : e.message.slice(0, 150) };
    }
  } else if (!destination || !secret) state.delivery = { configured: false, error: 'receiver not configured' };
  saveIncidentState(dataDir, state);
  return { active: state.issues.filter((i) => i.status === 'open').length, pending: state.outbox.length, delivered: state.delivery?.lastAckAt || null };
}

export function startIncidents() {
  const dataDir = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
  mkdirSync(join(dataDir, 'incidents'), { recursive: true });
  const destination = process.env.INCIDENT_WEBHOOK_URL;
  if (destination) validateDestination(destination);
  const secret = readSecret(process.env.INCIDENT_HMAC_FILE);
  let stopped = false;
  const loop = async () => {
    try { console.log(new Date().toISOString(), 'incidents', await cycle({ dataDir, destination, secret })); }
    catch (e) { console.error('incident cycle failed:', e.message); }
    if (!stopped) setTimeout(loop, 60_000);
  };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopped = true; process.exit(0); });
  loop();
}
