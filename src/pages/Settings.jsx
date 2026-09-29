import { useEffect, useState } from 'react';
import { api, setLeaveGuard, useSession } from '../lib.js';
import { Empty, Err, Section } from '../ui.jsx';

const ROLE_TEXT = { admin: 'all networks, deployments, settings and users', operator: 'deploy and operate the granted networks', viewer: 'read-only, including private networks and operation logs' };

const blankNetwork = () => ({ name: '', displayName: '', tag: '', chainType: 'devnet', coreNetwork: 'devnet-', p2pPort: 20001, public: true, deployable: true, showBalances: true, endpoints: [], observationWindow: '4m', operationTimeout: '110m', description: '' });

// Warn before leaving with unsaved (non-access) settings.
function useLeaveGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    setLeaveGuard('Settings have unsaved changes. Leave without saving?');
    return () => { window.removeEventListener('beforeunload', warn); setLeaveGuard(null); };
  }, [dirty]);
}

export default function Settings() {
  const session = useSession();
  const [doc, setDoc] = useState(null);
  const [saved, setSaved] = useState(null);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  useLeaveGuard(doc && saved && JSON.stringify(doc) !== saved);
  useEffect(() => {
    if (!session.user) return;
    api('/api/settings').then((r) => { setDoc(r.settings); setSaved(JSON.stringify(r.settings)); setAdmin(r.admin); }, setError);
  }, [session.user]);
  if (!session.loaded) return null;
  if (!session.user) return <div className="mt-6"><Empty>Sign in to view settings.</Empty></div>;
  if (error && !doc) return <div className="mt-6"><Err error={error} /></div>;
  if (!doc) return <div className="mt-6 text-dim">Loading…</div>;
  const dirty = JSON.stringify(doc) !== saved;
  // Access is saved on every change; keep the draft and the saved copy in step.
  const setOperators = (operators) => {
    setDoc((d) => ({ ...d, operators }));
    setSaved((x) => JSON.stringify({ ...JSON.parse(x), operators }));
  };
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
        <span className="text-dim text-[12px]">applied by the agent on its next cycle; no restart. {ro ? 'Read-only: only admins can edit.' : ''}</span>
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

      <Access doc={doc} ro={ro} setOperators={setOperators} self={session.user} />

      <DevnetDefaults d={doc.devnets} ro={ro} update={(fn) => set((x) => fn(x.devnets))} />

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
        <TextField label="Operation timeout (per node)" value={n.operationTimeout} ro={ro} mono onChange={(v) => update((x) => { x.operationTimeout = v; })} />
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

function Access({ doc, ro, setOperators, self }) {
  const [login, setLogin] = useState('');
  const [found, setFound] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [role, setRole] = useState('operator');
  const [networks, setNetworks] = useState([]);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  // Every access change is saved at once, through the server's current copy.
  const write = async (id, change, done) => {
    setBusy(id); setNote(null);
    try {
      const r = await api(`/api/access/${id}`, change ? { method: 'PUT', body: change } : { method: 'DELETE' });
      setOperators(r.operators); done?.(); setNote({ ok: true, text: 'saved' });
    } catch (e) { setNote({ ok: false, text: e.message }); }
    setBusy(null);
  };
  const names = doc.networks.map((n) => n.name);
  const lookup = async (e) => {
    e?.preventDefault();
    setFound(null); setLookupError(null);
    try { setFound(await api(`/api/github/users/${encodeURIComponent(login.trim().replace(/^@/, ''))}`)); }
    catch (err) { setLookupError(err.message); }
  };
  const existing = found && doc.operators.find((o) => o.id === found.id);
  const add = () => write(found.id, { login: found.login, role, networks: role === 'admin' ? ['*'] : networks }, () => { setFound(null); setLogin(''); setNetworks([]); });
  const toggle = (list, n) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n]);
  return (
    <Section title={`Access · ${doc.operators.length} GitHub account(s)`}>
      {!ro && (
        <form onSubmit={lookup} className="panel p-3 mb-2 flex flex-wrap items-center gap-3">
          <span className="text-dim text-[12px]">Add a GitHub user</span>
          <input className="input w-56" placeholder="GitHub login, e.g. octocat" value={login} onChange={(e) => setLogin(e.target.value)} />
          <button className="btn" disabled={!login.trim()}>Look up</button>
          {lookupError && <span className="lv-down text-[12px]">{lookupError}</span>}
          {found && (
            <div className="w-full flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <img src={found.avatar} alt="" className="w-8 h-8 rounded-full" />
              <div><div className="font-medium">{found.name || found.login}</div><div className="text-dim mono text-[11px]">@{found.login} · id {found.id}{found.type !== 'User' ? ` · ${found.type}` : ''}</div></div>
              {existing ? <span className="lv-warn text-[12px]">already has {existing.role} access</span> : <>
                <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
                </select>
                {role !== 'admin' && <div className="flex flex-wrap gap-1">{names.map((n) => <span key={n} className={`chip ${networks.includes(n) ? 'on' : ''}`} onClick={() => setNetworks((l) => toggle(l, n))}>{n}</span>)}
                  <span className={`chip ${networks.includes('*') ? 'on' : ''}`} onClick={() => setNetworks((l) => toggle(l, '*'))}>all networks</span></div>}
                <span className="text-dim text-[11.5px]">{ROLE_TEXT[role]}</span>
                <button type="button" className="btn btn-primary" disabled={busy !== null || (role !== 'admin' && !networks.length)} onClick={add}>{busy === found.id ? 'Adding…' : `Add @${found.login}`}</button>
              </>}
            </div>
          )}
        </form>
      )}
      <div className="panel scroll-x">
        <table className="grid"><thead><tr><th>account</th><th>role</th><th>networks</th><th /></tr></thead>
          <tbody className="[&_tr]:!cursor-default">
            {doc.operators.map((o, i) => {
              const r = o.role || (o.networks.includes('*') ? 'admin' : 'operator');
              const me = self?.id === o.id;
              return (
                <tr key={o.id || i}>
                  <td><span className="flex items-center gap-2"><img src={`https://avatars.githubusercontent.com/u/${o.id}?s=40`} alt="" className="w-5 h-5 rounded-full" /><span className="mono">@{o.login}</span><span className="text-faint mono text-[11px]">{o.id}</span>{me && <span className="tag">you</span>}</span></td>
                  <td>
                    <select className="input" disabled={ro || me || busy !== null} value={r} onChange={(e) => write(o.id, { login: o.login, role: e.target.value, networks: e.target.value === 'admin' ? ['*'] : o.networks })}>
                      <option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="!whitespace-normal">
                    {r === 'admin' ? <span className="text-dim">all networks</span> : <div className="flex flex-wrap gap-1">
                      {['*', ...names].map((n) => <span key={n} className={`chip ${o.networks.includes(n) ? 'on' : ''} ${ro || me || busy !== null ? 'pointer-events-none' : ''}`} onClick={() => { const next = toggle(o.networks, n); if (next.length) write(o.id, { login: o.login, role: r, networks: next }); }}>{n === '*' ? 'all networks' : n}</span>)}
                    </div>}
                  </td>
                  <td>{!ro && !me && <button className="btn btn-danger !py-0.5" disabled={busy !== null} onClick={() => write(o.id, null)}>{busy === o.id ? '…' : 'remove'}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-dim text-[11.5px] mt-1">Access is bound to the GitHub numeric user id, so a renamed account keeps its access. Access changes are saved immediately.{note && <span className={`ml-2 ${note.ok ? 'lv-ok' : 'lv-down'}`}>{note.text}</span>}</div>
    </Section>
  );
}

function DevnetDefaults({ d, ro, update }) {
  if (!d) return null;
  const T = (label, key, mono = true) => <TextField label={label} value={d[key]} ro={ro} mono={mono} onChange={(v) => update((x) => { x[key] = v.trim(); })} />;
  const N = (label, key) => <NumberField label={label} value={d[key]} ro={ro} onChange={(v) => update((x) => { x[key] = v; })} />;
  return (
    <Section title="New devnet defaults">
      <div className="panel">
        <div className="p-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {T('VPC', 'vpcId')}{T('Subnet', 'subnetId')}
          <TextField label="Security groups (comma separated)" value={d.securityGroupIds.join(', ')} ro={ro} mono onChange={(v) => update((x) => { x.securityGroupIds = v.split(',').map((g) => g.trim()).filter(Boolean); })} />
          {T('EC2 key pair (agent key)', 'keyName')}{T('BYOIP IPAM pool', 'ipamPoolId')}{T('Route 53 zone', 'dnsZoneId')}{T('DNS suffix', 'dnsSuffix')}{N('Root disk GiB', 'rootVolumeGiB')}
          {N('Validators', 'validators')}{T('Validator type', 'validatorType')}{T('Validator arch', 'validatorArch')}{N('Platform protocol', 'protocol')}
          <NumberField label="Platform epoch, seconds (3600 = 1 h)" value={d.platformEpochSeconds ?? 3600} ro={ro} onChange={(v) => update((x) => { x.platformEpochSeconds = v; })} />
          {T('Wallet + services type', 'walletType')}{T('Wallet + services arch', 'walletArch')}
        </div>
        <div className="px-3 pb-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.keys(d.images).map((c) => <TextField key={c} label={`${c} image`} value={d.images[c]} ro={ro} mono onChange={(v) => update((x) => { x.images[c] = v.trim(); })} />)}
        </div>
        <div className="px-3 pb-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 border-t border-line pt-3">
          <TextField label="Quorum list server image" value={d.services.quorumServer} ro={ro} mono onChange={(v) => update((x) => { x.services.quorumServer = v.trim(); })} />
          <TextField label="ACME contact (Let's Encrypt gateway certificates)" value={d.acmeEmail || ''} ro={ro} mono onChange={(v) => update((x) => { x.acmeEmail = v.trim(); })} />
          <TextField label="Insight (Core explorer) image" value={d.services.insightImage} ro={ro} mono onChange={(v) => update((x) => { x.services.insightImage = v.trim(); })} />
          <TextField label="Platform Explorer release" value={d.services.explorerVersion} ro={ro} mono onChange={(v) => update((x) => { x.services.explorerVersion = v.trim(); })} />
          <TextField label="dash-faucet commit" value={d.services.faucetRef} ro={ro} mono onChange={(v) => update((x) => { x.services.faucetRef = v.trim(); })} />
          <NumberField label="Faucet payout (DASH)" value={d.services.faucetAmount} ro={ro} float onChange={(v) => update((x) => { x.services.faucetAmount = v; })} />
          <NumberField label="Faucet requests per IP per hour" value={d.services.faucetRateLimit} ro={ro} onChange={(v) => update((x) => { x.services.faucetRateLimit = v; })} />
          <NumberField label="Faucet wallet funding (DASH)" value={d.services.faucetFunding} ro={ro} float onChange={(v) => update((x) => { x.services.faucetFunding = v; })} />
        </div>
      </div>
    </Section>
  );
}
