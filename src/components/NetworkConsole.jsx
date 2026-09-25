import { useEffect, useState } from 'react';
import './NetworkConsole.css';

const number = (n) => Number.isFinite(n) ? n.toLocaleString() : '—';
const statusLabels = { healthy: 'Healthy', observed: 'Observed · verification pending', degraded: 'Degraded', unknown: 'Unknown', stale: 'Telemetry stale' };
const actions = { import: 'Refresh inventory', doctor: 'Check health', enroll: 'Enable management', upgrade: 'Upgrade', deploy: 'Recover services' };
const age = (at) => { if (!at) return 'No observation'; const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)); return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`; };
function Status({ value }) { return <span className={`nc-status nc-${value}`}><i />{statusLabels[value] || value}</span>; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
function Metric({ label, value, detail }) { return <div className="nc-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }
function NetworkCard({ network: n }) {
  return <a className="nc-network-card" href={`#/networks/${n.name}`}>
    <div className="nc-card-top"><span className="nc-eyebrow">{n.type || 'Dash network'}</span><Status value={n.status} /></div>
    <h2>{n.displayName}<span aria-hidden="true">↗</span></h2>
    <p>{n.description || 'Live infrastructure and consensus observations.'}</p>
    <div className="nc-card-metrics"><Metric label="Managed nodes" value={number(n.expectedNodes)} /><Metric label="Platform height" value={number(n.platform?.max)} /></div>
    <div className="nc-card-bottom"><span>Protocol {n.protocols?.join(', ') || '—'}</span><span>Updated {age(n.observedAt)}</span></div>
  </a>;
}
function NetworkDetail({ network: n, session, executionEnabled, refresh }) {
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [operations, setOperations] = useState([]);
  const operator = n.permissions?.length > 0;
  useEffect(() => {
    if (!operator) return;
    let cancelled = false;
    const update = () => api(`/api/networks/${n.name}/operations`).then((v) => { if (!cancelled) setOperations(v.operations); }).catch(() => {});
    update(); const timer = setInterval(update, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [n.name, operator]);
  async function review(action) {
    setBusy(true); setError('');
    try { const plan = await api(`/api/networks/${n.name}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ action }) }); setPreview({ ...plan, requestId: crypto.randomUUID() }); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function execute() {
    setBusy(true); setError('');
    try {
      const record = await api(`/api/networks/${n.name}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify({ action: preview.action, planId: preview.planId, requestId: preview.requestId }) });
      setOperations((rows) => [record, ...rows.filter((v) => v.id !== record.id)]); setPreview(null); refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <>
    <a className="nc-back" href="#/">← All networks</a>
    <div className="nc-detail-heading"><div><div className="nc-eyebrow">{n.type || 'Dash network'}</div><h1>{n.displayName}</h1><p>{n.description}</p></div><Status value={n.status} /></div>
    {n.notice && <div className="nc-notice">{n.notice}</div>}
    <section className="nc-metric-strip" aria-label="Network metrics">
      <Metric label="Core height" value={number(n.core?.max)} detail={n.core ? `Fleet range ${number(n.core.min)}–${number(n.core.max)}` : 'Awaiting observation'} />
      <Metric label="Platform height" value={number(n.platform?.max)} detail={n.protocols?.length ? `Protocol ${n.protocols.join(', ')}` : 'Awaiting consensus data'} />
      <Metric label="Managed nodes" value={number(n.expectedNodes)} detail={`${n.counts?.unknown || 0} unknown · ${n.counts?.degraded || 0} degraded`} />
      <Metric label="Last observation" value={age(n.observedAt)} detail={n.verifiedAt ? `Health verified ${age(n.verifiedAt)}` : 'An observation is not a health verification'} />
    </section>
    {operator && <section className="nc-operator-panel"><div><span className="nc-eyebrow">Operator workspace</span><h2>Manage this network</h2><p>Review the exact scope before starting an operation.</p></div><div className="nc-actions">{n.permissions.filter((a) => actions[a]).map((a) => <button key={a} className={a === 'upgrade' ? 'nc-button primary' : 'nc-button'} disabled={busy} onClick={() => review(a)}>{actions[a]}</button>)}</div>
      {!executionEnabled && <p className="nc-muted">Workflow execution is not enabled. Plans can be reviewed, but no changes will be dispatched.</p>}
    </section>}
    {error && <p role="alert" className="nc-error">{error}</p>}
    {preview && <section className="nc-review" role="region" aria-label="Review operation"><div className="nc-section-heading"><h2>{actions[preview.action]} · review</h2><button className="nc-button" onClick={() => setPreview(null)} disabled={busy}>Cancel</button></div>
      <div className="nc-review-facts"><span><b>{preview.targets.length}</b> selected nodes</span><span>{preview.preservesCore ? 'Core is preserved' : 'Core is included'}</span><span>{preview.scope || 'Explicit network scope'}</span></div><p>{preview.recovery}</p>
      {preview.changes.length > 0 && <div className="nc-table-wrap"><table><thead><tr><th>Node</th><th>Component</th><th>Running image</th><th>Requested image</th></tr></thead><tbody>{preview.changes.map((c) => <tr key={`${c.node}/${c.component}`}><td>{c.node}</td><td>{c.component}</td><td className="nc-image">{c.from}</td><td className="nc-image">{c.to}</td></tr>)}</tbody></table></div>}
      <button className="nc-button primary" disabled={busy || !preview.executionEnabled} onClick={execute}>{busy ? 'Submitting…' : 'Launch reviewed operation'}</button>
    </section>}
    <div className="nc-section-heading"><div><span className="nc-eyebrow">Fleet visibility</span><h2>Nodes & services</h2></div><span className="nc-muted">Every intended target stays visible</span></div>
    <div className="nc-table-wrap"><table><thead><tr><th>Node</th><th>Health</th><th>Core</th><th>Platform</th><th>DAPI</th><th>Services</th></tr></thead><tbody>{n.nodes.map((node) => <tr key={node.name}><td><strong>{node.name}</strong><small>{node.role}</small>{node.operator && <small>{node.operator.instanceId}</small>}</td><td><Status value={node.status} /></td><td className="nc-numeric">{number(node.coreHeight)}</td><td className="nc-numeric">{number(node.platformHeight)}</td><td>{node.dapi}</td><td><details><summary>{node.services.length} services</summary>{node.services.map((s) => <div className="nc-service" key={s.component}><strong>{s.component} · {s.running ? 'running' : 'stopped'}</strong><small>{s.image}</small><small>{s.restarts || 0} restarts</small></div>)}{node.operator?.error && <p>{node.operator.error}</p>}</details></td></tr>)}</tbody></table>{!n.nodes.length && <p className="nc-empty">Waiting for a complete inventory observation.</p>}</div>
    <div className="nc-bottom-grid"><section><span className="nc-eyebrow">Build on Dash</span><h2>Developer endpoints</h2>{n.endpoints.length ? n.endpoints.map((e) => <a className="nc-endpoint" key={e.url} href={e.url} rel="noreferrer" target="_blank"><span>{e.label}</span><span>↗</span></a>) : <p className="nc-muted">No public endpoints have been published for this network.</p>}</section>
      <section><span className="nc-eyebrow">Verification</span><h2>Health is observed independently</h2><p className="nc-muted">A completed deployment does not make a network permanently healthy. Consensus, Core and DAPI observations are refreshed separately. Stale or unreachable targets remain visible.</p></section></div>
    {operator && <section><div className="nc-section-heading"><h2>Operations</h2><span className="nc-muted">GitHub Actions execution</span></div>{operations.length ? operations.map((o) => <article className="nc-operation" key={o.id}><div><strong>{actions[o.action]}</strong><small>{o.actor.login} · {new Date(o.createdAt).toLocaleString()}</small></div><span>{o.conclusion || o.status}</span>{o.runUrl && <a href={o.runUrl} target="_blank" rel="noreferrer">View run ↗</a>}{o.notice && <p>{o.notice}</p>}</article>) : <p className="nc-muted">No console operations yet.</p>}</section>}
  </>;
}
export default function NetworkConsole() {
  const [data, setData] = useState({ networks: [], executionEnabled: false }), [session, setSession] = useState({ user: null }), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [hash, setHash] = useState(window.location.hash);
  async function refresh() {
    try { const [networks, auth] = await Promise.all([api('/api/networks'), api('/api/session')]); setData(networks); setSession(auth); setError(''); }
    catch { setError('The console is unable to refresh observations. Previously displayed data may be stale.'); }
    finally { setLoaded(true); }
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 15_000); const navigate = () => setHash(window.location.hash); window.addEventListener('hashchange', navigate); return () => { clearInterval(timer); window.removeEventListener('hashchange', navigate); }; }, []);
  const selected = data.networks.find((n) => `#/networks/${n.name}` === hash);
  const healthy = data.networks.filter((n) => n.status === 'healthy').length;
  async function logout() { await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } }); await refresh(); }
  return <div className="network-console"><header className="nc-header"><a className="nc-brand" href="#/"><span className="nc-dash-mark" aria-hidden="true">▰</span>dash<span className="nc-brand-divider" />network observatory</a><nav><a href="https://docs.dash.org/" target="_blank" rel="noreferrer">Developer docs ↗</a>{session.user ? <><span className="nc-user">{session.user.login}</span><button onClick={logout}>Sign out</button></> : session.loginAvailable ? <a className="nc-sign-in" href="/api/auth/github">Operator sign in →</a> : <span className="nc-user" title="Operator authentication is not configured">Public view</span>}</nav></header>
    <main className="nc-main">{error && <div className="nc-error" role="alert">{error}</div>}{selected ? <NetworkDetail key={selected.name} network={selected} session={session} executionEnabled={data.executionEnabled} refresh={refresh} /> : <>
      <section className="nc-hero"><div><div className="nc-eyebrow"><span className="nc-live-dot" />Dash network observatory</div><h1>Built in the open.<br /><em>Running in real time.</em></h1><p>Explore the networks behind Dash. Follow consensus, see what’s running, and find your next place to build.</p></div><div className="nc-hero-stats"><Metric label="Networks" value={number(data.networks.length)} /><Metric label="Verified healthy" value={number(healthy)} /><span>Live evidence.<br />Visible uncertainty.</span></div></section>
      <div className="nc-section-heading"><div><span className="nc-eyebrow">The ecosystem, at a glance</span><h2>Explore networks</h2></div><span className="nc-muted">Public telemetry · independent health</span></div>
      <section className="nc-network-grid" aria-label="Networks">{data.networks.map((n) => <NetworkCard network={n} key={n.name} />)}</section>{!data.networks.length && <div className="nc-empty">{loaded ? 'No networks have been published yet.' : 'Loading network observations…'}</div>}
      <section className="nc-explainer"><span className="nc-eyebrow">More than uptime</span><h2>See the network.<br />Understand its state.</h2><div><p><strong>Core + Platform</strong><br />Chain progress, validator services and developer access in one place.</p><p><strong>Evidence, not assumptions</strong><br />Unreachable nodes and old observations never quietly turn green.</p><p><strong>One operational path</strong><br />Authorized operators use the same reviewed commands as the CLI and GitHub Actions.</p></div></section>
    </>}</main><footer className="nc-footer"><span>Dash · Network observatory</span><span>Built for developers. Operated transparently.</span><a href="https://github.com/dashpay/dash-network-go" target="_blank" rel="noreferrer">Open-source tooling ↗</a></footer></div>;
}
