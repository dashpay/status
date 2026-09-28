import { useEffect, useState } from 'react';

const labels = { core: 'Core', drive: 'Drive', tenderdash: 'Tenderdash', dapi: 'DAPI', gateway: 'Gateway', helper: 'Dashmate helper' };
const repositories = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper' };
const actions = { upgrade: 'Upgrade', deploy: 'Recover services', doctor: 'Check health', import: 'Refresh inventory', enroll: 'Enable management' };
async function request(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
export default function OperatorPanel({ network, session, enabled, selectedNodes, setSelectedNodes }) {
  const [action, setAction] = useState('upgrade'), [components, setComponents] = useState([]), [images, setImages] = useState({});
  const [review, setReview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('');
  const [operations, setOperations] = useState([]);
  const base = `/api/networks/${network.name}`;
  const permissions = network.permissions || [];
  const changing = action === 'upgrade' || action === 'deploy';
  const targets = network.nodes.filter((n) => selectedNodes.includes(n.name));
  const available = Object.keys(labels).filter((c) => targets.length && targets.every((n) => n.services.some((s) => s.component === c)));
  const chosen = components.filter((c) => available.includes(c));
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  useEffect(() => {
    let stopped = false;
    const update = () => request(base + '/operations').then((v) => { if (!stopped) setOperations(v.operations); }).catch(() => {});
    update(); const timer = setInterval(update, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [base]);
  useEffect(() => {
    if (review?.status !== 'preparing') return;
    let stopped = false;
    const update = () => request(base + '/reviews/' + review.id).then((v) => { if (!stopped) setReview((old) => ({ ...v, requestId: old.requestId })); }).catch((e) => { if (!stopped) setError(e.message); });
    const timer = setInterval(update, 2000); update();
    return () => { stopped = true; clearInterval(timer); };
  }, [base, review?.id, review?.status]);
  function changeNodes(name) {
    setReview(null);
    setSelectedNodes((old) => old.includes(name) ? old.filter((v) => v !== name) : [...old, name]);
  }
  async function prepare() {
    setBusy(true); setError(''); setReview(null);
    try {
      const selection = { nodes: selectedNodes, components: changing ? chosen : [], images: action === 'upgrade' ? Object.fromEntries(chosen.map((c) => [c, images[c] || ''])) : {} };
      const result = await request(base + '/preview', { method: 'POST', headers, body: JSON.stringify({ action, selection }) });
      setReview({ ...result, requestId: crypto.randomUUID() });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function execute() {
    setBusy(true); setError('');
    try {
      const result = await request(base + '/operations', { method: 'POST', headers, body: JSON.stringify({ action: review.action, draftId: review.id, planId: review.review.planId, requestId: review.requestId }) });
      setOperations((old) => [result, ...old.filter((v) => v.id !== result.id)]); setReview(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function resume(operation) {
    setBusy(true); setError('');
    try {
      const result = await request(base + '/operations/' + operation.id + '/resume', { method: 'POST', headers, body: JSON.stringify({ action: operation.action, requestId: crypto.randomUUID() }) });
      setOperations((old) => [result, ...old.filter((v) => v.id !== result.id)]);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const selectionMatches = review && JSON.stringify([...selectedNodes].sort()) === JSON.stringify([...(review.selection?.nodes || [])].sort());
  const plan = selectionMatches ? review.review : null;
  return <section className="nc-operator-panel" aria-label="Operator workspace" id="node-operations">
    <div className="nc-operator-heading"><h3>Operations</h3>{!enabled && <span className="nc-muted">Execution unavailable</span>}</div>
    <div className="nc-operation-form">
      <label>Action<select aria-label="Operation" value={action} onChange={(e) => { setAction(e.target.value); setReview(null); }}>{Object.entries(actions).filter(([a]) => permissions.includes(a)).map(([a, label]) => <option value={a} key={a}>{label}</option>)}</select></label>
      <fieldset><legend>Nodes ({selectedNodes.length} selected)</legend><input type="search" aria-label="Find operation node" placeholder="Find node…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="nc-operation-nodes">{network.nodes.filter((n) => n.name.includes(query)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((n) => <label key={n.name}><input type="checkbox" checked={selectedNodes.includes(n.name)} disabled={!n.operator?.managed || !!n.operator?.error} onChange={() => changeNodes(n.name)} />{n.name}<small>{!n.operator?.managed ? 'Not in managed inventory' : n.operator?.error ? 'Unavailable' : n.role}</small></label>)}</div>
        {selectedNodes.length > 0 && <button className="nc-button" onClick={() => { setSelectedNodes([]); setReview(null); }}>Clear selection</button>}
      </fieldset>
      {changing && <fieldset><legend>Components</legend>{available.length ? available.map((c) => <div className="nc-component-input" key={c}><label><input type="checkbox" checked={chosen.includes(c)} onChange={() => { setComponents((old) => old.includes(c) ? old.filter((v) => v !== c) : [...old, c]); setReview(null); }} />{labels[c]}</label>
        {action === 'upgrade' && chosen.includes(c) && <input type="text" aria-label={`${labels[c]} image`} placeholder={`${repositories[c]}:version`} value={images[c] || ''} onChange={(e) => { setImages((old) => ({ ...old, [c]: e.target.value })); setReview(null); }} />}</div>) : <p className="nc-muted">Select nodes to choose their components.</p>}
        {chosen.includes('drive') && <p className="nc-muted">Tenderdash will stop and restart with Drive; its image stays unchanged unless selected.</p>}
        {action === 'deploy' && <p className="nc-muted">Restart captured services using their current images. No reset or downgrade.</p>}
      </fieldset>}
    </div>
    <button className="nc-button" disabled={busy || !selectedNodes.length || (changing && !chosen.length)} onClick={prepare}>{busy ? 'Preparing…' : 'Prepare review'}</button>
    {error && <p role="alert" className="nc-error">{error}</p>}
    {selectionMatches && review?.status === 'preparing' && <p role="status">Checking the selected hosts and resolving exact image digests…</p>}
    {selectionMatches && review?.status === 'failed' && <p role="alert" className="nc-error">{review.notice || 'Plan preparation failed.'}</p>}
    {review?.status === 'ready' && plan && <section className="nc-review" aria-label="Review operation"><h3>{actions[review.action]} · review</h3>
      <p>{plan.targets.join(', ')}</p><p>{plan.preservesCore ? 'Core is preserved.' : 'Core is included.'} {plan.recovery}</p>
      {plan.enrollment && <p>Selected workloads will be enrolled without a service restart before execution.</p>}
      {plan.changes.length > 0 && <div className="nc-table-wrap"><table><thead><tr><th>Node</th><th>Component</th><th>Running image</th><th>Reviewed image</th></tr></thead><tbody>{plan.changes.map((c) => <tr key={`${c.node}/${c.component}`}><td>{c.node}</td><td>{labels[c.component]}{c.dependency && ' (restart dependency)'}</td><td className="nc-image">{c.from}</td><td className="nc-image">{c.to}</td></tr>)}</tbody></table></div>}
      <button className="nc-button primary" disabled={busy || !enabled} onClick={execute}>Run reviewed operation</button> <button className="nc-button" disabled={busy} onClick={() => setReview(null)}>Cancel</button>
    </section>}
    {operations.length > 0 && <section className="nc-operation-history"><h3>Recent operations</h3>{operations.map((o) => <article className="nc-operation" key={o.id}><div><strong>{actions[o.action]}</strong><small>{o.actor.login} · {o.targets?.join(', ')}</small></div><span>{o.conclusion || o.status}</span>{o.runUrl && <a href={o.runUrl} target="_blank" rel="noreferrer">View run</a>}{o.notice && <p>{o.notice}</p>}{o.actor.id === session.user.id && o.status === 'completed' && ['failure', 'cancelled', 'timed_out'].includes(o.conclusion) && <button className="nc-button" disabled={busy || !enabled} onClick={() => resume(o)}>Resume same plan</button>}</article>)}</section>}
  </section>;
}
