// Presentation only: never changes incidents, receipts, locks or dispatch.
import { TITLES } from './incidents.js';

const fresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now + 60_000 && now - Date.parse(at) <= 180_000;
const text = (value, size = 800) => typeof value === 'string' ? value.slice(0, size) : null;
const iso = (value) => value != null && value !== '' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const WAIT = { capacity: 'Waiting for a repair slot', resource_conflict: 'Waiting for the current resource owner',
  cooldown: 'Waiting for the scope cooldown', budget: 'Waiting for the dispatch budget', paused: 'New dispatch is paused', eligible: 'Ready for dispatch' };
const LABEL = { queued: 'Queued', working: 'Working', blocked: 'Blocked', followup: 'Recovered · follow-up', verifying: 'Verifying', fixed: 'Verified fixed', recovered: 'Recovered', classified: 'Monitoring corrected', review: 'Review only', unknown: 'Awaiting status' };

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
    const compatibility = issue.domain === 'maintenance' && issue.code === 'platform_release_compatibility';
    if (issue.severity === 'info' && !compatibility) { stage = 'review'; reason = 'Informational finding; no automatic cleanup'; }
    else if (response?.active) { stage = 'working'; reason = response.workerState === 'uncertain' ? 'Existing repair retains ownership; completion is being checked' : 'Repair session in progress'; }
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
    const result = { id: issue.id, domain: issue.domain, network: issue.domain === 'network' ? issue.scope : null,
      title: compatibility ? `Check and fix dash-network-go compatibility with Platform ${text(issue.evidence?.tag, 100) || 'release'}` : TITLES[issue.code] || 'Status issue', severity: issue.severity, stage, stageLabel: compatibility && stage === 'fixed' ? 'Compatibility verified' : LABEL[stage], reason,
      monitoring: issue.status, firstSeen: iso(issue.firstSeen), observedAt: iso(issue.lastSeen), resolvedAt: iso(issue.resolvedAt),
      startedAt: iso(response?.startedAt), finishedAt: iso(response?.finishedAt), retryAt: iso(response?.retryAt),
      pendingEvents: Number.isSafeInteger(response?.pendingEvents) ? response.pendingEvents : 0,
      lastOutcome: ['resolved', 'blocked', 'no_change'].includes(last?.outcome) ? last.outcome : null,
      stale: !producerFresh || !workerFresh };
    if (compatibility) {
      result.taskType = 'compatibility';
      if (stage === 'fixed') result.reason = 'Compatibility checks and code/test evidence recorded; no live network changes';
      if (stage === 'verifying') result.reason = 'Waiting for a complete version-bound compatibility report';
      if (stage === 'working') result.reason = 'Checking and fixing deployment-tool code in isolation; no live upgrade';
    }
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
  const order = ['working', 'queued', 'blocked', 'verifying', 'followup', 'unknown', 'review', 'fixed', 'recovered', 'classified'];
  cases.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || (b.observedAt || '').localeCompare(a.observedAt || ''));
  const counts = Object.fromEntries(order.map((stage) => [stage, cases.filter((c) => c.stage === stage).length]));
  return { schemaVersion: 1, public: !full, generatedAt: iso(state?.generatedAt), workerAt,
    stale: !producerFresh || !workerFresh, producerFresh, workerFresh, truncated: feed?.truncated === true,
    dispatch: !workerFresh ? 'unknown' : feed.enabled ? 'enabled' : 'paused',
    maxActive: Number.isSafeInteger(feed?.maxActive) ? feed.maxActive : null,
    delivery: { pending: full ? state?.outbox?.length || 0 : null, failed: !!state?.delivery?.error, lastAckAt: iso(state?.delivery?.lastAckAt) },
    counts, queuedEvents: cases.reduce((sum, c) => sum + c.pendingEvents, 0), cases };
}
