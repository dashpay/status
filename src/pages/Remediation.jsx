import { useEffect, useState } from 'react';
import { ago, api, clock, useNow, useResource, useSession } from '../lib.js';
import { Dot, Empty, Err, Section, Stat } from '../ui.jsx';

// Triage (server/triage.js): what monitoring reports, sorted by whether anybody
// needs to hear about it. New incidents wake the triage worker; what somebody
// filed as known, and what follows from it, stays out of the way.
const STATE = { new: ['New', 'lv-warn'], worse: ['Changed since', 'lv-warn'], working: ['Being fixed', 'lv-deploying'], fixed: ['Fixed · checking', 'lv-ok'],
  needs_you: ['Needs you', 'lv-down'], noted: ['Looked at', 'text-dim'], ended: ['Ended', 'text-dim'] };
const SEVERITY = { critical: ['down', 'critical'], warning: ['warn', 'warning'], info: ['info', 'informational'] };
// Top to bottom: what needs a person, what is waiting for the worker, what it is doing.
const ORDER = ['needs_you', 'worse', 'new', 'working', 'fixed', 'noted'];

function Severity({ level }) {
  const [dot, title] = SEVERITY[level] || SEVERITY.info;
  return <Dot level={dot} title={title} className="mr-2 align-middle" />;
}

function Fault({ issue }) {
  return <li className="break-words">
    <Severity level={issue.severity} />{issue.title}
    <span className="text-dim"> · {[issue.target, issue.scope !== issue.target ? issue.scope : null].filter(Boolean).join(' · ')}</span>
    {issue.detail && <span> · {issue.detail}</span>}
    {issue.link && <> · <a className="link" href={issue.link} target="_blank" rel="noreferrer noopener">run ↗</a></>}
    {issue.outgrown && <span className="lv-warn"> · worse than when it was filed as known</span>}
  </li>;
}

// "This is known" for one incident: a reason, and how much it takes with it.
function FileKnown({ incident, known, reload }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [wide, setWide] = useState(false);
  const [standing, setStanding] = useState(false);
  const [under, setUnder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (path, method, body) => {
    setBusy(true); setError(null);
    try { await api(path, { method, body }); setOpen(false); setReason(''); reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!open) return <button className="btn" onClick={() => setOpen(true)} data-known-open>Known…</button>;
  return <div className="bg-panel-2 border border-line rounded p-3 space-y-2" data-known-form>
    <label className="label block" htmlFor={`reason-${incident.id}`}>Why is this known?</label>
    <input id={`reason-${incident.id}`} className="input w-full" maxLength={500} placeholder="What it is and why nothing needs doing" value={reason} onChange={(e) => setReason(e.target.value)} />
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
      {incident.canWiden && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={wide} onChange={(e) => setWide(e.target.checked)} />and whatever else it causes on {incident.title}</label>}
      <label className="inline-flex items-center gap-1.5" title="Otherwise the entry is dropped once nothing has matched it for a day, and the same fault is new again"><input type="checkbox" checked={standing} onChange={(e) => setStanding(e.target.checked)} />keep after it recovers</label>
    </div>
    <div className="flex flex-wrap gap-2 items-center">
      <button className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => run('/api/remediation/known', 'POST', { incident: incident.id, reason, wide, standing })}>File as known</button>
      {!!known.length && <>
        <span className="text-dim text-[12px]">or it follows from</span>
        <select className="input" aria-label="Known entry this follows from" value={under} onChange={(e) => setUnder(e.target.value)}>
          <option value="">choose…</option>
          {known.map((k) => <option key={k.id} value={k.id}>{k.title}</option>)}
        </select>
        <button className="btn" disabled={busy || !under} onClick={() => run(`/api/remediation/known/${under}`, 'PATCH', { incident: incident.id, wide })}>Put under it</button>
      </>}
      <button className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>
    <Err error={error} />
  </div>;
}

function Incident({ item, known, now, admin, reload }) {
  const [label, color] = STATE[item.state] || STATE.new, l = item.ledger;
  const faults = item.issues.length, held = item.held?.length || 0;
  return <details className="panel group" data-incident={item.id}>
    <summary className="cursor-pointer list-none p-3 flex flex-wrap items-start gap-3">
      <span className={`tag shrink-0 ${color}`}>{label}</span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-semibold break-words"><Severity level={item.severity} />{item.title} <span className="text-dim font-normal">· {item.kind}{faults !== 1 && !(held && !faults) ? ` · ${faults} faults` : ''}{held ? ` · ${held} held` : ''}</span></div>
        {l?.summary ? <p className="text-[12px] mt-1 break-words">{l.summary}</p>
          : <p className="text-[12px] text-dim mt-1 break-words">{item.issues.slice(0, 3).map((i) => [i.target, i.detail || i.title].filter(Boolean).join(': ')).join(' · ')}{faults > 3 ? ` · and ${faults - 3} more` : ''}</p>}
        {item.clearSince && <p className="text-[12px] lv-ok mt-1" title={clock(item.clearSince)}>Monitoring sees no fault since {ago(item.clearSince, now)} ago; it closes after an hour clear.</p>}
      </div>
      <div className="text-[11px] text-dim shrink-0 text-right">
        <div title={clock(item.openedAt)}>Open for {ago(item.openedAt, now)}</div>
        {l && <div className="mt-1" title={clock(l.at)}>{l.by} · {ago(l.at, now)} ago</div>}
        <div className="mt-2 group-open:hidden">Details ↓</div><div className="mt-2 hidden group-open:block">Details ↑</div>
      </div>
    </summary>
    <div className="border-t border-line px-3 py-3 text-[12px] space-y-3">
      {faults ? <ul className="space-y-1">{item.issues.map((i) => <Fault key={i.id} issue={i} />)}</ul> : !held && <p className="text-dim">No fault of this incident is open right now.</p>}
      {held > 0 && <div data-incident-held><div className="label mb-1">Held for a change in progress · not counted until it ends</div><ul className="space-y-1">{item.held.map((i) => <Fault key={i.id} issue={i} />)}</ul></div>}
      {l && <p className="text-dim">{STATE[l.state]?.[0] || l.state} since {clock(l.since || l.at)}{l.slack ? ' · reported in Slack' : ''}{l.thread ? ` · worker thread ${l.thread}` : ''}{l.revision < item.revision ? ' · the incident got worse, or something else failed, after this report' : ''}</p>}
      {admin && faults + held > 0 && <FileKnown incident={item} known={known} reload={reload} />}
      <div className="mono text-[10px] text-dim break-all">Incident {item.id} · revision {item.revision} · {item.seen} fault{item.seen === 1 ? '' : 's'} seen in all</div>
    </div>
  </details>;
}

function Known({ entry, now, admin, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    if (!window.confirm(`Remove "${entry.title}" from the known list? Whatever it still matches becomes new, and the triage worker is woken for it.`)) return;
    setBusy(true); setError(null);
    try { await api(`/api/remediation/known/${entry.id}`, { method: 'DELETE' }); reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const open = entry.issues.length, follows = entry.expected.length;
  const pattern = (p) => [p.domain, p.scope, p.target, p.code, p.name].filter((v) => v !== undefined).join(' / ');
  return <details className="panel group" data-known={entry.id}>
    <summary className="cursor-pointer list-none p-3 flex flex-wrap items-start gap-3">
      <span className="tag shrink-0 text-dim">Known</span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="font-semibold break-words">{entry.title}</div>
        <p className="text-[12px] mt-1 break-words">{entry.reason}</p>
      </div>
      <div className="text-[11px] text-dim shrink-0 text-right">
        <div>{open ? `${open} open now` : 'nothing open now'}{follows ? ` · ${follows} expected` : ''}</div>
        <div className="mt-1" title={clock(entry.at)}>{entry.by} · {ago(entry.at, now)} ago</div>
        <div className="mt-1">{entry.standing ? 'kept' : entry.idleSince ? `lapses ${ago(entry.idleSince, now)} into a day idle` : 'until it has been gone a day'}{entry.until ? ` · until ${clock(entry.until)}` : ''}</div>
      </div>
    </summary>
    <div className="border-t border-line px-3 py-3 text-[12px] space-y-3">
      {open > 0 && <ul className="space-y-1">{entry.issues.map((i) => <Fault key={i.id} issue={i} />)}</ul>}
      {follows > 0 && <div><div className="label mb-1">Expected because of it</div><ul className="space-y-1">{entry.expected.map((i) => <Fault key={i.id} issue={i} />)}</ul></div>}
      <div className="text-dim"><div className="label mb-1">Matches</div>
        <ul className="mono text-[11px] space-y-0.5 break-all">{entry.match.map((p, i) => <li key={`m${i}`}>{pattern(p)} <span className="text-dim">· up to {p.severity}</span></li>)}
          {entry.covers.map((p, i) => <li key={`c${i}`}>{pattern(p)} <span className="text-dim">· expected · up to {p.severity}</span></li>)}</ul></div>
      {admin && <div className="flex flex-wrap gap-2 items-center"><button className="btn btn-danger" disabled={busy} onClick={remove}>Remove</button><Err error={error} /></div>}
    </div>
  </details>;
}

// A pile nobody acts on: held for an operation, informational, or (without an
// account) anything at all, as counts.
function Groups({ groups }) {
  return <div className="panel divide-y divide-line">{groups.map((g) => <details key={g.key} className="group">
    <summary className={`list-none px-3 py-2 flex flex-wrap items-center gap-3 text-[12px] ${g.issues ? 'cursor-pointer' : ''}`}>
      <span className="min-w-0 flex-1 break-words"><Severity level={g.severity} />{g.title} <span className="text-dim">· {g.kind}</span></span>
      <span className="mono text-dim">{g.issues ? g.issues.length : g.count}</span>
    </summary>
    {g.issues && <ul className="px-3 pb-3 text-[12px] space-y-1">{g.issues.map((i) => <Fault key={i.id} issue={i} />)}</ul>}
  </details>)}</div>;
}

// Whether the worker repairs, or only announces. An administrator's switch.
function Switch({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const on = data.fixing === 'on';
  const flip = async () => {
    if (!window.confirm(on ? 'Switch agent repair off? New incidents are still announced; nothing is repaired without a person. A repair already running finishes.'
      : 'Switch agent repair on? The triage worker then repairs what it is allowed to (testnet and devnet nodes, our own CI runners, pull requests for a person to approve) and reports the rest.')) return;
    setBusy(true); setError(null);
    try { await api('/api/remediation/dispatch', { method: 'POST', body: { enabled: !on } }); reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <><button className={`btn ${on ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={flip} data-repair-switch>{on ? 'Switch off' : 'Switch on'}</button><Err error={error} /></>;
}

export default function Remediation() {
  const session = useSession();
  const { data, error, reload } = useResource(`/api/remediation/triage?view=${session.admin ? 'admin' : 'public'}`, (type) => type === 'remediation');
  const now = useNow(1000);
  useEffect(() => { const timer = setInterval(reload, 15_000); return () => clearInterval(timer); }, [reload]);
  if (!data?.counts) return <div className="pt-5"><h1 className="text-xl font-semibold">Faults and triage</h1><div className="mt-4">{error ? <Err error={error} /> : <Empty>Loading triage…</Empty>}</div></div>;
  const c = data.counts, on = data.fixing === 'on', admin = !!session.admin && !data.public;
  const incidents = [...data.incidents].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const waiting = incidents.filter((i) => ['new', 'worse'].includes(i.state)), yours = incidents.filter((i) => i.state === 'needs_you');
  const active = incidents.filter((i) => ['working', 'fixed', 'noted'].includes(i.state));
  const worker = data.worker?.seenAt;
  return <div className="pt-5">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div><h1 className="text-xl font-semibold">Faults and triage</h1>
        <p className="text-dim text-[12px] mt-1">Network, CI and AWS · what is new, what is being done about it, and what is already known</p></div>
      <button className="btn" onClick={reload}>Refresh</button>
    </div>
    <div className="mt-4"><Err error={error} /></div>
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-3" data-triage-summary>
      <Stat label="New" value={c.new} level={c.new ? 'warn' : 'ok'} sub={c.new ? 'not looked at yet' : 'nothing new'} />
      <Stat label="Needs you" value={data.public ? '—' : c.needsYou} level={c.needsYou ? 'down' : undefined} sub="the agent could not" />
      <Stat label="Being fixed" value={data.public ? '—' : c.working + c.fixed} level={c.working ? 'deploying' : undefined} sub={c.fixed ? `${c.fixed} fixed, being checked` : 'by the agent'} />
      <Stat label="Known" value={c.known} sub="filed with a reason" />
      <Stat label="Expected" value={c.expected} sub="follows from a known one" />
      <Stat label="Held · review" value={`${c.held} · ${c.review}`} sub="operations · informational" />
    </div>
    <div className={`panel mt-3 px-3 py-3 text-[12px] ${data.stale ? 'border-warn/50' : ''}`} role="status">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="font-semibold">Agent repair: <span className={on ? 'lv-ok' : 'text-dim'}>{on ? 'switched on' : 'switched off'}</span></span>
        {admin && <Switch data={data} reload={reload} />}
        <span className="text-dim">{on ? 'New incidents are looked at, repaired where the agent may, and reported when it may not.' : 'New incidents are still looked at and announced. Nothing is repaired without a person.'}</span>
      </div>
      <p className="mt-2 text-dim">
        <span title={clock(data.generatedAt)}>{c.faults} open fault{c.faults === 1 ? '' : 's'} · monitoring updated {ago(data.generatedAt, now)} ago</span>
        {c.settling > 0 && <span title={`A fault counts once it has lasted ${Math.round(data.settleSeconds / 60)} minutes without a break: one failed sample of a probe is not an incident`} data-settling> · {c.settling} seen for under {Math.round(data.settleSeconds / 60)} min, not counted yet</span>}
        {!data.public && <span title={worker ? clock(worker) : undefined}> · triage worker {worker ? `last asked ${ago(worker, now)} ago` : 'has not asked since the console started'}</span>}
      </p>
      {data.stale && <p className="mt-2 lv-warn">Monitoring is stale or unavailable: this is the last list it produced, and nothing is opened, closed or announced until it reports again.</p>}
      {data.public && <p className="mt-2 text-dim">Public view: counts by network and area. Hosts, reasons and reports are for signed-in administrators.</p>}
    </div>
    {!!data.maintenance?.length && <div className="panel mt-3 p-3 text-[12px]" data-operation-maintenance><b>Operation maintenance</b> · {data.maintenance.map((m) => m.network).join(', ')}. Expected downtime stays visible; faults on these networks are held, not announced or repaired, until the operation ends and fresh monitoring arrives.</div>}

    {data.public ? <>
      <Section title="New" right={<span className="text-dim text-[12px]">{data.new.length}</span>}>{data.new.length ? <Groups groups={data.new} /> : <Empty>Nothing new.</Empty>}</Section>
      {!!data.knownOpen?.length && <Section title="Known or expected"><Groups groups={data.knownOpen} /></Section>}
    </> : <>
      {!!yours.length && <Section title="Needs you" right={<span className="text-dim text-[12px]">{yours.length}</span>}>
        <div className="space-y-2">{yours.map((i) => <Incident key={i.id} item={i} known={data.known} now={now} admin={admin} reload={reload} />)}</div></Section>}
      <Section title="New" right={<span className="text-dim text-[12px]">{waiting.length}</span>}>
        {waiting.length ? <div className="space-y-2">{waiting.map((i) => <Incident key={i.id} item={i} known={data.known} now={now} admin={admin} reload={reload} />)}</div>
          : <Empty>{data.stale ? 'No triage data has arrived yet.' : 'Nothing new.'}</Empty>}</Section>
      {!!active.length && <Section title="Looked at by the agent" right={<span className="text-dim text-[12px]">{active.length}</span>}>
        <div className="space-y-2">{active.map((i) => <Incident key={i.id} item={i} known={data.known} now={now} admin={admin} reload={reload} />)}</div></Section>}
      <Section title="Known" right={<span className="text-dim text-[12px]">{data.known.length} entr{data.known.length === 1 ? 'y' : 'ies'} · {c.known} open · {c.expected} expected</span>}>
        {data.known.length ? <div className="space-y-2">{data.known.map((k) => <Known key={k.id} entry={k} now={now} admin={admin} reload={reload} />)}</div>
          : <Empty>Nothing is filed as known. Open an incident and choose Known… to file it with a reason.</Empty>}</Section>
    </>}
    {!!data.held.length && <Section title="Held for an operation" right={<span className="text-dim text-[12px]">{c.held}</span>}><Groups groups={data.held} /></Section>}
    {!!data.review.length && <Section title="Review only" right={<span className="text-dim text-[12px]">{c.review}</span>}><Groups groups={data.review} /></Section>}
    {!!data.ended.length && <Section title="Ended this week" right={<span className="text-dim text-[12px]">{data.ended.length} newest</span>}>
      <div className="panel divide-y divide-line">{data.ended.map((e) => <div key={e.id} className="px-3 py-2 text-[12px] flex flex-wrap items-start gap-3">
        <span className={`tag shrink-0 ${e.outcome === 'filed' ? 'text-dim' : 'lv-ok'}`}>{e.outcome === 'filed' ? 'Filed as known' : e.ledger?.state === 'fixed' ? 'Fixed' : 'Recovered'}</span>
        <span className="min-w-0 flex-1 break-words"><Severity level={e.severity} />{e.title} <span className="text-dim">· {e.kind}</span>{e.ledger?.summary && <span className="text-dim"> · {e.ledger.summary}</span>}</span>
        <span className="text-dim text-[11px]" title={clock(e.endedAt)}>{ago(e.endedAt, now)} ago</span>
      </div>)}</div></Section>}
    <p className="text-dim text-[11px] mt-4">
      An incident is everything new on one network, CI host, repository queue, failing job or AWS resource. It opens once, however many faults join it, and closes when monitoring has seen none of them for an hour.
      Fixed means the agent changed something; only monitoring says it worked. A known entry lapses when nothing has matched it for a day, unless it is kept.
    </p>
  </div>;
}
