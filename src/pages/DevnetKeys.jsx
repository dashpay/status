import { useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Section } from '../ui.jsx';

function KeyValue({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return <div className="min-w-0"><div className="flex items-center justify-between gap-2 text-[11px] text-dim"><span>{label}</span><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { setCopied(false); } }}>{copied ? 'copied' : 'copy'}</button></div><input aria-label={label} readOnly value={value} className="mono w-full min-w-0 text-[11px] p-2 bg-panel-2 border border-line rounded" /></div>;
}
function download(data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${data.network}-private-keys.json` });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function DevnetKeys({ name }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => setData(null), 5 * 60_000);
    const hide = () => { if (document.hidden) setData(null); };
    document.addEventListener('visibilitychange', hide);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [data]);
  async function reveal() {
    setBusy(true); setError('');
    try { const result = await api(`/api/networks/${name}/keys`, { method: 'POST', body: {} }); if (!document.hidden) setData(result); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <Section title="Private devnet keys" right={<span className="text-faint text-[11px]">Devnet operators</span>}>
    <div className="panel p-3 space-y-3">
      <p className="text-dim text-[12px]">Voting, owner, collateral, BLS operator and Platform node keys for this devnet. Loaded on demand and cleared from this view after five minutes or when you switch tabs.</p>
      <div className="flex flex-wrap gap-2">{!data ? <button type="button" className="btn btn-primary" disabled={busy} onClick={reveal}>{busy ? 'Verifying nodes and loading keys…' : 'Reveal private keys'}</button> : <><button type="button" className="btn" onClick={() => setData(null)}>Hide keys</button><button type="button" className="btn" onClick={() => download(data)}>Download private keys (.json)</button><span className="text-faint text-[11px] self-center">Verified {data.verifiedAt}</span></>}</div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {data && <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">{['spork', 'payout', 'faucet'].map(k => <KeyValue key={k} label={`${k} private key (WIF)`} value={data.networkKeys?.[`${k}PrivateKey`]} />)}</div>
        {data.validators.map(h => <details key={h.name} className="border border-line rounded p-3"><summary className="cursor-pointer text-[12px] mono">{h.name} · {h.proTxHash.slice(0, 16)}…</summary><div className="grid gap-3 md:grid-cols-2 mt-3">
          <KeyValue label="ProTx hash" value={h.proTxHash} />
          <KeyValue label="BLS operator private key (hex)" value={h.operatorPrivateKey} />
          <KeyValue label="Voting address" value={h.votingAddress} /><KeyValue label="Voting private key (WIF)" value={h.votingPrivateKey} />
          <KeyValue label="Owner address" value={h.ownerAddress} /><KeyValue label="Owner private key (WIF)" value={h.ownerPrivateKey} />
          <KeyValue label="Collateral address" value={h.collateralAddress} /><KeyValue label="Collateral private key (WIF)" value={h.collateralPrivateKey} />
          <KeyValue label="Platform node ID" value={h.platformNodeId} /><KeyValue label="Platform P2P private key (base64)" value={h.platformNodePrivateKey} />
        </div></details>)}
      </div>}
    </div>
  </Section>;
}
