import { useMemo, useState } from 'react';
import { ago, bytes, clock, useNow, useResource, useSession } from '../lib.js';
import { Empty, Err, Section, Stat } from '../ui.jsx';
import { Columns, HBars, TipLayer, TipRow } from '../charts.jsx';
import { SERIES, useTip } from '../viz.js';

const usd = (v, digits = 0) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const STATE = { running: 'lv-ok', stopped: 'text-dim', stopping: 'lv-warn', pending: 'lv-info', 'shutting-down': 'lv-warn', terminated: 'text-faint' };
// Rough monthly list prices (us-east-1) for things that cost money while idle.
const EIP_MONTH = 3.65, GP_GIB_MONTH = 0.08, SNAP_GIB_MONTH = 0.05, ECR_GB_MONTH = 0.10;

export default function Aws() {
  const session = useSession();
  const now = useNow(5000);
  // Signed out (or without access) the server sends spend and breakdowns only.
  const { data, error } = useResource(session.loaded ? `/api/aws?as=${session.user?.id || 'public'}` : null, (t) => t === 'aws');
  const [bind, tip] = useTip();
  if (!session.loaded) return <div className="mt-6 text-dim">Loading…</div>;
  if (error) return <div className="mt-6">{error.status === 404 ? <Empty>{error.message}</Empty> : <Err error={error} />}</div>;
  if (!data) return <div className="mt-6 text-dim">Loading…</div>;
  if (data.public) return <PublicInventory inv={data} now={now} bind={bind} tip={tip} signedIn={!!session.user} />;
  return <Inventory inv={data} now={now} bind={bind} tip={tip} />;
}

function Inventory({ inv, now, bind, tip }) {
  const running = inv.instances.filter((i) => i.state === 'running');
  const vcpus = running.reduce((a, i) => a + (i.vcpus || 0), 0);
  const ebsGiB = inv.volumes.reduce((a, v) => a + (v.sizeGiB || 0), 0);
  const unattached = inv.volumes.filter((v) => !v.attachedTo && v.state === 'available');
  const idleIps = inv.addresses.filter((a) => !a.associated);
  const stopped = inv.instances.filter((i) => i.state === 'stopped');
  const volById = Object.fromEntries(inv.volumes.map((v) => [v.id, v]));
  const snapGiB = inv.snapshots.reduce((a, s) => a + s.sizeGiB, 0);
  const ecrBytes = inv.ecr.reduce((a, r) => a + r.bytes, 0);
  const c = inv.costs;
  const regionsInUse = [...new Set([...inv.instances, ...inv.volumes, ...inv.addresses, ...inv.loadBalancers, ...inv.natGateways].map((x) => x.region))].sort();
  const waste = [
    ...unattached.map((v) => ({ kind: 'Unattached volume', what: `${v.id}${v.name ? ` (${v.name})` : ''}`, region: v.region, detail: `${v.sizeGiB} GiB ${v.type}, since ${v.createTime?.slice(0, 10)}`, month: v.sizeGiB * GP_GIB_MONTH })),
    ...idleIps.map((a) => ({ kind: 'Unassociated Elastic IP', what: `${a.publicIp}${a.name ? ` (${a.name})` : ''}`, region: a.region, detail: a.allocationId, month: EIP_MONTH })),
    ...stopped.map((i) => { const gib = i.volumes.reduce((s, v) => s + (volById[v]?.sizeGiB || 0), 0); return { kind: 'Stopped instance', what: `${i.tags.Name || i.id}`, region: i.region, detail: `${i.type}, ${gib} GiB EBS still billed, launched ${i.launchTime?.slice(0, 10)}`, month: gib * GP_GIB_MONTH }; }),
    ...inv.ecr.filter((r) => r.untagged > 50 || r.bytes > 50e9).map((r) => ({ kind: 'Container images', what: r.name, region: r.region, detail: `${r.images.toLocaleString('en-US')} images, ${r.untagged.toLocaleString('en-US')} untagged, ${bytes(r.bytes)}: no lifecycle policy trimming it?`, month: (r.bytes / 1e9) * ECR_GB_MONTH })),
    ...inv.snapshots.filter((s) => s.sizeGiB > 500).map((s) => ({ kind: 'EBS snapshots', what: `${s.count} snapshots`, region: s.region, detail: `${s.sizeGiB.toLocaleString('en-US')} GiB provisioned, oldest ${s.oldest?.slice(0, 10)} (billed on changed blocks)`, month: null })),
    ...inv.loadBalancers.filter((l) => l.type === 'classic' && l.instances === 0).map((l) => ({ kind: 'Classic load balancer without instances', what: l.name, region: l.region, detail: l.dns, month: 18 })),
  ].sort((a, b) => (b.month || 0) - (a.month || 0));
  return (
    <div>
      <TipLayer tip={tip} />
      <div className="mt-5 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-[16px] font-semibold">AWS</h1>
        <span className="text-dim text-[12px]">account inventory across {inv.regions.length} enabled regions ({regionsInUse.length} in use) · collected <span title={clock(inv.at)}>{ago(inv.at, now)} ago</span> in {Math.round(inv.tookMs / 1000)}s</span>
      </div>
      <div className="mt-3 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Instances running" value={running.length} sub={`${vcpus.toLocaleString('en-US')} vCPU · ${stopped.length} stopped`} />
        <Stat label="Cost · month to date" value={usd(c?.monthToDate)} sub={c ? `last month ${usd(c.lastMonth)}` : 'Cost Explorer not read yet'} />
        <Stat label="Month-end estimate" value={usd(c?.monthEndEstimate)} sub={c ? `Cost Explorer forecast · ${ago(c.at, now)} ago` : ''} level={c?.monthEndEstimate && c.lastMonth && c.monthEndEstimate > c.lastMonth * 1.15 ? 'warn' : undefined} />
        <Stat label="EBS volumes" value={`${(ebsGiB / 1024).toFixed(1)} TiB`} sub={`${inv.volumes.length} volumes · ${unattached.length} unattached`} level={unattached.length ? 'warn' : undefined} />
        <Stat label="Elastic IPs" value={inv.addresses.length} sub={`${idleIps.length} not associated`} level={idleIps.length ? 'warn' : undefined} />
        <Stat label="Load balancers · NAT" value={`${inv.loadBalancers.length} · ${inv.natGateways.length}`} sub={`${inv.cloudfront.length} CloudFront · ${inv.lambda.length} Lambda`} />
      </div>
      {inv.errors.length > 0 && (
        <div className="mt-3 panel px-3 py-2 text-[12px]">
          <div className="lv-warn mb-1">{inv.errors.length} part(s) of the inventory could not be read</div>
          {inv.errors.slice(0, 8).map((e, i) => <div key={i} className="mono text-dim truncate">{e.region} · {e.scope}: {e.error}</div>)}
        </div>
      )}

      {c && (
        <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
          <CostByService c={c} bind={bind} />
          <DailyCost c={c} bind={bind} />
        </div>
      )}

      {waste.length > 0 && (
        <Section title={`Worth a look (${waste.length})`} right={<span className="text-dim text-[11px]">idle resources that still bill; monthly figures are list-price estimates</span>}>
          <div className="panel overflow-x-auto max-h-[360px]">
            <table className="grid w-full text-[12px]">
              <thead><tr><th>What</th><th>Resource</th><th>Region</th><th>Detail</th><th className="text-right">≈ per month</th></tr></thead>
              <tbody>{waste.map((w, i) => <tr key={i}><td>{w.kind}</td><td className="mono">{w.what}</td><td className="mono text-dim">{w.region}</td><td className="text-dim max-w-[520px] truncate" title={w.detail}>{w.detail}</td><td className="mono text-right">{w.month != null ? usd(w.month) : '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </Section>
      )}

      <Instances inv={inv} now={now} />

      <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
        <Section title={`Load balancers (${inv.loadBalancers.length})`}>
          <Table rows={inv.loadBalancers} empty="No load balancers." cols={[['Name', (l) => <span className="mono">{l.name}</span>], ['Type', (l) => l.type], ['Region', (l) => <span className="mono text-dim">{l.region}</span>], ['DNS', (l) => <span className="mono text-dim truncate block max-w-[300px]" title={l.dns}>{l.dns}</span>], ['State', (l) => l.state || (l.instances != null ? `${l.instances} instances` : '—')]]} />
        </Section>
        <Section title={`CloudFront (${inv.cloudfront.length}) · NAT gateways (${inv.natGateways.length})`}>
          <Table rows={inv.cloudfront} empty="No distributions." cols={[['Distribution', (d) => <span className="mono">{d.id}</span>], ['Aliases', (d) => <span className="mono">{d.aliases.join(', ') || d.domain}</span>], ['Status', (d) => (d.enabled ? d.status : 'disabled')]]} />
          <div className="mt-2"><Table rows={inv.natGateways} empty="No NAT gateways." cols={[['NAT gateway', (n) => <span className="mono">{n.name || n.id}</span>], ['Region', (n) => <span className="mono text-dim">{n.region}</span>], ['Public IP', (n) => <span className="mono">{n.publicIp || '—'}</span>], ['State', (n) => n.state]]} /></div>
        </Section>
        <Section title={`Container registries (${inv.ecr.length})`} right={<span className="text-dim text-[11px]">{bytes(ecrBytes)} stored</span>}>
          <Table rows={[...inv.ecr].sort((a, b) => b.bytes - a.bytes)} empty="No ECR repositories." cols={[['Repository', (r) => <span className="mono">{r.name}</span>], ['Region', (r) => <span className="mono text-dim">{r.region}</span>], ['Images', (r) => <span className="mono">{r.images.toLocaleString('en-US')}</span>, 'right'], ['Untagged', (r) => <span className="mono">{r.untagged.toLocaleString('en-US')}</span>, 'right'], ['Size', (r) => <span className="mono">{bytes(r.bytes)}</span>, 'right'], ['Last push', (r) => <span className="mono text-dim">{r.lastPush ? `${ago(r.lastPush, now)} ago` : '—'}</span>]]} />
        </Section>
        <Section title={`Snapshots · Lambda · DynamoDB · S3`}>
          <div className="panel p-3 text-[12px] space-y-2">
            <div><span className="text-dim">EBS snapshots:</span> {inv.snapshots.length ? inv.snapshots.map((s) => <span key={s.region} className="mono mr-3">{s.region} {s.count} ({s.sizeGiB.toLocaleString('en-US')} GiB)</span>) : '—'}<span className="text-faint"> · {snapGiB.toLocaleString('en-US')} GiB provisioned in all</span></div>
            <div><span className="text-dim">Lambda ({inv.lambda.length}):</span> <span className="mono">{inv.lambda.map((f) => `${f.name} (${f.region})`).join(', ') || '—'}</span></div>
            <div><span className="text-dim">DynamoDB ({inv.dynamodb.length}):</span> <span className="mono">{inv.dynamodb.map((t) => `${t.name} (${t.region})`).join(', ') || '—'}</span></div>
            <div><span className="text-dim">S3 buckets ({inv.s3.length}):</span> <span className="mono">{inv.s3.map((b) => b.name).join(', ') || '—'}</span></div>
          </div>
        </Section>
      </div>
    </div>
  );
}

// Before sign-in: what runs and what it costs, as totals and breakdowns.
function PublicInventory({ inv, now, bind, tip, signedIn }) {
  const c = inv.costs;
  const s = inv.storage;
  const breakdown = (title, rows) => (
    <Section title={title}>
      <div className="panel p-3">
        <HBars rows={rows.slice(0, 10).map((r) => ({ label: r.label, value: r.count, vcpus: r.vcpus, memoryGiB: r.memoryGiB }))} bind={bind} format={(v) => v.toLocaleString('en-US')} color={SERIES[0]}
          tip={(r) => (<><div className="text-dim mb-0.5">{r.label}</div><TipRow value={r.value} label="running instances" /><TipRow value={r.vcpus} label="vCPU" /><TipRow value={`${r.memoryGiB} GiB`} label="memory" /></>)} />
      </div>
    </Section>
  );
  return (
    <div>
      <TipLayer tip={tip} />
      <div className="mt-5 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-[16px] font-semibold">AWS</h1>
        <span className="text-dim text-[12px]">what DCG runs for Dash networks, across {inv.regionsInUse} regions · updated <span title={clock(inv.at)}>{ago(inv.at, now)} ago</span></span>
      </div>
      <div className="mt-2 text-[12px] text-dim">Public view: totals and breakdowns only. {signedIn ? 'Your account has no access to more.' : 'Sign in for the full inventory.'}</div>
      <div className="mt-3 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Instances running" value={inv.instances.running} sub={`${inv.instances.vcpus.toLocaleString('en-US')} vCPU · ${inv.instances.memoryGiB.toLocaleString('en-US')} GiB`} />
        <Stat label="Cost · month to date" value={usd(c?.monthToDate)} sub={c ? `last month ${usd(c.lastMonth)}` : '—'} />
        <Stat label="Month-end estimate" value={usd(c?.monthEndEstimate)} sub={c ? 'Cost Explorer forecast' : ''} />
        <Stat label="Block storage" value={`${(s.ebsGiB / 1024).toFixed(1)} TiB`} sub={`${s.volumes} EBS volumes`} />
        <Stat label="Container images" value={bytes(s.ecrBytes)} sub={`${s.ecrImages.toLocaleString('en-US')} images`} />
        <Stat label="Edge and network" value={`${inv.network.loadBalancers} LB · ${inv.network.cloudfront} CDN`} sub={`${inv.network.elasticIps} Elastic IPs · ${inv.network.natGateways} NAT`} />
      </div>
      {c && (
        <div className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
          <CostByService c={c} bind={bind} />
          <DailyCost c={c} bind={bind} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        {breakdown('Running instances by network', inv.byNetwork)}
        {breakdown('Running instances by region', inv.byRegion)}
        {breakdown('Running instances by family', inv.byFamily)}
        {breakdown('Running instances by architecture', inv.byArch)}
      </div>
      <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        <Section title="Block storage by volume type">
          <div className="panel p-3">
            <HBars rows={s.ebsByType.map((r) => ({ label: r.label, value: r.gib }))} bind={bind} format={(v) => `${v.toLocaleString('en-US')} GiB`} color={SERIES[0]}
              tip={(r) => (<><div className="text-dim mb-0.5">{r.label}</div><TipRow value={`${r.value.toLocaleString('en-US')} GiB`} label="provisioned" /></>)} />
          </div>
        </Section>
        <Section title="Everything else">
          <div className="panel p-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12px]">
            {[['EBS snapshots', `${s.snapshotsGiB.toLocaleString('en-US')} GiB`], ['S3 buckets', s.s3Buckets], ['Lambda functions', inv.serverless.lambda], ['DynamoDB tables', inv.serverless.dynamodb],
              ['Stopped instances', inv.instances.stopped], ['Regions enabled', inv.regions]].map(([k, v]) => (
              <div key={k}><div className="text-dim text-[11px]">{k}</div><div className="mono text-[15px]">{v}</div></div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function CostByService({ c, bind }) {
  const [table, setTable] = useState(false);
  const top = c.byService.slice(0, 9);
  const rest = c.byService.slice(9).reduce((a, s) => a + s.amount, 0);
  const rows = [...top.map((s) => ({ label: s.service, value: s.amount })), ...(rest > 0 ? [{ label: `Other (${c.byService.length - 9} services)`, value: rest }] : [])];
  return (
    <Section title={`Cost by service · ${c.month} to date`} right={<button className="text-dim hover:text-fg text-[11px]" onClick={() => setTable(!table)}>{table ? 'chart' : 'table'}</button>}>
      <div className="panel p-3">
        {table ? (
          <table className="grid w-full text-[12px]"><thead><tr><th>Service</th><th className="text-right">USD</th><th className="text-right">Share</th></tr></thead>
            <tbody>{c.byService.map((s) => <tr key={s.service}><td>{s.service}</td><td className="mono text-right">{usd(s.amount, 2)}</td><td className="mono text-right">{((s.amount / c.monthToDate) * 100).toFixed(1)}%</td></tr>)}</tbody></table>
        ) : (
          <HBars rows={rows} bind={bind} format={(v) => usd(v)} color={SERIES[0]}
            tip={(r) => (<><div className="text-dim mb-0.5">{r.label}</div><TipRow value={usd(r.value, 2)} label={`${((r.value / c.monthToDate) * 100).toFixed(1)}% of month to date`} /></>)} />
        )}
      </div>
    </Section>
  );
}

function DailyCost({ c, bind }) {
  const [table, setTable] = useState(false);
  const series = [{ key: 'amount', label: 'Daily cost', color: SERIES[0] }];
  return (
    <Section title="Daily cost · last 31 days" right={<button className="text-dim hover:text-fg text-[11px]" onClick={() => setTable(!table)}>{table ? 'chart' : 'table'}</button>}>
      <div className="panel p-3">
        {table ? (
          <div className="max-h-[260px] overflow-y-auto"><table className="grid w-full text-[12px]"><thead><tr><th>Day</th><th className="text-right">USD</th></tr></thead>
            <tbody>{[...c.daily].reverse().map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono text-right">{usd(d.amount, 2)}</td></tr>)}</tbody></table></div>
        ) : (
          <>
            <div className="text-dim text-[11px] mb-2">Unblended, all services. The first of each month carries monthly charges (tax, support, reserved fees).</div>
            <Columns rows={c.daily} series={series} bind={bind} height={180} xLabel={(d) => d.day.slice(5)} format={(v) => usd(v)}
              tip={(d) => (<><div className="text-dim mb-0.5">{d.day}</div><TipRow value={usd(d.amount, 2)} label="spent" /></>)} />
          </>
        )}
      </div>
    </Section>
  );
}

function Instances({ inv, now }) {
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('');
  const [state, setState] = useState('');
  const [network, setNetwork] = useState('');
  const net = (i) => i.tags.DashNetwork || i.tags['dashnet:network'] || '';
  const networks = useMemo(() => {
    const m = new Map();
    for (const i of inv.instances) { const n = net(i) || '(untagged)'; const e = m.get(n) || { n, count: 0, running: 0, vcpus: 0 }; e.count++; if (i.state === 'running') { e.running++; e.vcpus += i.vcpus || 0; } m.set(n, e); }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [inv]);
  const regions = [...new Set(inv.instances.map((i) => i.region))].sort();
  const rows = inv.instances.filter((i) => (!region || i.region === region) && (!state || i.state === state) && (!network || (net(i) || '(untagged)') === network)
    && (!q || [i.id, i.tags.Name, i.publicIp, i.privateIp, i.type, net(i)].some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()))))
    .sort((a, b) => (net(a) ? 0 : 1) - (net(b) ? 0 : 1) || net(a).localeCompare(net(b)) || String(a.tags.Name || a.id).localeCompare(String(b.tags.Name || b.id), 'en', { numeric: true }));
  return (
    <Section title={`Instances (${rows.length} of ${inv.instances.length})`}>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {networks.map((e) => (
          <button key={e.n} className={`tag !text-[11.5px] !px-2 !py-0.5 ${network === e.n ? '!border-accent !text-fg' : ''}`} onClick={() => setNetwork(network === e.n ? '' : e.n)}>
            {e.n} <span className="text-dim">{e.running}/{e.count} · {e.vcpus} vCPU</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mb-2 text-[12px]">
        <input className="input w-64" placeholder="search name, id, IP, type…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={region} onChange={(e) => setRegion(e.target.value)}><option value="">all regions</option>{regions.map((r) => <option key={r}>{r}</option>)}</select>
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}><option value="">any state</option>{['running', 'stopped', 'pending', 'stopping'].map((s) => <option key={s}>{s}</option>)}</select>
      </div>
      <div className="panel overflow-x-auto max-h-[560px]">
        <table className="grid w-full text-[12px]">
          <thead><tr><th>Name</th><th>Network</th><th>Region / AZ</th><th>Type</th><th className="text-right">vCPU</th><th className="text-right">Memory</th><th>State</th><th>Public IP</th><th>Launched</th><th>Instance</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td className="mono max-w-[260px] truncate" title={i.tags.Name}>{i.tags.Name || '—'}</td>
                <td className="mono text-dim">{net(i) || '—'}</td>
                <td className="mono text-dim">{i.az || i.region}</td>
                <td className="mono">{i.type}{i.lifecycle === 'spot' ? <span className="tag ml-1">spot</span> : null}</td>
                <td className="mono text-right">{i.vcpus ?? '—'}</td>
                <td className="mono text-right">{i.memoryMiB ? `${(i.memoryMiB / 1024).toFixed(i.memoryMiB < 4096 ? 1 : 0)} GiB` : '—'}</td>
                <td className={STATE[i.state] || ''}>{i.state}</td>
                <td className="mono">{i.publicIp || '—'}</td>
                <td className="mono text-dim" title={i.launchTime}>{i.launchTime ? `${ago(i.launchTime, now)} ago` : '—'}</td>
                <td className="mono text-faint">{i.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-4 text-dim text-center">No instances match.</div>}
      </div>
    </Section>
  );
}

function Table({ rows, cols, empty }) {
  if (!rows.length) return <div className="panel p-3 text-dim text-[12px]">{empty}</div>;
  return (
    <div className="panel overflow-x-auto max-h-[300px]">
      <table className="grid w-full text-[12px]">
        <thead><tr>{cols.map(([h, , align]) => <th key={h} className={align === 'right' ? 'text-right' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([h, f, align]) => <td key={h} className={align === 'right' ? 'text-right' : ''}>{f(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
