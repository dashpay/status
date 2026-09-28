import { useEffect, useState } from 'react';
import { api, useSession } from '../lib.js';
import { Empty, Err, Section } from '../ui.jsx';

const blankNetwork = () => ({ name: '', displayName: '', tag: '', chainType: 'devnet', coreNetwork: 'devnet-', p2pPort: 20001, public: true, deployable: true, showBalances: true, endpoints: [], observationWindow: '4m', operationTimeout: '110m', description: '' });

export default function Settings() {
  const session = useSession();
  const [doc, setDoc] = useState(null);
  const [saved, setSaved] = useState(null);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!session.user) return;
    api('/api/settings').then((r) => { setDoc(r.settings); setSaved(JSON.stringify(r.settings)); setAdmin(r.admin); }, setError);
  }, [session.user]);
  if (!session.loaded) return null;
  if (!session.user) return <div className="mt-6"><Empty>Sign in to view settings.</Empty></div>;
  if (error && !doc) return <div className="mt-6"><Err error={error} /></div>;
  if (!doc) return <div className="mt-6 text-dim">Loading…</div>;
  const dirty = JSON.stringify(doc) !== saved;
  const set = (fn) => setDoc((d) => { const x = structuredClone(d); fn(x); return x; });
  const save = async () => {
    setStatus('saving'); setError(null);
    try { const r = await api('/api/settings', { method: 'PUT', body: { settings: doc } }); setDoc(r.settings); setSaved(JSON.stringify(r.settings)); setStatus('saved'); }
    catch (e) { setError(e); setStatus(null); }
  };
  const ro = !admin;
  return (
    <div className="max-w-[1100px] pb-24">
      <div className="mt-4 flex items-center gap-3">
        <h1 className="text-[18px] font-semibold">Settings</h1>
        <span className="text-dim text-[12px]">applied by the agent on its next cycle; no restart. {ro ? 'Read-only: only operators with access to all networks can edit.' : ''}</span>
      </div>

      <Section title="Collection">
        <div className="panel p-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField label="Probe interval (s)" value={doc.pollSeconds} ro={ro} onChange={(v) => set((d) => { d.pollSeconds = v; })} />
          <NumberField label="EC2 discovery interval (s)" value={doc.discoverySeconds} ro={ro} onChange={(v) => set((d) => { d.discoverySeconds = v; })} />
          <TextField label="AWS region" value={doc.aws.region} ro={ro} onChange={(v) => set((d) => { d.aws.region = v; })} />
          <TextField label="Network tag key" value={doc.aws.tagKey} ro={ro} onChange={(v) => set((d) => { d.aws.tagKey = v; })} />
          <TextField label="AWS account" value={doc.aws.accountId} ro={ro} onChange={(v) => set((d) => { d.aws.accountId = v; })} />
          <TextField label="dashnet journal table" value={doc.aws.stateTable} ro={ro} onChange={(v) => set((d) => { d.aws.stateTable = v; })} />
        </div>
      </Section>

      <Section title="Thresholds">
        <div className="panel p-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <NumberField label="Core lag warn (blocks)" value={doc.thresholds.coreLagBlocks} ro={ro} onChange={(v) => set((d) => { d.thresholds.coreLagBlocks = v; })} />
          <NumberField label="Platform lag warn (blocks)" value={doc.thresholds.platformLagBlocks} ro={ro} onChange={(v) => set((d) => { d.thresholds.platformLagBlocks = v; })} />
          <NumberField label="Disk warn (%)" value={doc.thresholds.diskWarnPercent} ro={ro} onChange={(v) => set((d) => { d.thresholds.diskWarnPercent = v; })} />
          <NumberField label="Memory warn (%)" value={doc.thresholds.memWarnPercent} ro={ro} onChange={(v) => set((d) => { d.thresholds.memWarnPercent = v; })} />
          <NumberField label="Faucet wallet warn (DASH)" value={doc.thresholds.balanceWarn} ro={ro} float onChange={(v) => set((d) => { d.thresholds.balanceWarn = v; })} />
        </div>
      </Section>

      <Section title="Operators (GitHub accounts)" right={!ro && <button className="btn" onClick={() => set((d) => { d.operators.push({ id: 0, login: '', networks: [] }); })}>Add operator</button>}>
        <div className="panel scroll-x">
          <table className="grid"><thead><tr><th>GitHub user id</th><th>login</th><th>networks (* = all, also grants settings)</th><th /></tr></thead>
            <tbody className="[&_tr]:!cursor-default">
              {doc.operators.map((o, i) => (
                <tr key={i}>
                  <td><input className="input w-32 mono" disabled={ro} value={o.id || ''} onChange={(e) => set((d) => { d.operators[i].id = Number(e.target.value.replace(/\D/g, '')) || 0; })} /></td>
                  <td><input className="input w-40" disabled={ro} value={o.login} onChange={(e) => set((d) => { d.operators[i].login = e.target.value.trim(); })} /></td>
                  <td><input className="input w-80 mono" disabled={ro} value={o.networks.join(', ')} onChange={(e) => set((d) => { d.operators[i].networks = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); })} /></td>
                  <td>{!ro && <button className="btn btn-danger !py-0.5" onClick={() => set((d) => { d.operators.splice(i, 1); })}>remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-dim text-[11.5px] mt-1">User id: <span className="mono">https://api.github.com/users/&lt;login&gt;</span> → <span className="mono">id</span>.</div>
      </Section>

      <Section title="Networks" right={!ro && <button className="btn" onClick={() => set((d) => { d.networks.push(blankNetwork()); })}>Add network</button>}>
        <div className="space-y-3">
          {doc.networks.map((n, i) => <NetworkEditor key={i} n={n} ro={ro} update={(fn) => set((d) => fn(d.networks[i]))} remove={() => set((d) => { d.networks.splice(i, 1); })} />)}
        </div>
      </Section>

      {!ro && (
        <div className="fixed bottom-0 inset-x-0 border-t border-line bg-[#0c1016]/95 backdrop-blur">
          <div className="mx-auto max-w-[1680px] px-4 py-2.5 flex items-center gap-3">
            <button className="btn btn-primary" disabled={!dirty || status === 'saving'} onClick={save}>{status === 'saving' ? 'Saving…' : 'Save settings'}</button>
            <button className="btn" disabled={!dirty} onClick={() => setDoc(JSON.parse(saved))}>Discard</button>
            <span className="text-dim text-[12px]">{dirty ? 'unsaved changes' : status === 'saved' ? 'saved' : ''}</span>
            {error && <span className="lv-down text-[12px] mono">{error.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function NetworkEditor({ n, ro, update, remove }) {
  return (
    <div className="panel">
      <div className="px-3 py-2 border-b border-line flex items-center gap-3">
        <span className="font-medium">{n.displayName || '(new network)'}</span><span className="mono text-dim text-[12px]">{n.name}</span>
        {!ro && <button className="btn btn-danger !py-0.5 ml-auto" onClick={remove}>Remove</button>}
      </div>
      <div className="p-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label="Name (id)" value={n.name} ro={ro} mono onChange={(v) => update((x) => { x.name = v; })} />
        <TextField label="Display name" value={n.displayName} ro={ro} onChange={(v) => update((x) => { x.displayName = v; })} />
        <TextField label="EC2 tag value / name prefix dn-<tag>-" value={n.tag} ro={ro} mono onChange={(v) => update((x) => { x.tag = v; })} />
        <label className="text-[12px]"><div className="text-dim mb-1">Chain type</div>
          <select className="input w-full" disabled={ro} value={n.chainType} onChange={(e) => update((x) => { x.chainType = e.target.value; if (e.target.value === 'mainnet') x.deployable = false; })}>
            <option value="testnet">testnet</option><option value="devnet">devnet</option><option value="mainnet">mainnet</option>
          </select></label>
        <TextField label="Core chain (getblockchaininfo.chain)" value={n.coreNetwork} ro={ro} mono onChange={(v) => update((x) => { x.coreNetwork = v; })} />
        <NumberField label="Core P2P port (fallback)" value={n.p2pPort} ro={ro} onChange={(v) => update((x) => { x.p2pPort = v; })} />
        <TextField label="Health observation window" value={n.observationWindow} ro={ro} mono onChange={(v) => update((x) => { x.observationWindow = v; })} />
        <TextField label="Operation timeout" value={n.operationTimeout} ro={ro} mono onChange={(v) => update((x) => { x.operationTimeout = v; })} />
        <Toggle label="Public (visible without sign-in)" value={n.public} ro={ro} onChange={(v) => update((x) => { x.public = v; })} />
        <Toggle label="Deployable from console" value={n.deployable} ro={ro || n.chainType === 'mainnet'} onChange={(v) => update((x) => { x.deployable = v; })} />
        <Toggle label="Show wallet balances publicly" value={n.showBalances} ro={ro} onChange={(v) => update((x) => { x.showBalances = v; })} />
        <label className="text-[12px] sm:col-span-2 lg:col-span-4"><div className="text-dim mb-1">Description (optional, shown under the title)</div>
          <input className="input w-full" disabled={ro} value={n.description || ''} onChange={(e) => update((x) => { x.description = e.target.value; })} /></label>
      </div>
      <div className="px-3 pb-3">
        <div className="text-dim text-[12px] mb-1 flex items-center gap-3">Endpoints checked from the status host
          {!ro && <button className="btn !py-0.5" onClick={() => update((x) => { x.endpoints.push({ label: '', url: 'https://' }); })}>add</button>}</div>
        {n.endpoints.map((e, j) => (
          <div key={j} className="flex gap-2 mb-1.5 items-center">
            <input className="input w-40" disabled={ro} placeholder="label" value={e.label} onChange={(ev) => update((x) => { x.endpoints[j].label = ev.target.value; })} />
            <input className="input flex-1 mono" disabled={ro} value={e.url} onChange={(ev) => update((x) => { x.endpoints[j].url = ev.target.value.trim(); })} />
            <select className="input w-40" disabled={ro} value={e.kind || 'http'} onChange={(ev) => update((x) => { if (ev.target.value === 'http') delete x.endpoints[j].kind; else x.endpoints[j].kind = ev.target.value; })}>
              <option value="http">HTTP GET</option><option value="dapi">DAPI getStatus</option>
            </select>
            {!ro && <button className="btn btn-danger !py-0.5" onClick={() => update((x) => { x.endpoints.splice(j, 1); })}>×</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, ro, mono }) {
  return <label className="text-[12px]"><div className="text-dim mb-1">{label}</div><input className={`input w-full ${mono ? 'mono' : ''}`} disabled={ro} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></label>;
}
function NumberField({ label, value, onChange, ro, float }) {
  return <label className="text-[12px]"><div className="text-dim mb-1">{label}</div><input className="input w-full mono" disabled={ro} inputMode="decimal" value={value ?? ''} onChange={(e) => { const v = float ? parseFloat(e.target.value) : parseInt(e.target.value, 10); onChange(Number.isFinite(v) ? v : 0); }} /></label>;
}
function Toggle({ label, value, onChange, ro }) {
  return <label className={`text-[12px] flex items-center gap-2 ${ro ? 'opacity-60' : 'cursor-pointer'}`}><input type="checkbox" disabled={ro} checked={!!value} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}
