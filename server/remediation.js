// The issues monitoring keeps, as a list of cases for reading: what is wrong
// now, what is held, and what ended in the last day. Presentation only: it
// never changes an issue or the repair switch. Triage (server/triage.js) is
// what sorts the same issues and wakes a worker for them.
import { TITLES } from './incidents.js';
import { RELEASE_CODES } from './release-webhook.js';
import { activityHidden } from './remediation-activity.js';

const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 60_000 && now - Date.parse(at) <= 180_000;
const text = (value, size = 800) => typeof value === 'string' ? value.slice(0, size) : null;
const iso = (value) => value != null && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const OPERATION_HOLD = 'Active network operation; automatic repair is held until fresh post-operation monitoring';
function holdReason(state, issue) {
  if (issue.domain !== 'network') return 'Instance belongs to a host under a recognised change; automatic repair is held until it settles';
  const operations = state.maintenance?.[issue.scope]?.operations;
  if (Array.isArray(operations) && operations.some((o) => o?.status !== 'settling')) return OPERATION_HOLD;
  if (Array.isArray(operations) && operations.length) return 'Network operation just finished; automatic repair is held while the network settles';
  if (state.activity?.hosts?.[`${issue.scope}/${issue.evidence?.instanceId || issue.target}`]?.held === true) return 'Upgrade or restart recognised on this host; automatic repair is held until it settles';
  if (state.activity?.networks?.[issue.scope]?.held === true) return 'Upgrade recognised on this network; automatic repair is held until it settles';
  // Endpoint checks are held while any host of their network is changing.
  if (Object.values(state.activity?.hosts || {}).some((v) => v?.network === issue.scope && v.held === true)) return 'Upgrade or restart recognised on a host of this network; automatic repair is held until it settles';
  return OPERATION_HOLD;
}
const LABEL = { open: 'Open', maintenance: 'Maintenance', recovered: 'Recovered', closed: 'Closed', classified: 'Monitoring corrected', review: 'Review only', unknown: 'Awaiting status' };
// How monitoring saw a fault recover without a repair being claimed.
const RECOVERED = { left_queue: 'The job left the queue: it started, finished or was cancelled',
  later_attempt_passed: 'A later attempt of this job passed', later_run_passed: 'A later run of this job on the same branch passed',
  quiet: 'The host reported no fault through consecutive healthy samples',
  // Recorded while a repair worker still reported on release tasks.
  compatibility_report: 'A compatibility report was recorded for this release' };
// Why a case ended although nothing recovered. Never shown as a recovery.
const ENDED = { network_removed: 'The network no longer exists', target_removed: 'The host, endpoint or resource no longer exists',
  expired: 'Closed by age; no recovery was observed', ignored_job: 'This job is a policy check; its failure is not a CI fault',
  superseded: 'Superseded by a newer release in the same line' };
// Recovered and closed cases stay listed this long, newest first, up to a limit:
// the list is for reading, and the first cycle of a new rule can end thousands.
export const HISTORY_MS = 24 * 3600_000;
export const HISTORY_MAX = 200;
const ENDED_STAGES = ['recovered', 'closed', 'classified'];
const SEVERITY = ['critical', 'warning', 'info'];

const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/job\/\d+)?$/;
const gib = (bytes) => (typeof bytes === 'number' && Number.isFinite(bytes) ? `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GiB` : null);
const percent = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : null);
// What is wrong, in one line, from the recorded evidence. Administrators only:
// evidence names hosts, branches and resources. Evidence is data, never markup.
export function describe(issue) {
  const e = issue.evidence && typeof issue.evidence === 'object' ? issue.evidence : {};
  const join = (parts) => text(parts.filter((p) => typeof p === 'string' && p).join(' · '), 600) || null;
  const link = (url) => (typeof url === 'string' && GITHUB.test(url) ? url : null);
  switch (issue.code) {
    case 'host_health': return { detail: join(Array.isArray(e.reasons) ? e.reasons.slice(0, 8).map((r) => text(r, 160)) : []) };
    case 'endpoint_failed': return { detail: join([text(e.kind, 20) || 'http', Number.isSafeInteger(e.status) ? `HTTP ${e.status}` : 'no response']) };
    case 'job_failed': return { detail: join([text(e.repo, 100), text(e.workflow, 100), text(e.jobName, 200), text(e.branch, 100), e.attempt > 1 ? `attempt ${e.attempt}` : null, text(e.runner, 100)]),
      link: link(`https://github.com/${e.repo}/actions/runs/${e.runId}`), group: join([text(e.repo, 100), text(e.jobName, 200)]) };
    case 'queue_wait': return { detail: join([text(e.repo, 100), text(e.workflow, 100), text(e.name, 200), text(e.branch, 100), iso(e.createdAt) ? `queued ${iso(e.createdAt).replace('T', ' ').slice(0, 16)}Z` : null]),
      link: link(e.url), group: join([text(e.repo, 100), text(e.name, 200) || 'waiting jobs']) };
    case 'disk_pressure': return { detail: join([percent(e.usedPercent) && `${percent(e.usedPercent)} used`, gib(e.freeBytes) && `${gib(e.freeBytes)} free`]) };
    case 'memory_pressure': return { detail: join([percent(e.usedPercent) && `${percent(e.usedPercent)} used`]) };
    case 'runner_offline': return { detail: join([text(e.status, 20) && `runner ${text(e.status, 20)}`]) };
    case 'reporter_stale': case 'reporter_missing': case 'collector_stale': case 'aws_stale':
      return { detail: join([iso(e.lastObservationAt) ? `last observation ${iso(e.lastObservationAt).replace('T', ' ').slice(0, 16)}Z` : 'never observed', text(e.error, 200)]) };
    case 'discovery_failed': case 'aws_collection_failed': return { detail: join([text(e.error, 300)]) };
    case 'idle_volume': return { detail: join([Number.isFinite(e.sizeGiB) ? `${e.sizeGiB} GiB` : null, 'not attached']) };
    case 'idle_address': return { detail: 'not associated with an instance or interface' };
    case 'aws_instance_impaired': return { detail: join([text(e.instanceStatus, 20) && `instance check ${text(e.instanceStatus, 20)}`, text(e.systemStatus, 20) && `system check ${text(e.systemStatus, 20)}`]) };
    case 'aws_alarm': return { detail: join([text(e.state, 30) && `state ${text(e.state, 30)}`]) };
    case 'aws_scheduled_event': return { detail: join((Array.isArray(e.events) ? e.events : []).slice(0, 5).map((v) => text(v?.code, 60))) };
    default: return {};
  }
}

export function remediationView(state, { full = false, visibleNetworks = [], now = Date.now() } = {}) {
  const producerFresh = fresh(state?.generatedAt, now);
  const visible = new Set(visibleNetworks);
  const visibleIssues = (state?.issues || []).filter((i) => !i.remediationExcluded).filter((i) => full || i.domain !== 'network' || visible.has(i.scope));
  const displayedIssues = visibleIssues.filter((i) => !activityHidden(i, state));
  let older = 0;
  const cases = displayedIssues.map((issue) => {
    const open = issue.status !== 'resolved', resolved = issue.status === 'resolved' && producerFresh;
    const why = text(issue.resolutionEvidence?.reason, 40);
    // Left as it is for a case that ended in a state too old to go by.
    let stage = 'unknown', reason = 'Monitoring is not current; the end of this case is unconfirmed';
    const component = issue.domain === 'maintenance' && Object.hasOwn(RELEASE_CODES, issue.code) ? RELEASE_CODES[issue.code] : null, compatibility = !!component;
    if (open && issue.severity === 'info' && !compatibility) { stage = 'review'; reason = 'Informational finding; no automatic cleanup'; }
    else if (open && (issue.suppressed || (issue.domain === 'network' && state.maintenance?.[issue.scope]?.active))) {
      stage = 'maintenance'; reason = holdReason(state, issue);
    } else if (resolved && why === 'verified_control_signal') {
      stage = 'classified'; reason = 'Verified scaling control; monitoring classification corrected, not a service recovery';
    } else if (resolved && Object.hasOwn(ENDED, why)) {
      stage = 'closed'; reason = why === 'superseded' && text(issue.resolutionEvidence.by, 100) ? `Superseded by ${text(issue.resolutionEvidence.by, 100)}` : ENDED[why];
    } else if (resolved) {
      stage = 'recovered'; reason = RECOVERED[why] || 'Monitoring observed recovery; no autonomous fix is claimed';
    } else if (open) { stage = 'open'; reason = null; } // the case says what is wrong
    // Recovered and closed cases leave the list after a day; the count stays.
    if (ENDED_STAGES.includes(stage) && now - Date.parse(issue.resolvedAt) > HISTORY_MS) { older++; return null; }
    const result = { id: issue.id, domain: issue.domain, network: issue.domain === 'network' ? issue.scope : null,
      title: compatibility ? `Check and fix dash-network-go compatibility with ${component} ${text(issue.evidence?.tag, 100) || 'release'}` : TITLES[issue.code] || 'Status issue', severity: issue.severity, stage, stageLabel: LABEL[stage], reason,
      monitoring: issue.status, firstSeen: iso(issue.firstSeen), observedAt: iso(issue.lastSeen), resolvedAt: iso(issue.resolvedAt),
      stale: !producerFresh };
    if (compatibility) result.taskType = 'compatibility';
    if (full) Object.assign(result, { target: text(issue.target, 512), scope: text(issue.scope, 512), code: issue.code,
      detail: null, link: null, group: null, ...describe(issue) });
    return result;
  }).filter(Boolean);
  // Counted in full below; only the listing is limited.
  const ended = cases.filter((c) => ENDED_STAGES.includes(c.stage)).sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));
  const unlisted = new Set(ended.slice(HISTORY_MAX).map((c) => c.id));
  const order = ['open', 'maintenance', 'unknown', 'review', 'recovered', 'closed', 'classified'];
  // Current faults by severity, then newest seen. What has ended, by when it ended.
  const over = (c) => c.monitoring === 'resolved';
  cases.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage)
    || (over(a) && over(b) ? (b.resolvedAt || '').localeCompare(a.resolvedAt || '') : SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity))
    || (b.observedAt || '').localeCompare(a.observedAt || ''));
  const counts = Object.fromEntries(order.map((stage) => [stage, cases.filter((c) => c.stage === stage).length]));
  // What monitoring says is wrong now.
  const openCases = cases.filter((c) => c.monitoring !== 'resolved');
  const faults = { open: openCases.length, ...Object.fromEntries(SEVERITY.map((s) => [s, openCases.filter((c) => c.severity === s).length])),
    held: counts.maintenance, recovered: counts.recovered, closed: counts.closed + counts.classified,
    domains: Object.fromEntries(['network', 'ci', 'aws', 'maintenance'].map((d) => [d, openCases.filter((c) => c.domain === d).length])) };
  // The repair switch, as it is in its own file (`fixing` in triage's answer).
  // Who changed it and when stay with administrators.
  const control = { requested: state?.control?.dispatch === 'on' ? 'on' : 'off',
    ...(full ? { changedAt: iso(state?.control?.updatedAt), changedBy: text(state?.control?.updatedBy, 39) } : {}) };
  return { schemaVersion: 1, public: !full, generatedAt: iso(state?.generatedAt), control, stale: !producerFresh, producerFresh,
    activityHistory: { clearedAt: iso(state?.activityHistory?.clearedAt), hidden: visibleIssues.length - displayedIssues.length,
      ...(full ? { clearedBy: text(state?.activityHistory?.clearedBy, 39) } : {}) },
    history: { hours: HISTORY_MS / 3600_000, older, unlisted: unlisted.size },
    maintenance: Object.entries(state?.maintenance || {}).filter(([name]) => full || visible.has(name)).map(([network, value]) => ({ network, operations:full ? value.operations : undefined })),
    counts, faults, cases: cases.filter((c) => !unlisted.has(c.id)) };
}
