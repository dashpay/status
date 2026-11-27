// Single writer of incidents/state.json. It derives the issues and sends them
// nowhere: triage in the web process reads the file (deploy/TRIAGE.md).
// No cloud, SSH or Docker credentials in this process.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { operationMaintenance, operationRecords } from './operation-maintenance.js';
import { createCi } from './ci.js';
import { loadReleaseInbox, reconcileReleaseTasks } from './release-webhook.js';
import { loadSettings, readJSON } from '../shared/settings.js';
import { deriveIssues, reconcile, loadIncidentState, saveIncidentState } from './incidents.js';
import { recognizeActivity } from './change-activity.js';

export async function cycle({ dataDir, ci, now = Date.now() }) {
  const settings = loadSettings(join(dataDir, 'settings.json'));
  const states = Object.fromEntries(settings.networks.map((n) => [n.name, readJSON(join(dataDir, 'state', `${n.name}.json`))]));
  const aws = readJSON(join(dataDir, 'aws', 'inventory.json'));
  if (aws) aws.health = readJSON(join(dataDir, 'aws', 'health.json'));
  const operations = operationRecords(dataDir);
  const maintenance = operationMaintenance(dataDir, settings, now, operations);
  const previous = loadIncidentState(dataDir);
  // Upgrades, redeploys and reboots seen in live observations are held like
  // dashboard operations, so their expected downtime is not filed as new.
  const activity = recognizeActivity({ settings, states, previous: previous?.activity, now });
  const derived = deriveIssues({ settings, states, operations, maintenance, activity, ci: (ci || createCi({ dataDir })).summary({ admin: true, whole: true }), aws, now });
  const state = reconcile(previous, derived, now);
  state.maintenance = maintenance;
  state.activity = activity;
  reconcileReleaseTasks(state, loadReleaseInbox(dataDir), now);
  // Until November 2026 the issues were also sent to a repair receiver on
  // another host. What it last answered, and the record of it not answering,
  // are not carried over from a state that release wrote. `delivery` stays as
  // that release wrote it with no receiver configured.
  state.delivery = { configured: false };
  delete state.stall;
  saveIncidentState(dataDir, state);
  return { active: state.issues.filter((i) => i.status === 'open').length };
}

export function startIncidents() {
  const dataDir = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
  mkdirSync(join(dataDir, 'incidents'), { recursive: true });
  let stopped = false;
  const loop = async () => {
    try { console.log(new Date().toISOString(), 'incidents', await cycle({ dataDir })); }
    catch (e) { console.error('incident cycle failed:', e.message); }
    if (!stopped) setTimeout(loop, 60_000);
  };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopped = true; process.exit(0); });
  loop();
}
