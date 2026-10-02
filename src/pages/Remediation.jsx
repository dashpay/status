import { useEffect, useState } from 'react';
import { ago, clock, useNow, useResource, useSession } from '../lib.js';
import { Empty, Err, Section } from '../ui.jsx';

const STAGES = { working: ['Working', 'lv-deploying'], queued: ['Queued', 'text-dim'], blocked: ['Blocked', 'lv-warn'],
  verifying: ['Verifying', 'lv-warn'], fixed: ['Verified fixed', 'lv-ok'], recovered: ['Recovered', 'lv-ok'],
  review: ['Review only', 'text-dim'], unknown: ['Awaiting status', 'text-dim'] };

export default function Remediation() {
  const session = useSession();
  const resource = useResource(`/api/remediation?view=${session.admin ? 'admin' : 'public'}`, (type) => type === 'remediation');
  const { data, error, reload } = resource;
  const now = useNow(1000);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  useEffect(() => { const timer = setInterval(reload, 15_000); return () => clearInterval(timer); }, [reload]);
  const cases = (data?.cases || []).filter((c) => (filter === 'all' || c.stage === filter)
    && [c.title, c.target, c.scope, c.network, c.domain, c.summary, c.blocker].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase()));
  const stale = data?.stale || (data?.workerAt && now - Date.parse(data.workerAt) > 180_000);
  return <div className="pt-5">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div><h1 className="text-xl font-semibold">Autonomous remediation</h1>
        <p className="text-dim text-[12px] mt-1">Network, CI and AWS issues · from detection to verified recovery</p></div>
      <button className="btn" onClick={reload}>Refresh</button>
    </div>
    <div className="mt-4"><Err error={error} /></div>
    {!data ? <Empty>Loading remediation status…</Empty> : <>
      <div className={`panel mt-3 px-3 py-3 text-[12px] ${stale ? 'border-warn/50' : ''}`} role="status">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className={`font-semibold ${stale ? 'lv-warn' : data.dispatch === 'enabled' ? 'lv-ok' : 'lv-warn'}`}>
            {stale ? 'Remediation status is stale or unavailable' : data.dispatch === 'enabled' ? 'Autonomous dispatch enabled' : 'New dispatch paused'}
          </span>
          {data.maxActive != null && <span className="text-dim">Up to {data.maxActive} independent repair sessions</span>}
          <span className="text-dim" title={clock(data.workerAt)}>Updated {ago(data.workerAt, now)} ago</span>
          <span className={data.delivery.failed ? 'lv-warn' : 'text-dim'}>{data.delivery.failed ? 'Alert delivery needs attention' : `Last alert delivery ${ago(data.delivery.lastAckAt, now)} ago`}</span>
        </div>
        {stale && <p className="mt-2 text-dim">These are last-known observations, not proof of current activity or recovery. The page will reconnect automatically.</p>}
        {data.public && <p className="mt-2 text-dim">Public view · target names and repair notes are available to signed-in administrators.</p>}
        {data.truncated && <p className="mt-2 lv-warn">The worker history is truncated; some response details are unavailable.</p>}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mt-3">
        {['queued', 'working', 'blocked', 'verifying', 'fixed'].map((stage) => <button key={stage} onClick={() => setFilter(stage)}
          className={`panel text-left px-3 py-3 ${filter === stage ? 'ring-1 ring-[#58a6ff]' : ''}`} aria-pressed={filter === stage}>
          <span className="label">{STAGES[stage][0]}</span><span className={`block mono text-2xl mt-1 ${STAGES[stage][1]}`}>{data.counts[stage]}</span>
        </button>)}
      </div>
      <p className="text-dim text-[11px] mt-2">Counts are unique issues. {data.queuedEvents} queued events may include repeat updates. A completed investigation is not a verified fix.</p>
      <Section title="Issue activity" right={<span className="text-dim text-[12px]">{cases.length} shown</span>}>
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <label className="sr-only" htmlFor="remediation-search">Filter remediation issues</label>
          <input id="remediation-search" className="input flex-1 min-w-40" placeholder="Filter issues…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="sr-only" htmlFor="remediation-state">Remediation state</label>
          <select id="remediation-state" className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All activity</option>{Object.entries(STAGES).map(([key, [label]]) => <option key={key} value={key}>{label} ({data.counts[key]})</option>)}
          </select>
        </div>
        {!cases.length ? <Empty>{data.cases.length ? 'No issues match this filter.' : stale ? 'No remediation data has arrived yet.' : 'No issues in the current monitoring history.'}</Empty>
          : <div className="space-y-2">{cases.map((item) => <Issue key={item.id} item={item} now={now} />)}</div>}
      </Section>
      <p className="text-dim text-[11px] mt-4">Verified fixed requires a completed repair and independent monitoring recovery. Recovered means monitoring improved without an attributed repair. Blocked work keeps its unresolved follow-up, even if symptoms improve.</p>
    </>}
  </div>;
}

function Issue({ item, now }) {
  const [label, color] = STAGES[item.stage];
  return <details className="panel group" data-issue-id={item.id}>
    <summary className="cursor-pointer list-none p-3 flex flex-wrap items-start gap-3">
      <span className={`tag shrink-0 ${color}`}>{label}</span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-semibold break-words">{item.title}</div>
        <div className="text-[11px] text-dim mt-1 break-all">{[item.domain.toUpperCase(), item.target || item.network, item.scope !== item.network ? item.scope : null].filter(Boolean).join(' · ')}</div>
        <p className="text-[12px] text-dim mt-1">{item.reason}</p>
        {item.summary && <p className="text-[12px] mt-2 break-words">{item.summary}</p>}
      </div>
      <div className="text-[11px] text-dim shrink-0 text-right">
        <div title={clock(item.observedAt)}>Observed {ago(item.observedAt, now)} ago</div>
        <div className="mt-1">Monitoring: {item.monitoring === 'resolved' ? 'recovered' : 'open'}</div>
        <div className="mt-2 group-open:hidden">Details ↓</div><div className="mt-2 hidden group-open:block">Details ↑</div>
      </div>
    </summary>
    <div className="border-t border-line px-3 py-3 text-[12px] space-y-3">
      {item.blocker && <div className="break-words"><span className="font-semibold lv-warn">Blocker: </span>{item.blocker}</div>}
      {item.nextAction && <div className="break-words"><span className="font-semibold">Next step: </span>{item.nextAction}</div>}
      {!!item.changes?.length && <div><div className="font-semibold mb-1">Changes recorded by the repairer</div><ul className="list-disc pl-5 space-y-1">{item.changes.map((change, i) => <li key={i} className="break-words">{change}</li>)}</ul></div>}
      {item.lifecycle && <p className="text-dim break-words">Completion check: {item.lifecycle}</p>}
      {!!item.heldBy?.length && <p className="text-dim break-all">Resource ownership: {item.heldBy.join(', ')}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-dim">
        {[['Detected', item.firstSeen], ['Repair started', item.startedAt], ['Response finished', item.finishedAt], ['Recovery observed', item.resolvedAt]].map(([title, value]) => <div key={title}><dt>{title}</dt><dd className="mono text-[11px]">{clock(value)}</dd></div>)}
      </dl>
      {item.retryAt && <p className="text-dim">Next eligible check: {clock(item.retryAt)}</p>}
      {item.lastOutcome && <p className="text-dim">Last response: {item.lastOutcome === 'resolved' ? 'repair reported complete' : item.lastOutcome === 'blocked' ? 'blocked' : 'no change required'}. Service recovery is verified separately.</p>}
      <div className="mono text-[10px] text-dim break-all">Issue {item.id}{item.runId && ` · Run ${item.runId}`}</div>
    </div>
  </details>;
}
