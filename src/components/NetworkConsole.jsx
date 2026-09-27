import { useEffect, useRef, useState } from 'react';
import './NetworkConsole.css';

const number = (n) => Number.isFinite(n) ? n.toLocaleString() : '—';
const statusLabels = { healthy: 'Healthy', observed: 'Observed', degraded: 'Degraded', unknown: 'Unknown', stale: 'Stale' };
const actions = { import: 'Refresh inventory', doctor: 'Check health', enroll: 'Enable management', upgrade: 'Upgrade', deploy: 'Recover services' };
const roles = { validator: 'HP Masternodes', masternode: 'Masternodes', seed: 'Seeds', core: 'Core nodes' };
const age = (at) => {
  if (!Number.isFinite(Date.parse(at))) return 'Not observed';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};
const nodeName = (name) => name.replace(/^hp-masternode-/, 'HP ').replace(/^masternode-/, 'MN ');
const dapiLabel = (value) => value === 'not-applicable' ? '—' : value || 'unknown';
function Status({ value }) {
  return <span className={`nc-status nc-${value}`} title={value === 'observed' ? 'Observed; full health check not verified' : undefined}><i />{statusLabels[value] || value}</span>;
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
function Metric({ label, value, detail }) {
  return <div className="nc-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
function Resources({ resources }) {
  return <div className="nc-resources">{[['CPU', 'cpuPercent'], ['MEM', 'memPercent'], ['DSK', 'diskPercent']].map(([label, key]) => Number.isFinite(resources?.[key]) &&
    <div className="nc-resource" key={key}><span>{label}</span><meter min="0" max="100" low="70" high="90" optimum="0" value={resources[key]} aria-label={label} /><span>{Math.round(resources[key])}%</span></div>)}</div>;
}
function NodeCard({ node, onSelect }) {
  const restarts = node.services.reduce((sum, s) => sum + (s.restarts || 0), 0);
  return <button className={`nc-node-card nc-node-${node.status}`} onClick={() => onSelect(node.name)} aria-label={`${node.name}: ${statusLabels[node.status]}`}>
    <div className="nc-node-title"><strong title={node.name}>{nodeName(node.name)}</strong><Status value={node.status} /></div>
    {node.masternodeState && <div className={`nc-node-state ${node.masternodeState === 'READY' ? 'nc-ready' : ''}`}>{node.masternodeState}{Number.isFinite(node.posePenalty) && <span>PoSe {node.posePenalty}</span>}</div>}
    <dl className="nc-node-metrics"><div><dt>Core</dt><dd>{number(node.coreHeight)}</dd></div>
      {node.role !== 'masternode' && <><div><dt>Platform</dt><dd>{number(node.platformHeight)}</dd></div><div><dt>DAPI</dt><dd>{dapiLabel(node.dapi)}</dd></div></>}
    </dl>
    <Resources resources={node.resources} />
    <div className="nc-node-meta"><span>{node.services.length ? `${node.services.filter((s) => s.running).length}/${node.services.length} services running` : 'Services not observed'}</span>{restarts > 0 && <span className="nc-restarts">{restarts} restarts</span>}</div>
  </button>;
}
function NodeDetails({ node, close, observedAt }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} className="nc-node-dialog" onClose={close} onClick={(e) => { if (e.target === e.currentTarget) close(); }} aria-labelledby="node-detail-title">
    <div className="nc-dialog-content"><div className="nc-dialog-heading"><h2 id="node-detail-title">{node.name}</h2><button className="nc-button" onClick={close} aria-label="Close node details">Close</button></div>
      <div className="nc-dialog-status"><Status value={node.status} /><span>{node.role}</span><span>Updated {age(observedAt)}</span></div>
      <dl className="nc-detail-metrics"><div><dt>Core height</dt><dd>{number(node.coreHeight)}</dd></div><div><dt>Platform height</dt><dd>{number(node.platformHeight)}</dd></div>
        <div><dt>DAPI</dt><dd>{dapiLabel(node.dapi)}</dd></div>{node.masternodeState && <div><dt>Masternode</dt><dd>{node.masternodeState}</dd></div>}
        {Number.isFinite(node.posePenalty) && <div><dt>PoSe penalty</dt><dd>{node.posePenalty}</dd></div>}
      </dl><Resources resources={node.resources} />
      <h3>Services</h3><div className="nc-table-wrap"><table><thead><tr><th>Service</th><th>State</th><th>Restarts</th></tr></thead><tbody>{node.services.map((s) => <tr key={s.component}><td><strong>{s.component}</strong><small className="nc-image">{s.image}</small></td><td>{s.running ? 'Running' : 'Stopped'}</td><td>{number(s.restarts)}</td></tr>)}</tbody></table></div>
      {!node.services.length && <p className="nc-muted">No service observation.</p>}
      {node.operator && <dl className="nc-detail-metrics">{[['Instance', node.operator.instanceId], ['Address', node.operator.address], ['Architecture', node.operator.architecture]].map(([label, value]) => value && <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {node.operator?.error && <p className="nc-error">{node.operator.error}</p>}{node.operator?.problems?.length > 0 && <ul className="nc-error">{node.operator.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
    </div>
  </dialog>;
}
function NetworkDetail({ network: n, session, executionEnabled, refresh }) {
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [operations, setOperations] = useState([]);
  const [query, setQuery] = useState(''), [health, setHealth] = useState('all'), [layout, setLayout] = useState('cards'), [selectedName, setSelectedName] = useState(null);
  const operator = n.permissions?.length > 0;
  const nodes = [...n.nodes].filter((node) => node.name.toLowerCase().includes(query.trim().toLowerCase()) && (health === 'all' || node.status === health)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const selected = n.nodes.find((node) => node.name === selectedName);
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
    <div className="nc-network-heading"><h2>{n.displayName}</h2><Status value={n.status} /><span className="nc-muted">{n.type} · monitored fleet</span></div>
    <section className="nc-metric-strip" aria-label="Network metrics">
      <Metric label="Core height" value={number(n.core?.max)} detail={n.core && n.core.min !== n.core.max ? `${number(n.core.min)}–${number(n.core.max)}` : undefined} />
      <Metric label="Platform height" value={number(n.platform?.max)} detail={n.protocols?.length ? `Protocol ${n.protocols.join(', ')}` : undefined} />
      <Metric label="Nodes" value={number(n.expectedNodes)} detail={`${n.counts?.unknown || 0} unknown · ${n.counts?.degraded || 0} degraded`} />
      <Metric label="Updated" value={age(n.observedAt)} detail={n.verifiedAt ? `Verified ${age(n.verifiedAt)}` : 'Health check not verified'} />
    </section>
    <div className="nc-health-summary" aria-label="Node health counts">{Object.keys(statusLabels).map((value) => n.counts?.[value] > 0 && <span key={value}><b>{n.counts[value]}</b><Status value={value} /></span>)}</div>
    {n.notice && <details className="nc-collection-note"><summary>Collection details</summary><p>{n.notice}</p></details>}
    {operator && <section className="nc-operator-panel" aria-label="Operator workspace"><div className="nc-operator-heading"><h3>Operations</h3><span className="nc-muted">{!executionEnabled && 'Execution disabled · review only'}</span></div><div className="nc-actions">{n.permissions.filter((a) => actions[a]).map((a) => <button key={a} className="nc-button" disabled={busy} onClick={() => review(a)}>{actions[a]}</button>)}</div></section>}
    {error && <p role="alert" className="nc-error">{error}</p>}
    {preview && <section className="nc-review" role="region" aria-label="Review operation"><div className="nc-section-heading"><h3>{actions[preview.action]} · review</h3><button className="nc-button" onClick={() => setPreview(null)} disabled={busy}>Cancel</button></div>
      <div className="nc-review-facts"><span><b>{preview.targets.length}</b> selected nodes</span><span>{preview.preservesCore ? 'Core is preserved' : 'Core is included'}</span><span>{preview.scope || 'Explicit network scope'}</span></div><p>{preview.recovery}</p>
      {preview.changes.length > 0 && <div className="nc-table-wrap"><table><thead><tr><th>Node</th><th>Component</th><th>Running image</th><th>Requested image</th></tr></thead><tbody>{preview.changes.map((c) => <tr key={`${c.node}/${c.component}`}><td>{c.node}</td><td>{c.component}</td><td className="nc-image">{c.from}</td><td className="nc-image">{c.to}</td></tr>)}</tbody></table></div>}
      <button className="nc-button primary" disabled={busy || !preview.executionEnabled} onClick={execute}>{busy ? 'Submitting…' : 'Launch reviewed operation'}</button>
    </section>}
    <div className="nc-toolbar"><input type="search" aria-label="Find node" placeholder="Find node…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Filter by health" value={health} onChange={(e) => setHealth(e.target.value)}><option value="all">All states</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <span className="nc-filter-count" aria-live="polite">{nodes.length} of {n.nodes.length} nodes</span>
      <div className="nc-view-switch" aria-label="Node layout">{['cards', 'table'].map((value) => <button className="nc-button" aria-pressed={layout === value} key={value} onClick={() => setLayout(value)}>{value === 'cards' ? 'Cards' : 'Table'}</button>)}</div>
    </div>
    {layout === 'cards' ? [...new Set([...Object.keys(roles), ...nodes.map((node) => node.role)])].map((role) => {
      const group = nodes.filter((node) => node.role === role);
      return group.length > 0 && <section className="nc-node-group" key={role} aria-label={roles[role] || role}><h3>{roles[role] || role} <span>({group.length})</span></h3><div className="nc-node-grid">{group.map((node) => <NodeCard key={node.name} node={node} onSelect={setSelectedName} />)}</div></section>;
    }) : <div className="nc-table-wrap"><table><thead><tr><th>Node</th><th>Health</th><th>Core</th><th>Platform</th><th>DAPI</th><th>Services</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.name}><td><button className="nc-node-link" onClick={() => setSelectedName(node.name)}>{node.name}</button><small>{node.role}</small></td><td><Status value={node.status} /></td><td>{number(node.coreHeight)}</td><td>{number(node.platformHeight)}</td><td>{dapiLabel(node.dapi)}</td><td>{node.services.length ? `${node.services.filter((s) => s.running).length}/${node.services.length} running` : '—'}</td></tr>)}</tbody></table></div>}
    {!nodes.length && <p className="nc-empty">{n.nodes.length ? 'No nodes match these filters.' : 'No node observations available.'}</p>}
    {selected && <NodeDetails node={selected} observedAt={n.observedAt} close={() => setSelectedName(null)} />}
    {n.endpoints?.length > 0 && <section className="nc-endpoints"><h3>Endpoints</h3>{n.endpoints.map((e) => <a key={e.url} href={e.url} rel="noreferrer" target="_blank">{e.label} ↗</a>)}</section>}
    {operator && operations.length > 0 && <section className="nc-operation-history"><h3>Recent operations</h3>{operations.map((o) => <article className="nc-operation" key={o.id}><div><strong>{actions[o.action]}</strong><small>{o.actor.login} · {new Date(o.createdAt).toLocaleString()}</small></div><span>{o.conclusion || o.status}</span>{o.runUrl && <a href={o.runUrl} target="_blank" rel="noreferrer">View run ↗</a>}{o.notice && <p>{o.notice}</p>}</article>)}</section>}
  </>;
}
export default function NetworkConsole() {
  const [data, setData] = useState({ networks: [], executionEnabled: false }), [session, setSession] = useState({ user: null }), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [hash, setHash] = useState(window.location.hash);
  async function refresh() {
    try { const [networks, auth] = await Promise.all([api('/api/networks'), api('/api/session')]); setData(networks); setSession(auth); setError(''); }
    catch { setError('Update failed. Showing the last received observations.'); }
    finally { setLoaded(true); }
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 15_000); const navigate = () => setHash(window.location.hash); window.addEventListener('hashchange', navigate); return () => { clearInterval(timer); window.removeEventListener('hashchange', navigate); }; }, []);
  const isHome = !hash || hash === '#/' || hash === '#';
  const selected = isHome ? data.networks.find((n) => n.name === 'testnet') || data.networks[0] : data.networks.find((n) => `#/networks/${n.name}` === hash);
  async function logout() { await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } }); await refresh(); }
  return <div className="network-console"><header className="nc-header"><div className="nc-header-content"><a className="nc-brand" href="#/"><span className="nc-dash-mark" aria-hidden="true">D</span><h1>Dash Network Status</h1></a>
    <div className="nc-account">{session.user ? <><span>{session.user.login}</span><button className="nc-button" onClick={logout}>Sign out</button></> : session.loginAvailable ? <a className="nc-button" href="/api/auth/github">Sign in with GitHub</a> : <span className="nc-muted">Public view</span>}</div>
    <nav className="nc-network-tabs" aria-label="Networks">{data.networks.map((n) => <a href={`#/networks/${n.name}`} key={n.name} aria-current={selected?.name === n.name ? 'page' : undefined}><span>{n.displayName}</span><span className={`nc-network-dot nc-${n.status}`} aria-label={statusLabels[n.status]} /><small>{number(n.expectedNodes)}</small></a>)}</nav></div></header>
    <main className="nc-main">{error && <div className="nc-error" role="alert">{error}</div>}{selected ? <NetworkDetail key={`${selected.name}/${session.user?.id || 'public'}`} network={selected} session={session} executionEnabled={data.executionEnabled} refresh={refresh} /> : <p className="nc-empty">{!loaded ? 'Loading nodes…' : isHome ? 'No networks configured.' : 'Network not found.'}</p>}</main>
  </div>;
}
