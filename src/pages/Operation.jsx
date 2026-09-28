import { useEffect, useRef, useState } from 'react';
import { api, ago, clock, useNow, useResource, useSession, short } from '../lib.js';
import { Empty, Err, Link, OpBadge, Section } from '../ui.jsx';

const ACTIVE = new Set(['queued', 'preparing', 'confirmed', 'running']);

export default function Operation({ name, id }) {
  const session = useSession();
  const now = useNow(1000);
  const { data: op, error, reload } = useResource(`/api/ops/${id}`, (t, d) => t === 'op' && d.id === id);
  const [actionError, setActionError] = useState(null);
  const [pending, setPending] = useState(false);
  if (!session.loaded) return null;
  if (!session.operatorOf?.includes(name)) return <div className="mt-6"><Empty>Operator access required.</Empty></div>;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!op) return <div className="mt-6 text-dim">Loading…</div>;
  const q = op.request;
  const act = async (type, body) => {
    setPending(true); setActionError(null);
    try { await api(`/api/ops/${id}/${type}`, { method: 'POST', body: body || {} }); setTimeout(reload, 1500); }
    catch (e) { setActionError(e); }
    finally { setTimeout(() => setPending(false), 1500); }
  };
  const review = op.review;
  const expiresIn = review ? 3600 - (now - Date.parse(review.preparedAt)) / 1000 : null;
  return (
    <div className="max-w-[1280px]">
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to={`/n/${name}/ops`} className="text-dim hover:text-fg">← operations</Link>
        <h1 className="text-[18px] font-semibold">{q.action}</h1>
        <OpBadge status={op.status} />
        <span className="text-dim mono text-[12px]">{op.id}</span>
        <div className="ml-auto flex gap-2">
          {['queued', 'review', 'confirmed', 'preparing', 'running'].includes(op.status) && <button className="btn btn-danger" disabled={pending} onClick={() => act('cancel')}>{op.status === 'running' ? 'Stop (SIGTERM dashnet)' : 'Cancel'}</button>}
          {['failed', 'interrupted', 'cancelled'].includes(op.status) && <button className="btn" disabled={pending} onClick={() => act('resume')}>{op.confirmedAt ? 'Resume same plan' : 'Prepare again'}</button>}
          {['succeeded', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(op.status) && <Link className="btn" to={`/n/${name}/deploy?action=${q.action}&nodes=${q.nodes.join(',')}&components=${(q.components || []).join(',')}`}>New from this</Link>}
        </div>
      </div>
      <div className="mt-2 panel px-3 py-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
        <div><span className="text-dim">network </span><span className="mono">{op.network}</span></div>
        <div><span className="text-dim">requested by </span>{op.actor.login} <span className="text-dim">{ago(op.createdAt, now)} ago</span></div>
        <div className="truncate"><span className="text-dim">nodes </span><span className="mono">{q.nodes.length > 6 ? `${q.nodes.slice(0, 6).join(', ')} +${q.nodes.length - 6}` : q.nodes.join(', ')}</span></div>
        <div className="truncate"><span className="text-dim">images </span><span className="mono">{Object.values(q.images || {}).join(' ') || (q.components || []).join(', ') || '—'}</span></div>
        {op.confirmedBy && <div><span className="text-dim">confirmed by </span>{op.confirmedBy.login} <span className="text-dim">{clock(op.confirmedAt)}</span></div>}
        {op.runner && <div><span className="text-dim">dashnet runner </span><span className="mono">{op.runner}</span></div>}
        {q.options?.observationWindow && <div><span className="text-dim">observation window </span><span className="mono">{q.options.observationWindow}</span></div>}
        {op.finishedAt && <div><span className="text-dim">finished </span>{clock(op.finishedAt)}</div>}
      </div>
      {op.error && <div className="mt-3"><Err error={{ message: op.error }} /></div>}
      {actionError && <div className="mt-3"><Err error={actionError} /></div>}

      <Section title="Steps">
        <div className="panel">
          {op.steps.length === 0 && <div className="px-3 py-2 text-dim">{op.status === 'queued' ? 'Waiting for the agent to pick this up (polls every second).' : 'No steps.'}</div>}
          {op.steps.map((s, i) => (
            <div key={i} className="px-3 py-1.5 border-b border-line last:border-0 flex items-center gap-3 text-[12px]">
              <span className={`dot bg-lv-${s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'down' : s.status === 'warn' ? 'warn' : 'info'} ${s.status === 'running' ? 'live' : ''}`} />
              <span className="w-[340px] shrink-0">{s.name}</span>
              <span className="text-dim mono truncate">{s.detail || ''}</span>
              <span className="ml-auto text-dim mono shrink-0">{s.finishedAt ? `${Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000)}s` : `${ago(s.startedAt, now)}…`}</span>
            </div>
          ))}
        </div>
      </Section>

      {op.progress && (
        <Section title="Rollout">
          <div className="panel px-3 py-2 text-[12px] flex flex-wrap gap-x-6 gap-y-1">
            <span>phase <span className="mono">{op.progress.phase}</span></span>
            {op.progress.current && <span>withdrawn <span className="mono lv-warn">{op.progress.current}</span></span>}
            <span>applied <span className="mono">{op.progress.completed.length}/{review?.targets?.length ?? '?'}</span> {op.progress.completed.length ? <span className="text-dim mono">({op.progress.completed.join(', ')})</span> : null}</span>
            {op.progress.waiting && <span className="lv-warn mono">health gate waiting: {op.progress.waiting}</span>}
          </div>
        </Section>
      )}

      {review && (
        <Section title={`Plan ${short(review.planId, 16)} · ${review.changes.length} container change(s)`} right={op.status === 'review' && <span className="text-dim text-[12px]">expires in {Math.max(0, Math.round(expiresIn / 60))} min</span>}>
          <div className="panel scroll-x">
            <table className="grid"><thead><tr><th>node</th><th>component</th><th>from</th><th>to (pinned)</th><th /></tr></thead>
              <tbody className="[&_tr]:!cursor-default">
                {review.changes.map((c, i) => (
                  <tr key={i}>
                    <td className="mono">{c.node}</td><td>{c.component}</td>
                    <td className="mono text-dim text-[11.5px]" title={c.fromDigest || ''}>{c.from?.replace(/@sha256:(.{12}).*/, '@$1…')}</td>
                    <td className="mono text-[11.5px]" title={c.to}>{c.requested ? <>{c.requested} </> : null}<span className="text-dim">{c.to.replace(/^.*@sha256:(.{12}).*/, '@$1…')}</span></td>
                    <td className="text-[11px]">{c.dependency ? <span className="lv-warn">dependency, same image</span> : ''}</td>
                  </tr>
                ))}
                {!review.changes.length && <tr><td colSpan={5} className="text-dim">No container changes: every selected component already runs this image.</td></tr>}
              </tbody>
            </table>
          </div>
          {op.status === 'review' && (
            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-primary" disabled={pending || !review.changes.length} onClick={() => act('confirm', { planId: review.planId })}>Confirm and {q.action === 'upgrade' ? 'upgrade' : 'restore'} {review.targets.length} node(s)</button>
              <span className="text-dim text-[12px]">Executes exactly this plan. One host at a time; stops at the first failed health gate. No automatic rollback.</span>
            </div>
          )}
        </Section>
      )}

      {op.result?.nodes && (
        <Section title={`Health gate · ${op.result.healthy ? 'healthy' : 'problems found'}`}>
          <div className="panel scroll-x"><table className="grid"><tbody className="[&_tr]:!cursor-default">
            {Object.entries(op.result.nodes).map(([node, r]) => <tr key={node}><td className="mono w-48">{node}</td><td className={r?.healthy ? 'lv-ok' : 'lv-down'}>{r ? r.status || (r.healthy ? 'healthy' : 'unhealthy') : 'no result'}</td><td className="mono text-dim !whitespace-normal">{r?.problems?.join('; ')}</td></tr>)}
          </tbody></table></div>
        </Section>
      )}

      <Section title="Log">
        <LiveLog id={id} initial={op.log} active={ACTIVE.has(op.status) || op.status === 'review'} />
      </Section>
    </div>
  );
}

function LiveLog({ id, initial, active }) {
  const [text, setText] = useState(initial?.text || '');
  const ref = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const es = new EventSource(`/api/ops/${id}/log?offset=${initial?.offset || 0}`);
    es.addEventListener('log', (e) => { const d = JSON.parse(e.data); setText((t) => (t + d.text).slice(-400_000)); });
    return () => es.close();
  }, [id, initial?.offset]);
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <div ref={ref} className="log h-[440px]" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {initial?.truncated && <div className="text-faint">… earlier output truncated</div>}
      {text || <span className="text-faint">no output yet</span>}
      {active && <span className="live text-accent">▍</span>}
    </div>
  );
}
