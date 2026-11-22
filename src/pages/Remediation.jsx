import { useEffect, useState } from 'react';
import { ago, api, clock, useNow, useResource, useSession } from '../lib.js';
import { Dot, Empty, Err, Section } from '../ui.jsx';

const STAGES = { open: ['Open', 'lv-warn'], maintenance: ['Maintenance', 'text-dim'], working: ['Working', 'lv-deploying'], queued: ['Queued', 'text-dim'], blocked: ['Blocked', 'lv-warn'],
  verifying: ['Verifying', 'lv-warn'], followup: ['Recovered · follow-up', 'text-dim'], fixed: ['Verified fixed', 'lv-ok'], recovered: ['Recovered', 'lv-ok'], closed: ['Closed', 'text-dim'],
  classified: ['Monitoring corrected', 'text-dim'], review: ['Review only', 'text-dim'], unknown: ['Awaiting status', 'text-dim'] };
const SEVERITY = { critical: ['down', 'critical'], warning: ['warn', 'warning'], info: ['info', 'informational'] };
// Views over the same list: what is wrong now comes first, history on request.
const VIEWS = { faults: 'Open faults', critical: 'Critical', warning: 'Warning', info: 'Review only', held: 'Held for maintenance', history: 'Recovered or closed', all: 'Everything' };
const inView = (c, view) => view === 'all' ? true
  : view === 'history' ? c.monitoring === 'resolved'
    : view === 'faults' ? c.monitoring !== 'resolved'
      : view === 'held' ? c.stage === 'maintenance'
        : Object.hasOwn(SEVERITY, view) ? c.monitoring !== 'resolved' && c.severity === view
          : c.stage === view;

export default function Remediation() {
  const session = useSession();
  const resource = useResource(`/api/remediation?view=${session.admin ? 'admin' : 'public'}`, (type) => type === 'remediation');
  const { data, error, reload } = resource;
  const now = useNow(1000);
  const [filter, setFilter] = useState('faults');
  const [search, setSearch] = useState('');
  useEffect(() => { const timer = setInterval(reload, 15_000); return () => clearInterval(timer); }, [reload]);
  const cases = (data?.cases || []).filter((c) => inView(c, filter)
    && [c.title, c.target, c.scope, c.network, c.domain, c.detail, c.summary, c.blocker].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase()));
  // A response kept on screen ages too: monitoring always, the worker only when
  // one is expected (with repair switched off and no worker, none is).
  const old = (at) => !!at && now - Date.parse(at) > 180_000;
  const stale = data?.stale || old(data?.generatedAt) || (!data?.idle && old(data?.workerAt));
  const f = data?.faults;
  return <div className="pt-5">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div><h1 className="text-xl font-semibold">Faults and remediation</h1>
        <p className="text-dim text-[12px] mt-1">Network, CI and AWS · what monitoring reports now, and what automatic repair is doing about it</p></div>
      <button className="btn" onClick={reload}>Refresh</button>
    </div>
    <div className="mt-4"><Err error={error} /></div>
    {!data ? <Empty>Loading remediation status…</Empty> : <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-3" data-fault-summary>
        {[['faults', 'Open faults', f.open, f.critical ? 'lv-down' : f.warning ? 'lv-warn' : f.open ? '' : 'lv-ok'], ['critical', 'Critical', f.critical, f.critical ? 'lv-down' : 'text-dim'],
          ['warning', 'Warning', f.warning, f.warning ? 'lv-warn' : 'text-dim'], ['info', 'Review only', f.info, 'text-dim'],
          ['held', 'Held', f.held, 'text-dim'], ['history', `Ended · ${data.history.hours} h`, f.recovered + f.closed, 'text-dim']].map(([view, label, value, color]) => <button key={view} onClick={() => setFilter(view)}
          className={`panel text-left px-3 py-2 ${filter === view ? 'ring-1 ring-[#58a6ff]' : ''}`} aria-pressed={filter === view}>
          <span className="label">{label}</span><span className={`block mono text-2xl mt-1 ${color}`}>{value}</span>
        </button>)}
      </div>
      <p className="text-dim text-[11px] mt-2">
        {['network', 'ci', 'aws', 'maintenance'].filter((d) => f.domains[d]).map((d) => `${d === 'ci' ? 'CI' : d === 'aws' ? 'AWS' : d === 'maintenance' ? 'Release tasks' : 'Networks'} ${f.domains[d]}`).join(' · ') || 'No open faults'}
        {' · '}<span title={clock(data.generatedAt)}>monitoring updated {ago(data.generatedAt, now)} ago</span>
      </p>
      {data.idle ? <div className={`panel mt-3 px-3 py-3 text-[12px] ${stale ? 'border-warn/50' : ''}`} role="status">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="font-semibold">{stale ? 'Monitoring is stale or unavailable' : 'Automatic repair is switched off'}</span>
          <span className="text-dim">Faults are listed as monitoring reports them. Nothing is queued or repaired automatically.</span>
        </div>
        {stale && <p className="mt-2 lv-warn">The fault list is the last one monitoring produced, not the current state.</p>}
        {data.control?.lastKnown === 'on' && <p className="mt-2 text-dim">The repair worker has not confirmed the switch-off: it last reported {ago(data.workerAt, now)} ago, with dispatch on, and has been unreachable since.</p>}
        {data.public && <p className="mt-2 text-dim">Public view · target names and details are available to signed-in administrators.</p>}
      </div> : <div className={`panel mt-3 px-3 py-3 text-[12px] ${stale || data.execution === 'stalled' ? 'border-warn/50' : ''}`} role="status">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className={`font-semibold ${stale || data.execution === 'stalled' ? 'lv-warn' : data.dispatch === 'enabled' ? 'lv-ok' : 'lv-warn'}`}>
            {stale ? 'Remediation status is stale or unavailable' : data.execution === 'stalled' ? 'Repair progress needs attention' : data.dispatch === 'enabled' ? 'Autonomous dispatch enabled'
              : data.control?.applied === 'off' ? 'Autonomous dispatch switched off' : 'New dispatch paused'}
          </span>
          {data.maxActive != null && <span className="text-dim">Up to {data.maxActive} independent repair sessions</span>}
          <span className="text-dim" title={clock(data.workerAt)}>Updated {ago(data.workerAt, now)} ago</span>
          <span className={data.delivery.failed ? 'lv-warn' : 'text-dim'}>{data.delivery.failed ? 'Alert delivery needs attention' : `Last alert delivery ${ago(data.delivery.lastAckAt, now)} ago`}</span>
        </div>
        {stale && <p className="mt-2 text-dim">These are last-known observations, not proof of current activity or recovery. The page will reconnect automatically.</p>}
        {!stale && data.execution === 'stalled' && <p className="mt-2 lv-warn">{data.stalledRuns} repair {data.stalledRuns === 1 ? 'session is' : 'sessions are'} holding capacity while completion is verified. Monitoring and alert delivery can remain healthy during a repair stall.</p>}
        {data.public && <p className="mt-2 text-dim">Public view · target names and repair notes are available to signed-in administrators.</p>}
        {data.truncated && <p className="mt-2 lv-warn">The worker history is truncated; some response details are unavailable.</p>}
      </div>}
      {session.admin && data.control && <Controls data={data} now={now} reload={reload} />}
      {/* Reasons come from the incident producer, so they stay visible when the
          worker's own status is stale: that is when they matter most. */}
      {data.stalled && data.producerFresh && <div className="panel mt-3 p-3 text-[12px] border-warn/50" role="alert"><b className="lv-warn">Remediation cannot make progress</b>
        {data.attention?.length ? <ul className="mt-1 text-dim">{data.attention.map((a, i) => <li key={i}>{a.detail}</li>)}</ul>
          : <span className="text-dim"> · details are available to signed-in administrators.</span>}</div>}
      {!!data.maintenance?.length && <div className="panel mt-3 p-3 text-[12px]"><b>Operation maintenance</b> · {data.maintenance.map((m) => m.network).join(', ')}. Expected downtime stays visible; automatic remediation is held for these networks until operations end and fresh monitoring arrives.</div>}
      {!data.idle && <>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 mt-3" data-repair-summary>
          {['queued', 'working', 'blocked', 'followup', 'verifying', 'fixed'].map((stage) => <button key={stage} onClick={() => setFilter(stage)}
            className={`panel text-left px-3 py-2 ${filter === stage ? 'ring-1 ring-[#58a6ff]' : ''}`} aria-pressed={filter === stage}>
            <span className="label">{STAGES[stage][0]}</span><span className={`block mono text-2xl mt-1 ${STAGES[stage][1]}`}>{data.counts[stage]}</span>
          </button>)}
        </div>
        <p className="text-dim text-[11px] mt-2">Counts are unique issues. {data.queuedEvents} queued events may include repeat updates. A completed investigation is not a verified fix.</p>
      </>}
      <Section title={VIEWS[filter] || STAGES[filter]?.[0] || 'Issues'} right={<span className="text-dim text-[12px]">{cases.length} shown</span>}>
        {data.activityHistory?.clearedAt && <p className="text-dim text-[12px] mb-3">Activity cleared {ago(data.activityHistory.clearedAt, now)} ago · {data.activityHistory.hidden} older entries hidden. New events and queued or active repairs remain visible. Monitoring findings are unchanged.</p>}
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <label className="sr-only" htmlFor="remediation-search">Filter remediation issues</label>
          <input id="remediation-search" className="input flex-1 min-w-40" placeholder="Filter issues…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="sr-only" htmlFor="remediation-state">Remediation state</label>
          <select id="remediation-state" className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {Object.entries(VIEWS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            {Object.entries(STAGES).map(([key, [label]]) => <option key={key} value={key}>{label} ({data.counts[key]})</option>)}
          </select>
        </div>
        {!cases.length ? <Empty>{data.cases.length ? (filter === 'faults' && !search ? 'No open faults.' : 'No issues match this filter.') : stale ? 'No remediation data has arrived yet.' : 'No issues in the current monitoring history.'}</Empty>
          : <div className="space-y-2">{grouped(cases).map((entry) => entry.items
            ? <Group key={`${entry.items[0].id}+`} entry={entry} now={now} />
            : <Issue key={entry.id} item={entry} now={now} />)}</div>}
      </Section>
      <p className="text-dim text-[11px] mt-4">
        Recovered means monitoring saw the fault end; Verified fixed also needs a completed repair. Closed means the case ended without a recovery: its target no longer exists, it aged out, or it was superseded.
        {' '}Recovered and closed cases are listed for {data.history.hours} hours, newest first{data.history.unlisted ? ` · ${data.history.unlisted} more from that period are counted but not listed` : ''}{data.history.older ? ` · ${data.history.older} older ${data.history.older === 1 ? 'one is' : 'ones are'} not listed` : ''}.
      </p>
    </>}
  </div>;
}

// The same job failing or waiting many times is one line that opens into its
// cases. The list arrives sorted by stage, so a group never mixes stages.
function grouped(cases) {
  const out = [], groups = new Map();
  for (const c of cases) {
    const key = c.group ? `${c.stage}|${c.code}|${c.group}` : null;
    if (!key) { out.push(c); continue; }
    if (!groups.has(key)) { const entry = { items: [] }; groups.set(key, entry); out.push(entry); }
    groups.get(key).items.push(c);
  }
  return out.map((entry) => (entry.items?.length === 1 ? entry.items[0] : entry));
}

// Administrator controls. A request is recorded at once and reaches the repair
// worker on the next signed heartbeat, so it is shown as pending until then.
function Controls({ data, now, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const c = data.control, on = c.requested === 'on';
  const run = async (path, body, question) => {
    if (!window.confirm(question)) return;
    setBusy(true); setError(null);
    try { await api(path, { method: 'POST', body }); reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <div className="panel mt-3 p-3 text-[12px]" data-remediation-controls>
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-semibold">Repair dispatch: <span className={on ? 'lv-ok' : 'text-dim'}>{on ? 'switched on' : 'switched off'}</span></span>
      <button className={`btn ${on ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !c.supported}
        onClick={() => run('/api/remediation/dispatch', { enabled: !on }, on
          ? 'Switch autonomous repair off? Repairs already in progress continue; nothing new is started.'
          : `Switch autonomous repair on? ${data.queuedEvents} queued event(s) become eligible for the repair agent.`)}>{on ? 'Switch off' : 'Switch on'}</button>
      <button className="btn btn-danger" disabled={busy || !c.supported}
        onClick={() => run('/api/remediation/clear', undefined, `Clear the repair queue? ${data.queuedEvents} queued event(s) are removed without being repaired. Repairs in progress and release compatibility tasks are not affected. Issues that are still open return on their next monitoring update.`)}>Clear queue</button>
      <button className="btn" disabled={busy}
        onClick={() => run('/api/remediation/activity/clear', undefined, 'Clear the displayed issue activity? Recovered and closed entries, and open ones monitoring no longer sees, are hidden without marking anything fixed. Faults monitoring still sees, queued work and active or held repairs remain visible; new events appear normally.')}>Clear activity</button>
      <span className="text-dim">{!c.supported ? 'The repair worker has not announced these controls yet; they become available once it runs this release.'
        : c.applied == null ? 'Worker acknowledgement is unavailable; the requested setting is not yet confirmed.'
          : c.pending || c.applied !== c.requested ? 'Waiting for the repair worker to acknowledge (about a minute).' : 'Acknowledged by the repair worker.'}</span>
    </div>
    <Err error={error} />
    {c.reset && <p className="mt-2 lv-warn">The saved switch setting was lost or was older than what the repair worker had applied, so dispatch was switched off. Switch it on again to resume.</p>}
    {c.localEnabled === false && <p className="mt-2 lv-warn">Dispatch is also disabled on the worker host itself (its ENABLED file is absent). This switch cannot override that.</p>}
    {(c.changedBy || c.lastClear || data.delivery.pending > 0) && <p className="mt-2 text-dim">
      {c.changedBy && <span title={clock(c.changedAt)}>Switch last changed by {c.changedBy} {ago(c.changedAt, now)} ago. </span>}
      {c.lastClear && <span title={clock(c.lastClear.at)}>Last clear removed {c.lastClear.count ?? 'an unknown number of'} event(s) {ago(c.lastClear.at, now)} ago{c.clearedBy ? ` (requested by ${c.clearedBy})` : ''}. </span>}
      {data.delivery.pending > 0 && <span>{data.delivery.pending} event(s) wait for the repair worker{data.delivery.lastAckAt ? `; it last acknowledged ${ago(data.delivery.lastAckAt, now)} ago` : ''}.</span>}
    </p>}
  </div>;
}

function Group({ entry, now }) {
  const first = entry.items[0], [label, color] = STAGES[first.stage];
  const latest = entry.items.reduce((a, c) => ((c.observedAt || '') > a ? c.observedAt : a), '');
  return <details className="panel group/set" data-issue-group={first.group}>
    <summary className="cursor-pointer list-none p-3 flex flex-wrap items-start gap-3">
      <span className={`tag shrink-0 ${color}`}>{label}</span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-semibold break-words"><Severity level={first.severity} />{first.title} <span className="mono text-dim">× {entry.items.length}</span></div>
        <div className="text-[12px] mt-1 break-words">{first.group}</div>
      </div>
      <div className="text-[11px] text-dim shrink-0 text-right">
        <div title={clock(latest)}>Latest {ago(latest, now)} ago</div>
        <div className="mt-2 group-open/set:hidden">Show {entry.items.length} ↓</div><div className="mt-2 hidden group-open/set:block">Hide ↑</div>
      </div>
    </summary>
    <div className="border-t border-line p-2 space-y-2">{entry.items.map((item) => <Issue key={item.id} item={item} now={now} />)}</div>
  </details>;
}

function Severity({ level }) {
  const [dot, title] = SEVERITY[level] || SEVERITY.info;
  return <Dot level={dot} title={title} className="mr-2 align-middle" />;
}

function Issue({ item, now }) {
  const [label, color] = STAGES[item.stage];
  return <details className="panel group" data-issue-id={item.id}>
    <summary className="cursor-pointer list-none p-3 flex flex-wrap items-start gap-3">
      <span className={`tag shrink-0 ${color}`}>{label}</span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-semibold break-words"><Severity level={item.severity} />{item.title}</div>
        <div className="text-[11px] text-dim mt-1 break-all">{[item.domain.toUpperCase(), item.target || item.network, item.scope !== item.network ? item.scope : null].filter(Boolean).join(' · ')}</div>
        {item.detail && <p className="text-[12px] mt-1 break-words" data-issue-detail>{item.detail}</p>}
        {item.reason && <p className="text-[12px] text-dim mt-1">{item.reason}</p>}
        {item.summary && <p className="text-[12px] mt-2 break-words">{item.summary}</p>}
      </div>
      <div className="text-[11px] text-dim shrink-0 text-right">
        <div title={clock(item.observedAt)}>Observed {ago(item.observedAt, now)} ago</div>
        <div className="mt-1" title={clock(item.firstSeen)}>{item.monitoring === 'resolved' ? `Ended ${ago(item.resolvedAt, now)} ago` : `Open for ${ago(item.firstSeen, now)}`}</div>
        <div className="mt-2 group-open:hidden">Details ↓</div><div className="mt-2 hidden group-open:block">Details ↑</div>
      </div>
    </summary>
    <div className="border-t border-line px-3 py-3 text-[12px] space-y-3">
      {item.link && <div><a className="link" href={item.link} target="_blank" rel="noreferrer noopener">Open the run on GitHub ↗</a></div>}
      {item.blocker && <div className="break-words"><span className="font-semibold lv-warn">Blocker: </span>{item.blocker}</div>}
      {item.nextAction && <div className="break-words"><span className="font-semibold">Next step: </span>{item.nextAction}</div>}
      {!!item.changes?.length && <div><div className="font-semibold mb-1">Changes recorded by the repairer</div><ul className="list-disc pl-5 space-y-1">{item.changes.map((change, i) => <li key={i} className="break-words">{change}</li>)}</ul></div>}
      {item.lifecycle && <p className="text-dim break-words">Completion check: {item.lifecycle}</p>}
      {!!item.heldBy?.length && <p className="text-dim break-all">Resource ownership: {item.heldBy.join(', ')}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-dim">
        {[['Detected', item.firstSeen], ['Repair started', item.startedAt], ['Response finished', item.finishedAt], [item.stage === 'closed' ? 'Closed' : 'Recovery observed', item.resolvedAt]].map(([title, value]) => <div key={title}><dt>{title}</dt><dd className="mono text-[11px]">{clock(value)}</dd></div>)}
      </dl>
      {item.retryAt && <p className="text-dim">Next eligible check: {clock(item.retryAt)}</p>}
      {item.lastOutcome && <p className="text-dim">Last response: {item.lastOutcome === 'resolved' ? 'repair reported complete' : item.lastOutcome === 'blocked' ? 'blocked' : 'no change required'}. Service recovery is verified separately.</p>}
      <div className="mono text-[10px] text-dim break-all">Issue {item.id}{item.runId && ` · Run ${item.runId}`}</div>
    </div>
  </details>;
}
