// Presentation only: never changes incidents, receipts, locks or dispatch.
import { TITLES } from './incidents.js';
import { RELEASE_CODES } from './release-webhook.js';
import { stallReasons } from './stall-alert.js';
import { activityHidden } from './remediation-activity.js';

const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 60_000 && now - Date.parse(at) <= 180_000;
const text = (value, size = 800) => typeof value === 'string' ? value.slice(0, size) : null;
const iso = (value) => value != null && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const WAIT = { capacity: 'Waiting for a repair slot', resource_conflict: 'Waiting for the current resource owner',
  cooldown: 'Waiting for the scope cooldown', budget: 'Waiting for the dispatch budget', paused: 'New dispatch is paused', eligible: 'Ready for dispatch',
  settling: 'Waiting to confirm the fault persists', route: 'Waiting for the repair model route to recover' };
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
const LABEL = { open: 'Open', maintenance: 'Maintenance', queued: 'Queued', working: 'Working', blocked: 'Blocked', followup: 'Recovered · follow-up', verifying: 'Verifying', fixed: 'Verified fixed', recovered: 'Recovered', closed: 'Closed', classified: 'Monitoring corrected', review: 'Review only', unknown: 'Awaiting status' };
// How monitoring saw a fault recover without a repair being claimed.
const RECOVERED = { left_queue: 'The job left the queue: it started, finished or was cancelled',
  later_attempt_passed: 'A later attempt of this job passed', later_run_passed: 'A later run of this job on the same branch passed',
  quiet: 'The host reported no fault through consecutive healthy samples' };
// Why a case ended although nothing recovered. Never shown as a recovery.
const ENDED = { network_removed: 'The network no longer exists', target_removed: 'The host, endpoint or resource no longer exists',
  expired: 'Closed by age; no recovery was observed', ignored_job: 'This job is a policy check; its failure is not a CI fault',
  superseded: 'Superseded by a newer release in the same line' };
// Recovered and closed cases stay listed this long, newest first, up to a limit:
// the list is for reading, and the first cycle of a new rule can end thousands.
export const HISTORY_MS = 24 * 3600_000;
export const HISTORY_MAX = 200;
const ENDED_STAGES = ['recovered', 'closed', 'fixed', 'classified'];
const SEVERITY = ['critical', 'warning', 'info'];

const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/job\/\d+)?$/;
const gib = (bytes) => (typeof bytes === 'number' && Number.isFinite(bytes) ? `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GiB` : null);
const percent = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : null);
// What is wrong, in one line, from the recorded evidence. Administrators only:
// evidence names hosts, branches and resources. Evidence is data, never markup.
function describe(issue) {
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
  const feed = state?.delivery?.receiver?.remediation;
  const producerFresh = fresh(state?.generatedAt, now);
  const heartbeat = state?.delivery?.receiver?.workerAt;
  const workerAt = Number.isFinite(heartbeat) ? iso(heartbeat * 1000) : null;
  const workerFresh = feed?.schemaVersion === 1 && fresh(feed.generatedAt, now) && fresh(workerAt, now) && Array.isArray(feed.cases);
  // Switched off here and no worker reporting: nothing is being repaired and
  // nothing is queued for repair. The page is then a list of faults, and what
  // the worker last said about a case is history, not its current state.
  const requested = state?.control || null;
  const idle = requested?.dispatch !== 'on' && !workerFresh;
  const observations = new Map((Array.isArray(feed?.cases) ? feed.cases : []).map((c) => [c.issueId, c]));
  const visible = new Set(visibleNetworks);
  const visibleIssues = (state?.issues || []).filter((i) => !i.remediationExcluded).filter((i) => full || i.domain !== 'network' || visible.has(i.scope));
  const displayedIssues = visibleIssues.filter((i) => !activityHidden(i, observations.get(i.id), state));
  let older = 0;
  const cases = displayedIssues.map((issue) => {
    const response = observations.get(issue.id);
    const last = response?.lastResponse;
    const open = issue.status !== 'resolved', resolved = issue.status === 'resolved' && producerFresh;
    const why = text(issue.resolutionEvidence?.reason, 40);
    let stage = 'unknown', reason = 'Waiting for remediation status';
    const component = issue.domain === 'maintenance' && Object.hasOwn(RELEASE_CODES, issue.code) ? RELEASE_CODES[issue.code] : null, compatibility = !!component;
    if (open && issue.severity === 'info' && !compatibility) { stage = 'review'; reason = 'Informational finding; no automatic cleanup'; }
    else if (!idle && response?.active && response?.attentionRequired === true) { stage = 'blocked'; reason = 'Repair completion is stalled; ownership is retained pending verification'; }
    else if (!idle && response?.active) { stage = 'working'; reason = response.workerState === 'uncertain' ? 'Existing repair retains ownership; completion is being checked' : 'Repair session in progress'; }
    else if (open && (issue.suppressed || (issue.domain === 'network' && state.maintenance?.[issue.scope]?.active))) {
      stage = 'maintenance'; reason = holdReason(state, issue);
    }
    else if (!idle && (response?.workerState === 'queued' || state?.outbox?.some((e) => e.issue?.id === issue.id))) {
      stage = 'queued'; reason = WAIT[response?.waitReason] || 'Awaiting delivery to the repair worker';
    } else if (resolved && why === 'verified_control_signal') {
      stage = 'classified'; reason = 'Verified scaling control; monitoring classification corrected, not a service recovery';
    } else if (resolved && Object.hasOwn(ENDED, why)) {
      stage = 'closed'; reason = why === 'superseded' && text(issue.resolutionEvidence.by, 100) ? `Superseded by ${text(issue.resolutionEvidence.by, 100)}` : ENDED[why];
    } else if (last?.outcome === 'blocked') {
      stage = resolved ? 'followup' : 'blocked';
      reason = stage === 'followup' ? 'Monitoring recovered; root-cause or verification follow-up remains' : 'Investigation completed; a blocker remains';
    }
    else if (resolved) {
      stage = last?.outcome === 'resolved' ? 'fixed' : 'recovered';
      reason = stage === 'fixed' ? 'Repair completed and monitoring verified recovery' : RECOVERED[why] || 'Monitoring observed recovery; no autonomous fix is claimed';
    } else if (idle && open) { stage = 'open'; reason = null; } // the banner says repair is off; the case says what is wrong
    else if (last) { stage = 'verifying'; reason = 'Response finished; monitoring has not verified recovery'; }
    else if (response?.workerState === 'cleared') reason = 'Removed from the queue by an administrator; it returns on the next monitoring update';
    // Recovered and closed cases leave the list after a day; the count stays.
    if (ENDED_STAGES.includes(stage) && now - Date.parse(issue.resolvedAt) > HISTORY_MS) { older++; return null; }
    const result = { id: issue.id, domain: issue.domain, network: issue.domain === 'network' ? issue.scope : null,
      title: compatibility ? `Check and fix dash-network-go compatibility with ${component} ${text(issue.evidence?.tag, 100) || 'release'}` : TITLES[issue.code] || 'Status issue', severity: issue.severity, stage, stageLabel: compatibility && stage === 'fixed' ? 'Compatibility verified' : LABEL[stage], reason,
      monitoring: issue.status, firstSeen: iso(issue.firstSeen), observedAt: iso(issue.lastSeen), resolvedAt: iso(issue.resolvedAt),
      startedAt: iso(response?.startedAt), finishedAt: iso(response?.finishedAt), retryAt: iso(response?.retryAt),
      pendingEvents: Number.isSafeInteger(response?.pendingEvents) ? response.pendingEvents : 0,
      lastOutcome: ['resolved', 'blocked', 'no_change'].includes(last?.outcome) ? last.outcome : null,
      stale: !producerFresh || (!idle && !workerFresh) };
    if (compatibility) {
      result.taskType = 'compatibility';
      if (stage === 'fixed') result.reason = 'Compatibility checks and code/test evidence recorded; no live network changes';
      if (stage === 'verifying') result.reason = 'Waiting for a complete version-bound compatibility report';
      if (stage === 'working') result.reason = 'Checking and fixing deployment-tool code in isolation; no live upgrade';
    }
    if (full) Object.assign(result, { target: text(issue.target, 512), scope: text(issue.scope, 512), code: issue.code,
      detail: null, link: null, group: null, ...describe(issue),
      summary: text(last?.summary), blocker: text(last?.blocker), nextAction: text(last?.nextAction),
      changes: Array.isArray(last?.changes) ? last.changes.filter((x) => typeof x === 'string').slice(0, 8).map((x) => x.slice(0, 300)) : [],
      runId: /^[a-f0-9]{24}$/.test(response?.runId) ? response.runId : null,
      lifecycle: text(response?.lifecycle), heldBy: Array.isArray(response?.heldBy) ? response.heldBy.map((x) => text(x, 512)).filter(Boolean) : [],
    });
    if (full && stage === 'classified') Object.assign(result, {
      summary: 'Fresh alarm semantics and scaling-policy association confirm a normal scale-in control. The warning classification has been corrected; no service repair is claimed.',
      blocker: null, nextAction: 'Continue collecting the control as informational; genuine or unclassified alarms remain actionable.',
    });
    return result;
  }).filter(Boolean);
  // Counted in full below; only the listing is limited.
  const ended = cases.filter((c) => ENDED_STAGES.includes(c.stage)).sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));
  const unlisted = new Set(ended.slice(HISTORY_MAX).map((c) => c.id));
  const order = ['working', 'blocked', 'open', 'maintenance', 'queued', 'verifying', 'followup', 'unknown', 'review', 'fixed', 'recovered', 'closed', 'classified'];
  cases.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || (b.observedAt || '').localeCompare(a.observedAt || ''));
  const counts = Object.fromEntries(order.map((stage) => [stage, cases.filter((c) => c.stage === stage).length]));
  // What monitoring says is wrong now, whatever the repair worker is doing.
  const openCases = cases.filter((c) => c.monitoring !== 'resolved');
  const faults = { open: openCases.length, ...Object.fromEntries(SEVERITY.map((s) => [s, openCases.filter((c) => c.severity === s).length])),
    held: counts.maintenance, recovered: counts.recovered + counts.fixed + counts.followup, closed: counts.closed + counts.classified,
    domains: Object.fromEntries(['network', 'ci', 'aws', 'maintenance'].map((d) => [d, openCases.filter((c) => c.domain === d).length])) };
  // Why dispatch cannot make progress. Details may name scopes: administrators only.
  const attention = stallReasons(state, now);
  // Administrator switch: what was requested here, and what the receiver has
  // acknowledged. Who and when stay with administrators.
  const lastKnown = state?.delivery?.receiver?.control || null, acknowledged = workerFresh ? lastKnown : null;
  const control = { supported: !!lastKnown, requested: requested?.dispatch === 'on' ? 'on' : 'off',
    applied: acknowledged ? (acknowledged.dispatch === 'on' ? 'on' : 'off') : null,
    // The last switch position the worker ever confirmed, however long ago.
    lastKnown: lastKnown ? (lastKnown.dispatch === 'on' ? 'on' : 'off') : null,
    pending: !!acknowledged && Number.isSafeInteger(requested?.seq) && Number.isSafeInteger(acknowledged.seq) && acknowledged.seq < requested.seq,
    localEnabled: acknowledged ? acknowledged.localEnabled === true : null,
    lastClear: Number.isFinite(acknowledged?.lastClear?.at) ? { at: iso(acknowledged.lastClear.at * 1000), count: Number.isSafeInteger(acknowledged.lastClear.count) ? acknowledged.lastClear.count : null } : null,
    ...(full ? { reset: requested?.recovered === true, changedAt: iso(requested?.updatedAt), changedBy: text(requested?.updatedBy, 39), clearedAt: iso(requested?.clearedAt), clearedBy: text(requested?.clearedBy, 39) } : {}) };
  return { schemaVersion: 1, public: !full, generatedAt: iso(state?.generatedAt), workerAt, control, idle,
    // An unreachable worker is expected while repair is switched off here.
    stalled: attention.length > 0 && !idle, attention: full ? attention : undefined, stalledSince: full ? iso(state?.stall?.since) : undefined,
    stale: !producerFresh || (!idle && !workerFresh), producerFresh, workerFresh,
    truncated: !idle && feed?.truncated === true && displayedIssues.some((i) => !observations.has(i.id)),
    activityHistory: { clearedAt: iso(state?.activityHistory?.clearedAt), hidden: visibleIssues.length - displayedIssues.length,
      ...(full ? { clearedBy: text(state?.activityHistory?.clearedBy, 39) } : {}) },
    history: { hours: HISTORY_MS / 3600_000, older, unlisted: unlisted.size },
    dispatch: !workerFresh ? 'unknown' : feed.enabled ? 'enabled' : 'paused',
    execution: !workerFresh || typeof feed.progress?.attentionRequired !== 'boolean' ? 'unknown' : feed.progress.attentionRequired ? 'stalled' : 'healthy',
    stalledRuns: workerFresh && Number.isSafeInteger(feed.progress?.stalledRuns) ? feed.progress.stalledRuns : null,
    maxActive: Number.isSafeInteger(feed?.maxActive) ? feed.maxActive : null,
    delivery: { pending: full ? state?.outbox?.length || 0 : null, failed: !!state?.delivery?.error, lastAckAt: iso(state?.delivery?.lastAckAt) },
    maintenance: Object.entries(state?.maintenance || {}).filter(([name]) => full || visible.has(name)).map(([network, value]) => ({ network, operations:full ? value.operations : undefined })),
    counts, faults, queuedEvents: full && Number.isSafeInteger(state?.delivery?.receiver?.counts?.queued)
      ? state.delivery.receiver.counts.queued : cases.reduce((sum, c) => sum + c.pendingEvents, 0), cases: cases.filter((c) => !unlisted.has(c.id)) };
}
