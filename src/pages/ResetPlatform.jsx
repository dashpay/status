import { useState } from 'react';
import { api, navigate, useResource, useSession } from '../lib.js';
import { Empty, Err, Link, Section } from '../ui.jsx';

const REPOS = { drive: 'dashpay/drive', dapi: 'dashpay/rs-dapi', tenderdash: 'dashpay/tenderdash' };

export default function ResetPlatform({ name }) {
  const session = useSession();
  const { data: n, error } = useResource(`/api/networks/${name}`);
  const [images, setImages] = useState(null);
  const [epoch, setEpoch] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  if (!session.loaded) return null;
  if (!session.admin) return <div className="mt-6"><Empty>Only admins can reset Platform.</Empty></div>;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!n) return <div className="mt-6 text-dim">Loading…</div>;
  if (n.chainType !== 'devnet' || n.kind === 'external') return <div className="mt-6"><Empty>Platform wipe/redeploy applies to dashmate-managed devnets.</Empty></div>;
  const native = n.kind === 'dashnet';
  const validators = n.hosts.filter((h) => h.role === 'validator' && !h.duplicate);
  const seeds = n.hosts.filter((h) => h.role === 'seed' && !h.duplicate);
  const current = (c) => {
    const counts = {};
    for (const h of validators) { const k = h.containers.find((x) => x.component === c && x.running); if (k) counts[k.image] = (counts[k.image] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || `${REPOS[c]}:`;
  };
  const value = images || { drive: current('drive'), dapi: current('dapi'), tenderdash: current('tenderdash') };
  const unreachable = [...validators, ...seeds].filter((h) => h.level === 'unreachable' || h.state !== 'running');
  async function submit() {
    setBusy(true); setSubmitError(null);
    try {
      const r = await api(`/api/networks/${name}/ops`, { method: 'POST', body: { action: 'platform-reset', ...(native ? {} : { images: value, options: { epochSeconds: epoch } }) } });
      navigate(`/n/${name}/ops/${r.id}`);
    } catch (e) { setSubmitError(e); setBusy(false); }
  }
  return (
    <div className="max-w-[1100px]">
      <div className="mt-4 flex items-center gap-3">
        <Link to={`/n/${name}`} className="text-dim hover:text-fg">← {n.displayName}</Link>
        <h1 className="text-[18px] font-semibold">Wipe and redeploy Platform</h1>
      </div>
      <p className="text-dim text-[12px] mt-1">Resets Platform state on {validators.length} HPMNs and {seeds.length} Tenderdash seed(s). Core chain, wallets, masternode registrations, node identities, certificates and Tor settings are preserved. Wallet, miner and web hosts are not touched.</p>
      <Section title="Targets">
        <div className="panel p-3 text-[12px] mono">{[...validators, ...seeds].map((h) => h.name).join('  ')}</div>
        {unreachable.length > 0 && <div className="lv-down text-[12px] mt-1">Not reachable: {unreachable.map((h) => h.name).join(', ')}. Every target must be reachable.</div>}
      </Section>
      <Section title="Version set">
        <div className="panel p-3 grid gap-3 sm:grid-cols-2">
          {native && <p className="sm:col-span-2 text-[12px] text-dim">Wipe and redeploy the installed release, keeping its image pins and epoch settings. Use Deploy to change versions.</p>}
          {Object.keys(REPOS).map((c) => (
            <label key={c} className="text-[12px]"><div className="text-dim mb-1">{c} <span className="mono">{REPOS[c]}</span> · running <span className="mono">{current(c)}</span></div>
              <input className="input w-full mono" readOnly={native} value={value[c]} onChange={(e) => setImages({ ...value, [c]: e.target.value.trim() })} /></label>
          ))}
          {!native && <label className="text-[12px]"><div className="text-dim mb-1">Epoch length (seconds; dashmate platform.drive.abci.epochTime)</div>
            <input className="input w-32 mono" value={epoch} onChange={(e) => setEpoch(Number(e.target.value) || 0)} /></label>}
        </div>
      </Section>
      <Section title="What runs">
        <ol className="panel p-3 text-[12px] list-decimal list-inside space-y-0.5">
          <li><b>Prepare (no changes):</b> baseline and private backups on every target, {native ? 'verify installed images' : 'pull images'}, fresh ChainLock anchor verified on every target, configuration canary {native ? 'on every HPMN' : 'on one HPMN'}.</li>
          <li><b>Review</b> the version set, anchor and canary, then confirm.</li>
          <li><b>Wipe</b> Platform on all HPMNs {native ? '(only the Drive and Tenderdash chain-data volumes)' : <>(<span className="mono">dashmate reset --platform --force</span>), then reset only the seed’s Tenderdash data directory</>}.</li>
          <li><b>Apply</b> the images, anchor and epoch; render only Platform files; start the seed, then every HPMN.</li>
          <li><b>Verify</b> READY, containers and images, consensus, epochs at config/env/parsed layers, DAPI TLS, Core unchanged.</li>
        </ol>
      </Section>
      <div className="mt-5 flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy || unreachable.length > 0} onClick={submit}>{busy ? 'Submitting…' : 'Prepare (non-destructive)'}</button>
        <span className="text-dim text-[12px]">Nothing is wiped until you confirm the prepared review.</span>
      </div>
      {submitError && <div className="mt-3"><Err error={submitError} /></div>}
    </div>
  );
}
