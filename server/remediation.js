// Presentation only: never changes incidents, receipts, locks or dispatch.
import { TITLES } from './incidents.js';
import { stallReasons } from './stall-alert.js';

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
const LABEL = { maintenance: 'Maintenance', queued: 'Queued', working: 'Working', blocked: 'Blocked', followup: 'Recovered · follow-up', verifying: 'Verifying', fixed: 'Verified fixed', recovered: 'Recovered', classified: 'Monitoring corrected', review: 'Review only', unknown: 'Awaiting status' };

export function remediationView(state, { full = false, visibleNetworks = [], now = Date.now() } = {}) {
  const feed = state?.delivery?.receiver?.remediation;
  const producerFresh = fresh(state?.generatedAt, now);
  const heartbeat = state?.delivery?.receiver?.workerAt;
  const workerAt = Number.isFinite(heartbeat) ? iso(heartbeat * 1000) : null;
  const workerFresh = feed?.schemaVersion === 1 && fresh(feed.generatedAt, now) && fresh(workerAt, now) && Array.isArray(feed.cases);
  const observations = new Map((Array.isArray(feed?.cases) ? feed.cases : []).map((c) => [c.issueId, c]));
  const visible = new Set(visibleNetworks);
  const cases = (state?.issues || []).filter((i) => full || i.domain !== 'network' || visible.has(i.scope)).map((issue) => {
    const response = observations.get(issue.id);
    const last = response?.lastResponse;
    let stage = 'unknown', reason = 'Waiting for remediation status';
    if (issue.severity === 'info') { stage = 'review'; reason = 'Informational finding; no automatic cleanup'; }
    else if (response?.active) { stage = 'working'; reason = response.workerState === 'uncertain' ? 'Existing repair retains ownership; completion is being checked' : 'Repair session in progress'; }
    else if (issue.suppressed || (issue.domain === 'network' && state.maintenance?.[issue.scope]?.active)) {
      stage = 'maintenance'; reason = holdReason(state, issue);
    }
    else if (response?.workerState === 'queued' || state?.outbox?.some((e) => e.issue?.id === issue.id)) {
      stage = 'queued'; reason = WAIT[response?.waitReason] || 'Awaiting delivery to the repair worker';
    } else if (issue.status === 'resolved' && producerFresh && issue.resolutionEvidence?.reason === 'verified_control_signal') {
      stage = 'classified'; reason = 'Verified scaling control; monitoring classification corrected, not a service recovery';
    } else if (last?.outcome === 'blocked') {
      stage = issue.status === 'resolved' && producerFresh ? 'followup' : 'blocked';
      reason = stage === 'followup' ? 'Monitoring recovered; root-cause or verification follow-up remains' : 'Investigation completed; a blocker remains';
    }
    else if (issue.status === 'resolved' && producerFresh) {
      stage = last?.outcome === 'resolved' ? 'fixed' : 'recovered';
      reason = stage === 'fixed' ? 'Repair completed and monitoring verified recovery' : 'Monitoring observed recovery; no autonomous fix is claimed';
    } else if (last) { stage = 'verifying'; reason = 'Response finished; monitoring has not verified recovery'; }
    else if (response?.workerState === 'abandoned') { stage = 'blocked'; reason = 'Repair attempt ended without a result; it is retried on the next monitoring update'; }
    else if (response?.workerState === 'cleared') reason = 'Removed from the queue by an administrator; it returns on the next monitoring update';
    const result = { id: issue.id, domain: issue.domain, network: issue.domain === 'network' ? issue.scope : null,
      title: TITLES[issue.code] || 'Status issue', severity: issue.severity, stage, stageLabel: LABEL[stage], reason,
      monitoring: issue.status, firstSeen: iso(issue.firstSeen), observedAt: iso(issue.lastSeen), resolvedAt: iso(issue.resolvedAt),
      startedAt: iso(response?.startedAt), finishedAt: iso(response?.finishedAt), retryAt: iso(response?.retryAt),
      pendingEvents: Number.isSafeInteger(response?.pendingEvents) ? response.pendingEvents : 0,
      lastOutcome: ['resolved', 'blocked', 'no_change'].includes(last?.outcome) ? last.outcome : null,
      stale: !producerFresh || !workerFresh };
    if (full) Object.assign(result, { target: text(issue.target, 512), scope: text(issue.scope, 512), code: issue.code,
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
  });
  const order = ['working', 'maintenance', 'queued', 'blocked', 'verifying', 'followup', 'unknown', 'review', 'fixed', 'recovered', 'classified'];
  cases.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || (b.observedAt || '').localeCompare(a.observedAt || ''));
  const counts = Object.fromEntries(order.map((stage) => [stage, cases.filter((c) => c.stage === stage).length]));
  // Why dispatch cannot make progress. Details may name scopes: administrators only.
  const attention = stallReasons(state, now);
  // Administrator switch: what was requested here, and what the receiver has
  // acknowledged. Who and when stay with administrators.
  const requested = state?.control || null, acknowledged = workerFresh ? state?.delivery?.receiver?.control || null : null;
  const control = { supported: !!state?.delivery?.receiver?.control, requested: requested?.dispatch === 'on' ? 'on' : 'off',
    applied: acknowledged ? (acknowledged.dispatch === 'on' ? 'on' : 'off') : null,
    pending: !!acknowledged && Number.isSafeInteger(requested?.seq) && Number.isSafeInteger(acknowledged.seq) && acknowledged.seq < requested.seq,
    localEnabled: acknowledged ? acknowledged.localEnabled === true : null,
    lastClear: Number.isFinite(acknowledged?.lastClear?.at) ? { at: iso(acknowledged.lastClear.at * 1000), count: Number.isSafeInteger(acknowledged.lastClear.count) ? acknowledged.lastClear.count : null } : null,
    ...(full ? { changedAt: iso(requested?.updatedAt), changedBy: text(requested?.updatedBy, 39), clearedAt: iso(requested?.clearedAt), clearedBy: text(requested?.clearedBy, 39) } : {}) };
  return { schemaVersion: 1, public: !full, generatedAt: iso(state?.generatedAt), workerAt, control,
    stalled: attention.length > 0, attention: full ? attention : undefined, stalledSince: full ? iso(state?.stall?.since) : undefined,
    stale: !producerFresh || !workerFresh, producerFresh, workerFresh, truncated: feed?.truncated === true,
    dispatch: !workerFresh ? 'unknown' : feed.enabled ? 'enabled' : 'paused',
    maxActive: Number.isSafeInteger(feed?.maxActive) ? feed.maxActive : null,
    delivery: { pending: full ? state?.outbox?.length || 0 : null, failed: !!state?.delivery?.error, lastAckAt: iso(state?.delivery?.lastAckAt) },
    maintenance: Object.entries(state?.maintenance || {}).filter(([name]) => full || visible.has(name)).map(([network, value]) => ({ network, operations:full ? value.operations : undefined })),
    counts, queuedEvents: cases.reduce((sum, c) => sum + c.pendingEvents, 0), cases };
}
