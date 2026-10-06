import { useEffect, useRef, useState } from 'react';
import { api, ago, canOperate, canSee, clock, span, useNow, useResource, useSession, short } from '../lib.js';
import { Empty, Err, Link, OpBadge, Section } from '../ui.jsx';

const ACTIVE = new Set(['queued', 'preparing', 'confirmed', 'running']);

export default function Operation({ name, id }) {
  const session = useSession();
  const now = useNow(1000);
  const { data: op, error, reload } = useResource(`/api/ops/${id}`, (t, d) => t === 'op' && (d.id === id || d.id === '*'));
  const [actionError, setActionError] = useState(null);
  const [pending, setPending] = useState(false);
  if (!session.loaded) return null;
  if (!canSee(session, name)) return <div className="mt-6"><Empty>Access to this network required.</Empty></div>;
  // Lifecycle operations (devnet create/delete/services, Platform reset) are admin-only.
  const lifecycle = ['create-devnet', 'delete-devnet', 'devnet-services', 'devnet-platform', 'platform-reset'].includes(op?.request?.action);
  const operator = lifecycle ? !!session.admin : canOperate(session, name);
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
        {operator && <div className="ml-auto flex gap-2">
          {['queued', 'review', 'confirmed', 'preparing', 'running'].includes(op.status) && <button className="btn btn-danger" disabled={pending} onClick={() => act('cancel')}>{op.status === 'running' ? 'Stop (SIGTERM dashnet)' : 'Cancel'}</button>}
          {['failed', 'interrupted', 'cancelled'].includes(op.status) && <button className="btn" disabled={pending} onClick={() => act('resume')}>{op.confirmedAt ? (q.action === 'create-devnet' ? 'Resume creation' : 'Resume same plan') : 'Prepare again'}</button>}
          {!q.action.endsWith('-devnet') && ['succeeded', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(op.status) && <Link className="btn" to={`/n/${name}/deploy?action=${q.action}&nodes=${q.nodes.join(',')}&components=${(q.components || []).join(',')}`}>New from this</Link>}
        </div>}
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
            {op.progress.starting && <span className="lv-warn mono">waiting for node to start: {op.progress.starting}</span>}
            {op.progress.waiting && <span className="lv-warn mono">waiting for fleet health: {op.progress.waiting}</span>}
          </div>
        </Section>
      )}

      {review?.kind === 'create-devnet' && <CreateReview op={op} review={review} operator={operator} pending={pending} act={act} expiresIn={expiresIn} />}
      {op.result?.platformOperation && (
        <Section title="Platform">
          <div className="panel p-3 text-[12px]">Core is ready. Platform starts automatically as soon as the quorums form: <Link to={`/n/${name}/ops/${op.result.platformOperation}`} className="mono">{short(op.result.platformOperation, 12)}</Link></div>
        </Section>
      )}
      {review?.kind === 'devnet-platform' && (
        <Section title="Start Platform">
          <div className="panel p-3 text-[12px]">Queued by the creation of this devnet (<Link to={`/n/${name}/ops/${review.createdBy}`} className="mono">{short(review.createdBy, 12)}</Link>): waits for the quorums, starts Drive, Tenderdash and DAPI on every validator, then brings up the Platform Explorer and checks the fleet.</div>
        </Section>
      )}
      {review?.kind === 'platform-reset' && <ResetReview op={op} review={review} operator={operator} pending={pending} act={act} />}
      {op.stages && <Stages op={op} />}
      {review?.kind === 'devnet-services' && <ServicesReview op={op} review={review} operator={operator} pending={pending} act={act} />}
      {review?.kind === 'delete-devnet' && <DeleteReview op={op} review={review} operator={operator} pending={pending} act={act} />}
      {review && !review.kind && (
        <Section title={`Plan ${short(review.planId, 16)} · ${review.scope ? `${review.scope} · ` : ''}${review.changes.length} container change(s)`} right={op.autoConfirmed ? <span className="text-dim text-[12px]">confirmed automatically for {op.confirmedBy?.login} (run as soon as ready)</span> : op.status === 'review' && <span className="text-dim text-[12px]">expires in {Math.max(0, Math.round(expiresIn / 60))} min</span>}>
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
          {review.then?.length > 0 && (
            <div className="panel mt-2 px-3 py-2 text-[12px]">
              <span className="text-dim">Then, once this rollout is healthy: </span>
              {review.then.map((t, i) => <span key={i} className="mr-3"><span className="font-medium">{t.scope}</span> {Object.entries(t.images).map(([c, v]) => <span key={c} className="mono ml-1">{c} {v.split(':').pop()}</span>)}</span>)}
              <span className="text-dim"> — planned from the upgraded network, then run the same way.</span>
            </div>
          )}
          {op.status === 'review' && operator && (
            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-primary" disabled={pending || !review.changes.length} onClick={() => act('confirm', { planId: review.planId })}>Confirm and {q.action === 'upgrade' ? 'upgrade' : 'restore'} {review.targets.length} node(s)</button>
              <span className="text-dim text-[12px]">Executes exactly this plan. One host at a time; stops at the first failed health check. No automatic rollback.</span>
            </div>
          )}
        </Section>
      )}

      {op.result?.nodes && (
        <Section title={`Health check · ${op.result.healthy ? 'healthy' : 'problems found'}`}>
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
  // Opened once per operation from the first loaded offset; op refreshes do not reconnect it.
  const offset = useRef(initial?.offset || 0);
  useEffect(() => {
    let es, timer, closed = false;
    const open = () => {
      es = new EventSource(`/api/ops/${id}/log?offset=${offset.current}`);
      es.addEventListener('log', (e) => { const d = JSON.parse(e.data); offset.current = d.offset; setText((t) => (t + d.text).slice(-400_000)); });
      es.onerror = () => { if (es.readyState === EventSource.CLOSED && !closed) timer = setTimeout(open, 3000); };
    };
    open();
    return () => { closed = true; clearTimeout(timer); es?.close(); };
  }, [id]);
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <div ref={ref} className="log h-[440px]" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {initial?.truncated && <div className="text-faint">… earlier output truncated</div>}
      {text || <span className="text-faint">no output yet</span>}
      {active && <span className="live text-accent">▍</span>}
    </div>
  );
}

function CreateReview({ op, review, operator, pending, act, expiresIn }) {
  const e = review.estimate || {};
  return (
    <>
      <Section title={`Devnet ${op.network} · ${review.instances} instances`} right={op.status === 'review' && <span className="text-dim text-[12px]">expires in {Math.max(0, Math.round(expiresIn / 60))} min</span>}>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="panel">
            <table className="grid"><thead><tr><th>group</th><th>type</th><th>arch</th><th className="num">count</th></tr></thead><tbody className="[&_tr]:!cursor-default">
              {review.footprint.map((f) => <tr key={f.group}><td>{f.group}</td><td className="mono">{f.type}</td><td className="mono">{f.arch}</td><td className="num">{f.count}</td></tr>)}
            </tbody></table>
            <div className="px-3 py-2 text-[12px] border-t border-line">
              {review.storageGiB} GiB gp3 · BYOIP public IPv4 ({review.network.ipamPool}) · estimate <span className="mono">${e.hourly}/h</span>, ≈ <span className="mono">${e.monthly}/month</span> incl. storage
            </div>
          </div>
          <div className="panel px-3 py-2 text-[12px] space-y-1">
            <div><span className="text-dim">Core chain </span><span className="mono">{review.coreNetwork}</span> · <span className="text-dim">Platform </span><span className="mono">{review.platformChainId}</span> · <span className="text-dim">protocol </span><span className="mono">{review.protocol}</span>{review.platformEpochSeconds ? <> · <span className="text-dim">epoch </span><span className="mono">{span(review.platformEpochSeconds)}</span></> : null}{review.blockTimeSeconds ? <> · <span className="text-dim">Core block </span><span className="mono">{review.blockTimeSeconds} s</span></> : null}</div>
            <div><span className="text-dim">Placement </span><span className="mono">{review.network.vpc} / {review.network.subnet} / {review.network.securityGroups.join(',')}</span></div>
            <div><span className="text-dim">AMIs (Ubuntu 24.04) </span><span className="mono">{Object.entries(review.amis).map(([a, id]) => `${a} ${id}`).join(' · ')}</span></div>
            <div className="pt-1 text-dim">Services on the wallet host</div>
            {Object.entries(review.dns).map(([k, v]) => <div key={k} className="mono">{k}: https://{v.host}</div>)}
            <div className="text-dim">insight <span className="mono text-fg">{review.services.insightImage}</span> · quorum server <span className="mono text-fg">{review.services.quorumServer}</span> · explorer <span className="mono text-fg">{review.services.explorerVersion}</span> · faucet <span className="mono text-fg">{review.services.faucetRef.slice(0, 12)}</span>, {review.services.faucetAmount} per request, {review.services.faucetFunding} funded</div>
          </div>
        </div>
        <div className="panel scroll-x mt-3">
          <table className="grid"><thead><tr><th>component</th><th>requested</th><th>pinned per architecture</th></tr></thead><tbody className="[&_tr]:!cursor-default">
            {Object.entries(review.images).map(([c, v]) => <tr key={c}><td>{c}</td><td className="mono">{v.ref}</td><td className="mono text-dim text-[11.5px]">{Object.entries(v.digests).map(([a, dg]) => `${a} ${dg.slice(7, 19)}…`).join('  ') || '—'}</td></tr>)}
          </tbody></table>
        </div>
      </Section>
      {op.status === 'review' && operator && (
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-primary" disabled={pending} onClick={() => act('confirm', { planId: review.planId })}>Create {op.network} (starts billable EC2)</button>
          <span className="text-dim text-[12px]">Runs provision → bootstrap → deploy → services → health check (typically 60–90 min). Each stage resumes if interrupted.</span>
        </div>
      )}
    </>
  );
}

function DeleteReview({ op, review, operator, pending, act }) {
  return (
    <>
      <Section title={`Delete ${op.network}`}>
        <div className="panel scroll-x">
          <table className="grid"><thead><tr><th>instance</th><th>name</th><th>public IP</th><th>state</th></tr></thead><tbody className="[&_tr]:!cursor-default">
            {review.instances.map((i) => <tr key={i.id}><td className="mono">{i.id}</td><td className="mono">{i.name}</td><td className="mono">{i.ip || '—'}</td><td>{i.state}</td></tr>)}
            {!review.instances.length && <tr><td colSpan={4} className="text-dim">no instances left</td></tr>}
          </tbody></table>
          <div className="px-3 py-2 text-[12px] border-t border-line">{review.volumes} EBS volume(s) · DNS {review.dns.join(', ') || 'none'} · BYOIP addresses released back to the pool. The dashnet journal record stays, so the name cannot be reused.</div>
        </div>
      </Section>
      {op.status === 'review' && operator && (
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-danger" disabled={pending} onClick={() => act('confirm', { planId: review.planId })}>Permanently delete {op.network}</button>
          <span className="text-dim text-[12px]">Terminates every instance and deletes their disks. Not reversible.</span>
        </div>
      )}
    </>
  );
}

function ServicesReview({ op, review, operator, pending, act }) {
  const to = review.to;
  const keys = ['quorumServer', 'insightImage', 'explorerVersion', 'faucetRef', 'faucetAmount', 'faucetRateLimit', 'faucetFunding'];
  return (
    <>
      <Section title={`Services on ${op.network}`}>
        <div className="panel scroll-x">
          <table className="grid"><thead><tr><th>setting</th><th>current</th><th>after</th></tr></thead><tbody className="[&_tr]:!cursor-default">
            {keys.map((k) => <tr key={k}><td>{k}</td><td className="mono text-dim">{String(review.from?.[k] ?? '—')}</td><td className={`mono ${String(review.from?.[k]) !== String(to[k]) ? 'lv-warn' : ''}`}>{String(to[k])}</td></tr>)}
          </tbody></table>
          <div className="px-3 py-2 text-[12px] border-t border-line text-dim">Re-installs quorum-list-server, Platform Explorer and dash-faucet on the wallet host ({Object.values(review.dns).map((x) => x.host).join(', ')}); builds images when versions change. Chain data is not touched.</div>
        </div>
      </Section>
      {op.status === 'review' && operator && (
        <div className="mt-3 flex items-center gap-3">
          <button className="btn btn-primary" disabled={pending} onClick={() => act('confirm', { planId: review.planId })}>Apply services</button>
          <span className="text-dim text-[12px]">Versions come from Settings → New devnet defaults; change them there and prepare again.</span>
        </div>
      )}
    </>
  );
}

function ResetReview({ op, review, operator, pending, act }) {
  const [typed, setTyped] = useState('');
  const img = (x) => Object.entries(x || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
  return (
    <>
      <Section title={`Platform wipe/redeploy · ${review.hpmns} HPMNs + ${review.seeds} seed(s)`}>
        <div className="panel px-3 py-2 text-[12px] space-y-1 break-words [overflow-wrap:anywhere]">
          <div><span className="text-dim">Core chain </span><span className="mono">{review.coreChain}</span> · <span className="text-dim">Core height </span><span className="mono">{review.coreHeight}</span></div>
          <div><span className="text-dim">Genesis ChainLock anchor </span><span className="mono lv-warn">{review.anchor.height}</span> <span className="mono text-dim">{review.anchor.hash}</span> <span className="text-dim">(previous {review.previousAnchor.join(', ')})</span></div>
          {review.requested && <div><span className="text-dim">Requested release </span><span className="mono">{img(review.requested)}</span></div>}
          <div><span className="text-dim">Images now </span><span className="mono">{review.current.map(img).join(' | ')}</span></div>
          <div><span className="text-dim">Images after </span><span className="mono">{img(review.next)}</span> · <span className="text-dim">seed Tenderdash now </span><span className="mono">{review.seedImages.join(', ')}</span></div>
          {review.native && <details><summary>Immutable pins for every target</summary>{Object.entries(review.targetImages || {}).map(([name, pins]) => <div key={name} className="mono mt-2">{name}: {img(pins)}</div>)}</details>}
          <div><span className="text-dim">Epoch </span><span className="mono">{review.epoch.current.join(', ')} → {review.epoch.next} s</span> · <span className="text-dim">dashmate </span><span className="mono">{review.dashmate.join(', ')}</span> · <span className="text-dim">config format </span><span className="mono">{review.configFormat.join(', ')}</span> · <span className="text-dim">Tor enabled </span><span className="mono">{review.tor.map(String).join(', ')}</span></div>
          <div className="pt-1"><span className="text-dim">Canary </span><span className="mono">{`epochTime ${review.canary.epochTime}, env ${review.canary.epochEnv}, ${review.canary.coreMigration?.length ? 'Core configuration migration included' : `Core config unchanged ${review.canary.coreSectionUnchanged}`} , anchor ${review.canary.anchor}${review.canary.nodeKeyUnchanged ? `, node key preserved, genesis ${review.canary.genesisChainId} (only anchor changes)` : ''}`}</span></div>
          <div className="text-dim">Renders only: <span className="mono">{review.rendered.join(', ')}</span></div>
        </div>
      </Section>
      {Object.values(review.coreMigrations || {}).some((changes) => changes.length > 0) && <Section title="Automatic Core compatibility migration">
        <div className="panel p-3 text-[12px] space-y-2">
          <p>The selected release requires Core RPC access and compatibility changes. This same confirmation includes them: back up, migrate Core/Tor services {review.coreMigrationMode === 'parallel-v1' ? 'together in parallel (up to 32 validators per batch)' : 'one node at a time'} with mining paused. {review.coreMigrationMode === 'parallel-v1' ? 'After every restarted Core is READY and synced, resume mining, verify quorum connections, then finish redeploying Platform.' : 'Verify READY and quorum connections, then finish redeploying Platform.'} Core chain, wallets, keys and Core image are preserved.</p>
          {[...new Set(Object.values(review.coreMigrations).flat().map((c) => `${c.option ? `Core ${c.option}` : `${c.user} RPC access`}: add ${c.added.join(', ') || 'none'}${c.removed.length ? `; remove ${c.removed.join(', ')}` : ''}`))].map((line) => <div className="mono break-words" key={line}>{line}</div>)}
        </div>
      </Section>}
      {op.status === 'review' && operator && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-dim">type <span className="mono">{op.network}</span> to confirm</span>
          <input className="input mono w-56" value={typed} onChange={(e) => setTyped(e.target.value.trim())} />
          <button className="btn btn-danger" disabled={pending || typed !== op.network} onClick={() => act('confirm', { planId: review.planId })}>Wipe Platform and redeploy</button>
          <span className="text-dim text-[12px]">Stops at the first stage that fails on any target; backups and logs stay on each host.</span>
        </div>
      )}
    </>
  );
}

function Stages({ op }) {
  const names = Object.keys(op.stages);
  const hosts = [...new Set(names.flatMap((n) => Object.keys(op.stages[n])))];
  return (
    <Section title="Per-target results">
      <div className="panel scroll-x">
        <table className="grid"><thead><tr><th>target</th>{names.map((n) => <th key={n}>{n}</th>)}</tr></thead><tbody className="[&_tr]:!cursor-default">
          {hosts.map((h) => (
            <tr key={h}><td className="mono">{h}</td>{names.map((n) => {
              const v = op.stages[n][h];
              return <td key={n} title={v?.error || (v?.result?.problems || []).join('; ')}>{v ? (v.ok ? <span className="lv-ok">ok</span> : <span className="lv-down">fail</span>) : <span className="text-faint">—</span>}</td>;
            })}</tr>
          ))}
        </tbody></table>
      </div>
    </Section>
  );
}
