import { useEffect, useState } from 'react';
import { api, navigate, span, useSession } from '../lib.js';
import { Empty, Err, Link, Section } from '../ui.jsx';

const COMPONENTS = ['core', 'drive', 'dapi', 'tenderdash', 'gateway', 'helper'];
const REPOS = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper' };
// On-demand us-west-2 Linux prices, $/hour; an estimate for the form only.
const PRICES = { 't4g.small': 0.0168, 't4g.medium': 0.0336, 't4g.large': 0.0672, 't4g.xlarge': 0.1344, 't3.medium': 0.0416, 't3.large': 0.0832, 't3.xlarge': 0.1664, 'm7g.medium': 0.0408, 'm7g.large': 0.0816, 'm6a.large': 0.0864, 'm7i.large': 0.1008, 'c7g.large': 0.0725 };
const TYPES = { arm64: ['t4g.small', 't4g.medium', 't4g.large', 't4g.xlarge', 'm7g.medium', 'm7g.large', 'c7g.large'], amd64: ['t3.medium', 't3.large', 't3.xlarge', 'm6a.large', 'm7i.large'] };

export default function NewDevnet() {
  const session = useSession();
  const [defaults, setDefaults] = useState(null);
  const [existing, setExisting] = useState([]);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!session.admin) return;
    api('/api/devnets/defaults').then((r) => { setDefaults(r.defaults); setForm(structuredClone(r.defaults)); setExisting(r.existing); }, setError);
  }, [session.admin]);
  if (!session.loaded) return null;
  if (!session.admin) return <div className="mt-6"><Empty>Only admins can create devnets.</Empty></div>;
  if (!form) return <div className="mt-6">{error ? <Err error={error} /> : <span className="text-dim">Loading…</span>}</div>;

  const full = `devnet-${name}`;
  const set = (fn) => setForm((f) => { const x = structuredClone(f); fn(x); return x; });
  const hourly = form.validators * (PRICES[form.validatorType] ?? NaN) + (PRICES[form.walletType] ?? NaN);
  const storage = (form.validators + 1) * form.rootVolumeGiB * 0.08;
  const problems = [];
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) problems.push('name: lowercase letters, digits and dashes, 2-31 characters');
  if (existing.includes(full)) problems.push(`${full} already exists; names cannot be reused`);
  if (form.validators < 13 || form.validators > 25) problems.push('13 to 25 validators');
  for (const c of COMPONENTS) if ((form.images[c] || '').replace(/^docker\.io\//, '').split(/[@:]/)[0] !== REPOS[c]) problems.push(`${c} image must be ${REPOS[c]}:<tag>`);
  if (form.images.acme && form.images.acme.replace(/^docker\.io\//, '').split(/[@:]/)[0] !== 'goacme/lego') problems.push('ACME client image must be goacme/lego:<tag>, or empty for self-signed gateways');
  const blockTime = form.blockTimeSeconds ?? 10;
  if (!Number.isInteger(blockTime) || blockTime < 8 || blockTime > 600) problems.push('Core block time 8 to 600 seconds');
  const epoch = form.platformEpochSeconds ?? 3600;
  if (!Number.isInteger(epoch) || epoch < 60 || epoch > 30 * 86400) problems.push('Platform epoch 60 seconds to 30 days');

  async function submit() {
    setBusy(true); setError(null);
    try {
      // Placement and the ACME contact always come from Settings.
      const { vpcId, subnetId, securityGroupIds, keyName, ipamPoolId, dnsZoneId, dnsSuffix, acmeEmail, ...devnet } = form;
      void vpcId; void subnetId; void securityGroupIds; void keyName; void ipamPoolId; void dnsZoneId; void dnsSuffix; void acmeEmail;
      const r = await api('/api/devnets', { method: 'POST', body: { name: full, devnet } });
      navigate(`/n/${r.network}/ops/${r.id}`);
    } catch (e) { setError(e); setBusy(false); }
  }

  return (
    <div className="max-w-[1100px] pb-10">
      <div className="mt-4 flex items-center gap-3">
        <Link to="/" className="text-dim hover:text-fg">← Overview</Link>
        <h1 className="text-[18px] font-semibold">New devnet</h1>
        <span className="text-dim text-[12px]">dash-network-go provision → bootstrap → Core, then faucet, Insight and quorum server; Platform and its explorer start by themselves once the quorums form</span>
      </div>

      <Section title="1 · Name">
        <div className="panel p-3 grid gap-4 sm:grid-cols-3">
          <label className="text-[12px]"><div className="text-dim mb-1">Network name (permanent)</div>
            <div className="flex items-center"><span className="mono text-dim pr-1">devnet-</span><input className="input mono flex-1" value={name} autoFocus onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="bonsai" /></div></label>
          <label className="text-[12px]"><div className="text-dim mb-1">Display name</div><input className="input w-full" value={form.displayName || ''} placeholder={name ? name.replace(/(^|-)([a-z])/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase()) : ''} onChange={(e) => set((f) => { f.displayName = e.target.value; })} /></label>
          <div className="text-[12px] text-dim self-end">Core chain <span className="mono text-fg">devnet-{name || '…'}-g1</span><br />Platform <span className="mono text-fg">dash-devnet-{name || '…'}-g1</span><br />
            Services <span className="mono text-fg">{['insight', 'quorums', 'explorer', 'faucet'].map((s) => `${s}.${name || '…'}.${form.dnsSuffix}`).join(', ')}</span></div>
        </div>
      </Section>

      <Section title="2 · Hosts">
        <div className="panel p-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <label className="text-[12px]"><div className="text-dim mb-1">Validators (evo nodes)</div><input className="input w-full mono" type="number" min="13" max="25" value={form.validators} onChange={(e) => set((f) => { f.validators = Number(e.target.value); })} /></label>
          <Select label="Validator arch" value={form.validatorArch} options={['arm64', 'amd64']} onChange={(v) => set((f) => { f.validatorArch = v; f.validatorType = TYPES[v].includes(f.validatorType) ? f.validatorType : TYPES[v][1]; })} />
          <Select label="Validator type" value={form.validatorType} options={TYPES[form.validatorArch]} onChange={(v) => set((f) => { f.validatorType = v; })} />
          <Select label="Wallet + services arch" value={form.walletArch} options={['amd64', 'arm64']} onChange={(v) => set((f) => { f.walletArch = v; f.walletType = TYPES[v].includes(f.walletType) ? f.walletType : TYPES[v][1]; })} />
          <Select label="Wallet + services type" value={form.walletType} options={TYPES[form.walletArch]} onChange={(v) => set((f) => { f.walletType = v; })} />
          <label className="text-[12px]"><div className="text-dim mb-1">Root disk GiB each</div><input className="input w-full mono" type="number" min="30" value={form.rootVolumeGiB} onChange={(e) => set((f) => { f.rootVolumeGiB = Number(e.target.value); })} /></label>
        </div>
        <div className="text-[12px] text-dim mt-1.5">
          {form.validators + 1} instances, {(form.validators + 1) * form.rootVolumeGiB} GiB gp3, public BYOIP addresses.
          Estimate <span className="text-fg mono">${Number.isFinite(hourly) ? hourly.toFixed(2) : '?'}/h</span> compute + <span className="text-fg mono">${storage.toFixed(0)}/month</span> storage (≈ <span className="text-fg mono">${Number.isFinite(hourly) ? Math.round(hourly * 730 + storage) : '?'}/month</span>).
          {form.walletArch === 'arm64' && <span className="lv-warn"> Platform Explorer images are amd64-only; keep the services host on amd64.</span>}
        </div>
      </Section>

      <Section title="3 · Versions">
        <div className="panel p-3 grid gap-3 sm:grid-cols-2">
          {COMPONENTS.map((c) => <ImageField key={c} c={c} value={form.images[c]} fallback={defaults.images[c]} onChange={(v) => set((f) => { f.images[c] = v; })} />)}
          <label className="text-[12px]"><div className="text-dim mb-1">ACME client <span className="mono">goacme/lego</span> · Let's Encrypt certificate for each validator's public IP (empty: self-signed)</div>
            <input className="input w-full mono" value={form.images.acme || ''} onChange={(e) => set((f) => { f.images.acme = e.target.value.trim(); })} /></label>
          <label className="text-[12px]"><div className="text-dim mb-1">Platform protocol number (4.2.x = 14, 4.1.x = 13)</div><input className="input w-28 mono" type="number" value={form.protocol} onChange={(e) => set((f) => { f.protocol = Number(e.target.value); })} /></label>
          <label className="text-[12px]"><div className="text-dim mb-1">Core block time, seconds (8–600; legacy devnets used 150). Quorums form within about 25 blocks; slower blocks mean a later Platform and slower Core upgrades.</div>
            <input className="input w-28 mono" type="number" min="8" max="600" value={blockTime} onChange={(e) => set((f) => { f.blockTimeSeconds = Number(e.target.value); })} /></label>
          <label className="text-[12px]"><div className="text-dim mb-1">Platform epoch, seconds (60 s to 30 days; mainnet runs 9.125 days). Fees are distributed and protocol upgrades take effect at epoch boundaries.</div>
            <span className="flex items-center gap-2">
              <input className="input w-28 mono" type="number" min="60" max={30 * 86400} value={epoch} onChange={(e) => set((f) => { f.platformEpochSeconds = Number(e.target.value); })} />
              <span className="text-dim mono">{Number.isInteger(epoch) && epoch > 0 ? `= ${span(epoch)}` : ''}</span>
              {[[600, '10 min'], [3600, '1 h'], [86400, '1 d']].map(([s, l]) => <button key={s} type="button" className={`tag !cursor-pointer ${epoch === s ? '!text-fg !border-accent' : ''}`} onClick={() => set((f) => { f.platformEpochSeconds = s; })}>{l}</button>)}
            </span></label>
        </div>
      </Section>

      <Section title="4 · Services (wallet host)">
        <div className="panel p-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Text label="Quorum list server image" value={form.services.quorumServer} onChange={(v) => set((f) => { f.services.quorumServer = v; })} />
          <Text label="Insight (Core explorer) image" value={form.services.insightImage} onChange={(v) => set((f) => { f.services.insightImage = v; })} />
          <Text label="Platform Explorer release" value={form.services.explorerVersion} onChange={(v) => set((f) => { f.services.explorerVersion = v; })} />
          <Text label="dash-faucet commit" value={form.services.faucetRef} onChange={(v) => set((f) => { f.services.faucetRef = v; })} />
          <Num label="Faucet payout (DASH)" value={form.services.faucetAmount} onChange={(v) => set((f) => { f.services.faucetAmount = v; })} />
          <Num label="Faucet requests per IP per hour" value={form.services.faucetRateLimit} onChange={(v) => set((f) => { f.services.faucetRateLimit = v; })} />
          <Num label="Faucet wallet funding (DASH)" value={form.services.faucetFunding} onChange={(v) => set((f) => { f.services.faucetFunding = v; })} />
        </div>
      </Section>

      <div className="mt-5 flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy || problems.length > 0} onClick={submit}>{busy ? 'Submitting…' : 'Prepare plan for review'}</button>
        <span className="text-dim text-[12px]">{problems[0] || 'Read-only planning first; nothing is created until you confirm the reviewed footprint.'}</span>
      </div>
      {error && <div className="mt-3"><Err error={error} /></div>}
    </div>
  );
}

function Select({ label, value, options, onChange }) {
  return <label className="text-[12px]"><div className="text-dim mb-1">{label}</div><select className="input w-full" value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></label>;
}
function Text({ label, value, onChange }) {
  return <label className="text-[12px]"><div className="text-dim mb-1">{label}</div><input className="input w-full mono" value={value} onChange={(e) => onChange(e.target.value.trim())} /></label>;
}
function Num({ label, value, onChange }) {
  return <label className="text-[12px]"><div className="text-dim mb-1">{label}</div><input className="input w-full mono" inputMode="decimal" value={value} onChange={(e) => { const v = Number(e.target.value); onChange(Number.isFinite(v) ? v : 0); }} /></label>;
}
function ImageField({ c, value, fallback, onChange }) {
  const [tags, setTags] = useState(null);
  useEffect(() => { api(`/api/images/${c}/tags`).then((r) => setTags(r.tags), () => setTags([])); }, [c]);
  return (
    <label className="text-[12px]"><div className="text-dim mb-1">{c} <span className="mono">{REPOS[c]}</span>{value !== fallback && <span className="lv-warn ml-2">changed</span>}</div>
      <input className="input w-full mono" list={`nd-${c}`} value={value} onChange={(e) => onChange(e.target.value.includes('/') || !e.target.value ? e.target.value.trim() : `${REPOS[c]}:${e.target.value.trim()}`)} />
      <datalist id={`nd-${c}`}>{(tags || []).map((t) => <option key={t.name} value={`${REPOS[c]}:${t.name}`}>{t.arches.join(',')}</option>)}</datalist>
    </label>
  );
}
