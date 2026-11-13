// Single writer. No cloud, SSH, Docker or OpenClaw credentials in this process.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { operationMaintenance, heldByOperation } from './operation-maintenance.js';
import { createCi } from './ci.js';
import { loadSettings, readJSON } from '../shared/settings.js';
import { deriveIssues, reconcile, loadIncidentState, saveIncidentState, readSecret, signedHeaders, validateDestination } from './incidents.js';
import { recognizeActivity } from './change-activity.js';
import { stallAlert, validateAlertUrl } from './stall-alert.js';
import { loadControl, wireControl } from './remediation-control.js';
import { loadReleases, releaseEvents } from './release-hook.js';

export async function cycle({ dataDir, ci, destination, secret, alertUrl = null, fetcher = fetch, now = Date.now() }) {
  const settings = loadSettings(join(dataDir, 'settings.json'));
  const states = Object.fromEntries(settings.networks.map((n) => [n.name, readJSON(join(dataDir, 'state', `${n.name}.json`))]));
  const aws = readJSON(join(dataDir, 'aws', 'inventory.json'));
  if (aws) aws.health = readJSON(join(dataDir, 'aws', 'health.json'));
  const maintenance = operationMaintenance(dataDir, settings, now);
  const previous = loadIncidentState(dataDir);
  // Upgrades, redeploys and reboots seen in live observations are held like
  // dashboard operations, so their expected downtime never reaches the queue.
  const activity = recognizeActivity({ settings, states, previous: previous?.activity, now });
  const derived = deriveIssues({ settings, states, maintenance, activity, ci: (ci || createCi({ dataDir })).summary({ admin: true }), aws, now });
  const state = reconcile(previous, derived, now);
  state.maintenance = maintenance;
  state.activity = activity;
  // Upstream release notices recorded by the web process join the same durable
  // outbox, so they share its signing, retry and acknowledgement. They wait for
  // a receiver that has announced the `release` domain: an older one rejects
  // it, and a rejected event would be quarantined instead of delivered.
  if (Array.isArray(state.delivery?.receiver?.domains) && state.delivery.receiver.domains.includes('release')) state.outbox.push(...releaseEvents(loadReleases(dataDir), state, now));
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
    for (const event of state.outbox.filter((e) => !heldByOperation(e.issue, maintenance) && !state.issues.some((i) => i.id === e.issue.id && i.suppressed)).slice(0, state.delivery?.batchSize || 50)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 400_000) break;
      events.push(event); bytes += size;
    }
    // The administrator switch and queue clear ride the signed heartbeat. They
    // are sent only to a receiver that has advertised support: an older one
    // rejects unknown envelope fields, which must never quarantine events.
    const control = state.delivery?.receiver?.control ? wireControl(loadControl(dataDir)) : null;
    const body = JSON.stringify({ schemaVersion: 1, producer: 'dash-status', sentAt: new Date(now).toISOString(), events, ...(control ? { control } : {}) });
    try {
      const response = await fetcher(validateDestination(destination), { method: 'POST', headers: signedHeaders(body, secret, now), body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const error = new Error(`receiver HTTP ${response.status}`);
        error.permanentPayload = [400, 413, 422].includes(response.status) && !control;
        // A receiver rolled back to a release without controls: stop sending them.
        if (control && response.status === 400) state.delivery = { ...state.delivery, receiver: { ...state.delivery.receiver, control: undefined } };
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
  // A failed notice is retried on the next cycle; it never blocks this one.
  try { await stallAlert(state, { url: alertUrl, fetcher, now }); }
  catch (e) { console.error('stall alert failed:', e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 150)); }
  saveIncidentState(dataDir, state);
  return { active: state.issues.filter((i) => i.status === 'open').length, pending: state.outbox.length, delivered: state.delivery?.lastAckAt || null };
}

export function startIncidents() {
  const dataDir = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
  mkdirSync(join(dataDir, 'incidents'), { recursive: true });
  const destination = process.env.INCIDENT_WEBHOOK_URL;
  if (destination) validateDestination(destination);
  const secret = readSecret(process.env.INCIDENT_HMAC_FILE);
  // Optional. A Slack-compatible incoming webhook URL kept in a restricted file.
  const alertUrl = process.env.INCIDENT_ALERT_WEBHOOK_FILE ? validateAlertUrl(readSecret(process.env.INCIDENT_ALERT_WEBHOOK_FILE)) : null;
  let stopped = false;
  const loop = async () => {
    try { console.log(new Date().toISOString(), 'incidents', await cycle({ dataDir, destination, secret, alertUrl })); }
    catch (e) { console.error('incident cycle failed:', e.message); }
    if (!stopped) setTimeout(loop, 60_000);
  };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopped = true; process.exit(0); });
  loop();
}
