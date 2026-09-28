import { useEffect, useMemo, useState } from 'react';
import { api, navigate, useResource, useSession, ROLE_LABEL, ago } from '../lib.js';
import { Dot, Empty, Err, Link, Section } from '../ui.jsx';
import { cmp, newestRelease, reported } from '../releases.js';

const COMPONENTS = ['core', 'drive', 'tenderdash', 'dapi', 'gateway', 'helper'];
const REPOS = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper' };
// Plain-language actions; the dashnet command runs underneath (shown in the header).
const ACTIONS = [
  { id: 'upgrade', title: 'Upgrade images', text: 'Change the version of selected components. Each image is pinned by digest and swapped one host at a time; the next host waits until the whole fleet passes the health check.' },
  { id: 'deploy', title: 'Restart stopped containers', text: 'Recovery: start containers that are stopped (crash, reboot, deliberate stop) with exactly the image and settings recorded at enrollment. No version change, not for new nodes.' },
  { id: 'doctor', title: 'Health check', text: 'Read-only. Observes each host twice across the observation window: services running, Core synced and advancing with ChainLocks, masternode READY, Platform advancing in agreement, DAPI answering.' },
  { id: 'enroll', title: 'Enroll hosts', text: 'One-time, changes nothing running: records each host\'s container setup (images, commands, mounts) as a root-only recovery file and in the shared dashnet journal. Upgrades and restarts need it; they enroll new hosts automatically.' },
];
const OPERABLE = ['validator', 'masternode', 'seed'];
const ROLE_COMPONENTS = { validator: COMPONENTS, masternode: ['core'], seed: ['core', 'tenderdash'] };

export default function Deploy({ name }) {
  const session = useSession();
  const { data: n, error } = useResource(`/api/networks/${name}`, (t, d) => t === 'network' && (d.name === name || d.name === '*'));
  const params = new URLSearchParams(location.search);
  const [action, setAction] = useState(params.get('action') || 'upgrade');
  // No explicit choice yet means every healthy node (a link may preselect others).
  const [picked, setPicked] = useState(params.get('nodes') ? new Set(params.get('nodes').split(',').filter(Boolean)) : null);
  const [components, setComponents] = useState(new Set(params.get('components')?.split(',').filter(Boolean) || []));
  const [images, setImages] = useState({});
  const [window, setWindow] = useState('');
  const [timeout, setTimeoutValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [roleFilter, setRoleFilter] = useState('all');

  const native = n?.kind === 'dashnet';
  const healthy = useMemo(() => new Set((n?.hosts || []).filter((h) => OPERABLE.includes(h.role) && !h.duplicate && h.state === 'running' && h.level !== 'unreachable').map((h) => h.name)), [n]);
  const selected = picked ?? healthy;
  const setSelected = (next) => setPicked((p) => (typeof next === 'function' ? next(p ?? healthy) : next));
  const hosts = useMemo(() => (n?.hosts || []).filter((h) => OPERABLE.includes(h.role) && !h.duplicate), [n]);
  // dash-network-go upgrades every validator, one at a time; there is no node selection.
  const chosen = native ? hosts.filter((h) => h.role === 'validator') : hosts.filter((h) => selected.has(h.name));
  const coreUpgradable = !native || (n?.upgradeScopes || []).includes('core');
  const available = new Set(chosen.flatMap((h) => ROLE_COMPONENTS[h.role].filter((c) => (c !== 'core' || coreUpgradable) && h.containers.some((k) => k.component === c))));
  const [autoRun, setAutoRun] = useState(true);
  const [filling, setFilling] = useState(null);
  const archs = [...new Set(chosen.map((h) => h.arch))];
  const needsComponents = action === 'upgrade' || action === 'deploy';
  const activeComponents = [...components].filter((c) => available.has(c));
  const missingOn = (c) => chosen.filter((h) => !h.containers.some((k) => k.component === c)).map((h) => h.name);

  if (!session.loaded) return null;
  if (!session.operatorOf?.includes(name)) return <div className="mt-6"><Empty>Sign in as an operator of this network to deploy.</Empty></div>;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!n) return <div className="mt-6 text-dim">Loading…</div>;
  if (!n.deployable) return <div className="mt-6"><Empty>{n.displayName} is monitored only. Enable “deployable” in Settings to operate it.</Empty></div>;

  const toggle = (set, value) => { const x = new Set(set); x.has(value) ? x.delete(value) : x.add(value); return x; };
  const visibleHosts = hosts.filter((h) => roleFilter === 'all' || h.role === roleFilter);
  const problems = [];
  if (!chosen.length) problems.push('select at least one node');
  if (needsComponents && !activeComponents.length) problems.push('select at least one component');
  for (const c of activeComponents) {
    const miss = missingOn(c);
    if (miss.length) problems.push(`${c} is not present on ${miss.join(', ')}`);
    if (action === 'upgrade' && !new RegExp(`^(docker\\.io/)?${REPOS[c]}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$`).test(images[c] || '')) problems.push(`${c}: enter ${REPOS[c]}:<tag>`);
  }

  // One click: newest release per component (same major line) where it is newer.
  async function fillNewest() {
    setFilling('loading');
    const picks = {};
    await Promise.all([...available].map(async (c) => {
      const running = [...new Set(chosen.map((h) => reported(h, c)).filter(Boolean))].sort(cmp)[0];
      try { const { tags } = await api(`/api/images/${c}/tags`); const t = newestRelease(tags, running); if (t) picks[c] = `${REPOS[c]}:${t}`; } catch { /* tags unavailable */ }
    }));
    setImages((x) => ({ ...x, ...picks }));
    setComponents(new Set(Object.keys(picks)));
    setFilling(Object.keys(picks).length ? `${Object.keys(picks).length} newer release(s) selected` : 'everything already runs the newest release in its line');
  }

  async function submit() {
    setBusy(true); setSubmitError(null);
    try {
      const body = { action, nodes: native ? [] : chosen.map((h) => h.name), components: needsComponents ? activeComponents : [], images: action === 'upgrade' ? Object.fromEntries(activeComponents.map((c) => [c, images[c]])) : {}, options: { ...(window ? { observationWindow: window } : {}), ...(timeout ? { timeout } : {}), ...(needsComponents ? { autoRun } : {}) } };
      const r = await api(`/api/networks/${name}/ops`, { method: 'POST', body });
      navigate(`/n/${name}/ops/${r.id}`);
    } catch (e) { setSubmitError(e); setBusy(false); }
  }

  return (
    <div className="max-w-[1280px]">
      <div className="mt-4 flex items-center gap-3">
        <Link to={`/n/${name}`} className="text-dim hover:text-fg">← {n.displayName}</Link>
        <h1 className="text-[18px] font-semibold">Deploy</h1>
        <span className="text-dim text-[12px]">executed by the status agent with dashnet {native ? (action === 'upgrade' ? 'resolve → upgrade-plan → upgrade' : 'doctor') : action === 'upgrade' ? 'managed-plan → managed-upgrade' : action === 'deploy' ? 'managed-plan → managed-deploy' : `managed-${action}`}</span>
      </div>

      <Section title="1 · Action">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {ACTIONS.filter((a) => !native || ['upgrade', 'doctor'].includes(a.id)).map((a) => (
            <button key={a.id} onClick={() => setAction(a.id)} className={`panel text-left px-3 py-2.5 ${action === a.id ? '!border-accent bg-[#0f1a28]' : 'hover:border-line-2'}`}>
              <div className="font-medium">{a.title}</div>
              <div className="text-dim text-[11.5px] mt-0.5">{a.text}</div>
            </button>
          ))}
        </div>
      </Section>

      {native ? (
        <Section title={`2 · Nodes · all ${chosen.length} validators`}>
          <div className="panel p-3 text-[12px] text-dim">dash-network-go withdraws one node at a time and requires the whole fleet (advancing consensus, common block hashes, DAPI, membership) to be healthy before the next. A Core upgrade runs first on every node (validators, then the mining node); Platform images then roll across the validators. {coreUpgradable ? '' : <span className="lv-warn">This devnet was created with a dash-network-go that cannot upgrade Core; newer devnets can.</span>}</div>
        </Section>
      ) : (
      <Section title={`2 · Nodes · ${chosen.length} selected`} right={
        <div className="flex gap-1.5 flex-wrap">
          {['all', ...OPERABLE].map((r) => <span key={r} className={`chip ${roleFilter === r ? 'on' : ''}`} onClick={() => setRoleFilter(r)}>{r === 'all' ? 'all' : ROLE_LABEL[r].toLowerCase()} <span className="mono">{r === 'all' ? hosts.length : hosts.filter((h) => h.role === r).length}</span></span>)}
          <button className="btn !py-0.5" onClick={() => setSelected(new Set([...selected, ...visibleHosts.filter((h) => h.level !== 'unreachable' && h.state === 'running').map((h) => h.name)]))}>select shown</button>
          <button className="btn !py-0.5" onClick={() => setSelected(new Set())}>clear</button>
        </div>
      }>
        <div className="panel scroll-x max-h-[420px] overflow-y-auto">
          <table className="grid">
            <thead><tr><th className="w-6" /><th>host</th><th>role</th><th>status</th><th>arch</th>{COMPONENTS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {visibleHosts.map((h) => (
                <tr key={h.name} onClick={() => setSelected((s) => toggle(s, h.name))} className={selected.has(h.name) ? 'open' : ''}>
                  <td><input type="checkbox" readOnly checked={selected.has(h.name)} /></td>
                  <td className="mono">{h.name}</td>
                  <td className="text-dim">{h.role}</td>
                  <td><span className="flex items-center gap-1.5"><Dot level={h.level} /><span className="text-dim truncate max-w-[220px]">{h.reasons.filter((r) => r.level !== 'info')[0]?.text || h.level}</span></span></td>
                  <td className="mono text-dim">{h.arch}</td>
                  {COMPONENTS.map((c) => <td key={c} className="mono text-[11.5px]">{ROLE_COMPONENTS[h.role].includes(c) ? h.containers.find((k) => k.component === c)?.version || '—' : ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      )}

      {needsComponents && (
        <Section title="3 · Components" right={action === 'upgrade' && chosen.length > 0 && (
          <span className="flex items-center gap-2">
            {filling && filling !== 'loading' && <span className="text-dim text-[12px]">{filling}</span>}
            <button className="btn !py-0.5" disabled={filling === 'loading'} onClick={fillNewest}>{filling === 'loading' ? 'Checking releases…' : 'Use newest releases'}</button>
          </span>
        )}>
          <div className="panel p-3 space-y-2">
            {!chosen.length && <div className="text-dim">Select nodes first.</div>}
            {COMPONENTS.filter((c) => available.has(c)).map((c) => (
              <ComponentRow key={c} c={c} on={components.has(c)} toggle={() => setComponents((s) => toggle(s, c))} action={action}
                image={images[c] || ''} setImage={(v) => setImages((x) => ({ ...x, [c]: v }))} archs={archs}
                current={[...new Set(chosen.map((h) => h.containers.find((k) => k.component === c)?.version).filter(Boolean))]} missing={missingOn(c)} />
            ))}
            {action === 'upgrade' && activeComponents.includes('drive') && !activeComponents.includes('tenderdash') && chosen.some((h) => h.role === 'validator') && (
              <div className="text-[12px] lv-warn">Replacing Drive drains Tenderdash on the same host; dashnet will add Tenderdash to the plan with its current image.</div>
            )}
          </div>
        </Section>
      )}

      <Section title={`${needsComponents ? 4 : 3} · Options`}>
        <div className="panel p-3 flex flex-wrap gap-6 items-end">
          <label className="text-[12px]"><div className="text-dim mb-1">Observation window (health gap between checks)</div><input className="input w-28 mono" placeholder={n.observationWindow} value={window} onChange={(e) => setWindow(e.target.value.trim())} /></label>
          {(action === 'upgrade' || action === 'deploy') && <label className="text-[12px]"><div className="text-dim mb-1">Operation timeout</div><input className="input w-28 mono" placeholder={n.operationTimeout} value={timeout} onChange={(e) => setTimeoutValue(e.target.value.trim())} /></label>}
          <div className="text-dim text-[11.5px] max-w-[520px]">Defaults come from Settings. Upgrades withdraw one host at a time; validators additionally require the remaining quorum to be healthy before each withdrawal.</div>
          {needsComponents && <label className="flex items-center gap-2 text-[12px] cursor-pointer"><input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            <span>Start as soon as the plan is ready <span className="text-dim">(the exact plan stays on the operation page; cancel any time)</span></span></label>}
        </div>
      </Section>

      <div className="mt-5 flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy || problems.length > 0} onClick={submit}>{busy ? 'Submitting…' : needsComponents ? (autoRun ? (action === 'upgrade' ? 'Upgrade now' : 'Restart now') : 'Prepare plan for review') : action === 'doctor' ? 'Run health check' : 'Enroll hosts'}</button>
        <span className="text-dim text-[12px]">{problems.length ? problems[0] : needsComponents ? (autoRun ? 'Plans, then runs straight away; progress shows on the operation page.' : 'Nothing changes until you confirm the prepared plan.') : ''}</span>
      </div>
      {submitError && <div className="mt-3"><Err error={submitError} /></div>}
    </div>
  );
}

function ComponentRow({ c, on, toggle, action, image, setImage, archs, current, missing }) {
  const [tags, setTags] = useState(null);
  const [tagError, setTagError] = useState(null);
  useEffect(() => {
    if (!on || action !== 'upgrade' || tags) return;
    api(`/api/images/${c}/tags`).then((r) => setTags(r.tags), (e) => setTagError(e.message));
  }, [on, action, c, tags]);
  const tag = image.split(':')[1];
  const match = tags?.find((t) => t.name === tag);
  const unsupported = match && match.arches.length ? archs.filter((a) => !match.arches.includes(a)) : [];
  return (
    <div className={`grid gap-2 lg:grid-cols-[260px_minmax(0,1fr)] items-start border-b border-line pb-2 last:border-0 ${on ? '' : 'opacity-70'}`}>
      <label className="flex items-center gap-2 cursor-pointer pt-1">
        <input type="checkbox" checked={on} onChange={toggle} />
        <span className="font-medium">{c}</span>
        <span className="text-dim mono text-[11px]">{REPOS[c]}</span>
      </label>
      <div className="min-w-0">
        <div className="text-[11.5px] text-dim">running: {current.map((v) => <span key={v} className="tag mr-1">{v}</span>)}{missing.length ? <span className="lv-warn ml-1">absent on {missing.length} selected</span> : null}</div>
        {on && action === 'upgrade' && (
          <div className="mt-1.5">
            <input className="input w-full max-w-[520px] mono" list={`tags-${c}`} placeholder={`${REPOS[c]}:<tag>`} value={image}
              onChange={(e) => setImage(e.target.value.includes('/') || !e.target.value ? e.target.value.trim() : `${REPOS[c]}:${e.target.value.trim()}`)} />
            <datalist id={`tags-${c}`}>{(tags || []).map((t) => <option key={t.name} value={`${REPOS[c]}:${t.name}`}>{t.arches.join(',')}</option>)}</datalist>
            <div className="mt-1 flex flex-wrap gap-1">
              {tagError && <span className="lv-warn text-[11px]">tags unavailable: {tagError}</span>}
              {(tags || []).slice(0, 12).map((t) => (
                <button key={t.name} type="button" onClick={() => setImage(`${REPOS[c]}:${t.name}`)} className={`chip ${tag === t.name ? 'on' : ''}`} title={`${t.arches.join(', ')} · updated ${t.updated}`}>
                  {t.name}<span className="text-faint">{ago(t.updated)}</span>
                </button>
              ))}
            </div>
            {match && <div className={`text-[11px] mt-1 ${unsupported.length ? 'lv-down' : 'text-dim'}`}>{tag}: {match.arches.join(', ') || 'arch unknown'}{unsupported.length ? ` — missing ${unsupported.join(', ')} used by selected nodes` : ''}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
