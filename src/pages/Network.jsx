import { Fragment, useEffect, useMemo, useState } from 'react';
import { ago, api, bytes, canOperate, canSee, clock, dash, duration, navigate, num, short, span, useNow, useResource, useSession, ROLE_LABEL } from '../lib.js';
import { Delta, Dot, Empty, Err, Level, Link, Meter, Section, Stat } from '../ui.jsx';
import Operations from './Operations.jsx';
import { COMPONENTS, OPERABLE, REPOS, cmp, newestRelease, reported } from '../releases.js';

const ROLE_ORDER = ['validator', 'masternode', 'seed', 'fullnode', 'web', 'wallet', 'miner', 'mixer', 'quorums', 'metrics', 'logs', 'vpn', 'other'];

export default function Network({ name, tab }) {
  const now = useNow(1000);
  const session = useSession();
  const { data: n, error } = useResource(`/api/networks/${name}`, (t, d) => (t === 'network' && (d.name === name || d.name === '*')) || t === 'settings');
  const member = canSee(session, name);
  const operator = canOperate(session, name);
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!n) return <div className="mt-6 text-dim">Loading…</div>;
  const s = n.summary;
  const coreAge = s.core?.blockTime ? (now - s.core.blockTime) / 1000 : null;
  const platAge = s.platform?.blockTime ? (now - s.platform.blockTime) / 1000 : null;
  return (
    <div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[18px] font-semibold flex items-center gap-2"><Dot level={n.level} />{n.displayName}</h1>
        <span className="text-dim mono text-[12px]">{n.name} · {n.chainType} · core chain {s.core?.chain || n.coreNetwork}{s.platform?.chainId ? ` · ${s.platform.chainId}` : ''}</span>
        <span className="text-dim mono text-[12px]" title={n.generatedAt}>state {ago(n.generatedAt, now)} old · every {n.pollSeconds || '—'}s · discovery {ago(n.discovery?.at, now)} ago{n.discovery?.error ? ` (${n.discovery.error})` : ''}</span>
        {member && (
          <div className="ml-auto flex gap-1">
            <Link to={`/n/${name}`} className={`btn ${tab === 'hosts' ? '!border-accent' : ''}`}>Hosts</Link>
            <Link to={`/n/${name}/ops`} className={`btn ${tab === 'ops' ? '!border-accent' : ''}`}>Operations</Link>
            {session.admin && n.chainType === 'devnet' && n.kind !== 'dashnet' && <Link to={`/n/${name}/reset`} className="btn btn-danger">Platform reset…</Link>}
            {operator && n.deployable && <Link to={`/n/${name}/deploy`} className="btn btn-primary">Deploy…</Link>}
          </div>
        )}
      </div>
      {n.description && <p className="text-dim mt-1 text-[12px]">{n.description}</p>}
      {n.lifecycle && <Lifecycle n={n} member={member} admin={session.admin} />}
      {operator && n.deployable && !['starting', 'stopped'].includes(n.lifecycle?.platform) && <Updates n={n} />}

      {tab === 'ops' && member ? <Operations network={n} operator={operator} /> : (
        <>
          <div className="mt-3 grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
            <Stat label="Core height" value={num(s.core?.height)} sub={coreAge != null ? `last block ${ago(s.core.blockTime, now)}` : '—'} level={coreAge > 1800 ? 'warn' : undefined} />
            <Stat label="ChainLock" value={num(s.core?.chainLock)} sub={s.core?.chainLock ? `tip − ${s.core.height - s.core.chainLock}` : 'no ChainLock yet'} />
            <Stat label="Platform height" value={num(s.platform?.height)} sub={platAge != null ? `last block ${ago(s.platform.blockTime, now)}` : 'no platform'} level={platAge > 600 ? 'warn' : undefined} />
            <Stat label="Protocol" value={s.platform?.protocol != null ? `v${s.platform.protocol}` : '—'} sub={`core p2p ${s.core?.protocol ?? '—'}`} />
            <Stat label="Validator set" value={s.platform?.validatorSet ?? '—'} sub="tenderdash /validators" />
            <Stat label="MN READY" value={s.masternodes.total ? `${s.masternodes.ready}/${s.masternodes.total}` : '—'} sub={`${s.masternodes.pose} with PoSe`} level={s.masternodes.ready < s.masternodes.total ? 'warn' : undefined} />
            <Stat label="DAPI getStatus" value={s.dapi.total ? `${s.dapi.ok}/${s.dapi.total}` : '—'} sub="local gRPC per evo node" level={s.dapi.ok < s.dapi.total ? 'down' : undefined} />
            <Stat label="Difficulty" value={s.core?.difficulty != null ? dash(s.core.difficulty) : '—'} sub={`${n.hosts.length} hosts`} />
          </div>

          {(n.endpoints.length > 0 || Object.keys(s.versions).length > 0) && (
            <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="panel">
                <div className="px-3 py-2 border-b border-line label">Public endpoints</div>
                <table className="grid"><tbody className="[&_tr]:!cursor-default">
                  {n.endpoints.map((e) => (
                    <tr key={e.label}><td className="w-4"><Dot level={e.ok ? 'ok' : 'down'} /></td><td>{e.label}</td>
                      <td className="mono text-dim truncate max-w-[280px]"><a className="link" href={e.url} target="_blank" rel="noreferrer">{e.url.replace(/^https:\/\//, '')}</a></td>
                      <td className="num">{e.status ?? <span className="lv-down">{e.error}</span>}</td><td className="num text-dim">{e.ms != null ? `${e.ms} ms` : ''}</td></tr>
                  ))}
                  {!n.endpoints.length && <tr><td className="text-dim">none configured</td></tr>}
                </tbody></table>
              </div>
              <div className="panel">
                <div className="px-3 py-2 border-b border-line label">Running versions (container count)</div>
                <table className="grid"><tbody className="[&_tr]:!cursor-default">
                  {Object.entries(s.versions).map(([c, vs]) => (
                    <tr key={c}><td className="text-dim w-20">{c}</td><td className="!whitespace-normal">{Object.entries(vs).sort((a, b) => b[1] - a[1]).map(([v, k]) => <span key={v} className="tag mr-1.5 mb-0.5">{v} <span className="text-dim">×{k}</span></span>)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            </div>
          )}
          {member && n.journal && <Journal j={n.journal} now={now} />}
          <Hosts n={n} now={now} member={member} operator={operator} />
        </>
      )}
    </div>
  );
}

function Journal({ j, now }) {
  return (
    <div className="panel mt-3 px-3 py-2 text-[12px] flex flex-wrap gap-x-5 gap-y-1">
      <span className="label self-center">dashnet journal</span>
      {j.error ? <span className="lv-warn mono">{j.error}</span> : <>
        <span>phase <span className="mono">{j.phase}</span></span>
        <span>enrolled <span className="mono">{j.enrolled?.length ?? 0}/{j.targets?.length ?? 0}</span></span>
        {j.operationId && <span>last op <span className="mono">{short(j.operationId, 12)}</span></span>}
        {j.owner && <span className="lv-warn">runner claim <span className="mono">{j.owner}</span></span>}
        {j.current && <span className="lv-warn">in progress on <span className="mono">{j.current}</span></span>}
        {j.lastError && <span className="lv-down mono">{j.lastError}</span>}
        {j.excluded?.length > 0 && <span className="text-dim">not operable: {j.excluded.map((e) => `${e.name} (${e.reason})`).join(', ')}</span>}
      </>}
      <span className="text-faint ml-auto mono">{ago(j.at, now)} ago</span>
    </div>
  );
}

function Hosts({ n, now, member, operator }) {
  const [q, setQ] = useState('');
  const [levels, setLevels] = useState(new Set());
  const [open, setOpen] = useState(null);
  const tips = { core: n.summary.core?.height, platform: n.summary.platform?.height };
  const filtered = useMemo(() => n.hosts.filter((h) => {
    if (levels.size && !levels.has(h.level)) return false;
    if (!q) return true;
    const hay = [h.name, h.publicIp, h.role, h.level, h.masternode?.proTxHash, ...h.containers.map((c) => c.version), ...h.reasons.map((r) => r.text), h.instanceId].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  }), [n.hosts, q, levels]);
  const groups = ROLE_ORDER.map((r) => [r, filtered.filter((h) => h.role === r)]).filter(([, hs]) => hs.length);
  const counts = n.summary.counts;
  return (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input className="input w-72" placeholder="filter: name, IP, version, reason…" value={q} onChange={(e) => setQ(e.target.value)} />
        {['ok', 'deploying', 'warn', 'down', 'unreachable', 'stopped'].filter((l) => l !== 'deploying' || counts.deploying).map((l) => (
          <span key={l} className={`chip ${levels.has(l) ? 'on' : ''}`} onClick={() => setLevels((s) => { const x = new Set(s); x.has(l) ? x.delete(l) : x.add(l); return x; })}>
            <Dot level={l} />{l} <span className="mono">{counts[l] || 0}</span>
          </span>
        ))}
        <span className="text-dim ml-auto text-[11px]">{filtered.length}/{n.hosts.length} hosts · click a row for detail</span>
      </div>
      {!groups.length && <div className="mt-3"><Empty>No hosts match.</Empty></div>}
      {groups.map(([role, hosts]) => (
        <Section key={role} title={`${ROLE_LABEL[role] || role} · ${hosts.length}`}>
          <div className="panel scroll-x">
            <RoleTable role={role} hosts={hosts} tips={tips} now={now} open={open} setOpen={setOpen} member={member} operator={operator} network={n} />
          </div>
        </Section>
      ))}
    </>
  );
}

const ver = (h, c) => h.containers.find((k) => k.component === c && k.running)?.version || h.containers.find((k) => k.component === c)?.version;
const coreVer = (h) => h.core?.version?.replace(/^\/Dash Core:/, '').replace(/\/$/, '') || ver(h, 'core');
const disk = (h) => Math.max(...(h.system?.disks || []).map((d) => d.percent ?? 0), -1);

function columns(role, tips, now, hostsHaveServices) {
  const base = [
    { h: '', w: 18, c: (h) => <Dot level={h.level} /> },
    { h: 'host', c: (h) => <span className="mono">{h.name}</span> },
    { h: 'public IP', c: (h) => <span className="mono text-dim">{h.publicIp || '—'}</span> },
    { h: 'status', c: (h) => <span className="flex items-center gap-2 max-w-[340px]"><span className={`lv-${h.level} shrink-0`}>{h.level}</span><span className="text-dim truncate">{h.reasons.filter((r) => r.level !== 'info')[0]?.text || ''}</span></span> },
  ];
  const coreH = { h: 'core height', n: 1, c: (h) => h.core ? <>{num(h.core.height)}<Delta value={tips.core - h.core.height} /></> : '—' };
  const sys = [
    { h: 'load', n: 1, c: (h) => h.system ? `${h.system.load[0].toFixed(2)}/${h.system.cpus}` : '—' },
    { h: 'mem', n: 1, c: (h) => <Meter value={h.system?.memPercent} warn={92} /> },
    { h: 'disk', n: 1, c: (h) => <Meter value={disk(h) >= 0 ? disk(h) : null} /> },
    { h: 'uptime', n: 1, c: (h) => duration(h.system?.uptime) },
    { h: 'probe', n: 1, c: (h) => <span className="text-dim" title={h.probedAt}>{h.probedAt ? `${ago(h.probedAt, now)}` : '—'}</span> },
  ];
  if (role === 'validator') return [...base, coreH,
    { h: 'platform height', n: 1, c: (h) => h.platform?.height ? <>{num(h.platform.height)}<Delta value={tips.platform - h.platform.height} /></> : '—' },
    { h: 'MN', c: (h) => <MnState h={h} /> },
    { h: 'PoSe', n: 1, c: (h) => h.masternode ? <span className={h.masternode.pose > 0 ? 'lv-warn' : 'text-dim'}>{h.masternode.pose}</span> : '—' },
    { h: 'core', c: (h) => <span className="mono">{coreVer(h)}</span> },
    { h: 'drive', c: (h) => <span className="mono">{h.dapi?.driveVersion || ver(h, 'drive') || '—'}</span> },
    { h: 'tenderdash', c: (h) => <span className="mono">{(h.platform?.version || ver(h, 'tenderdash') || '—').replace(/^unreleased-/, '').slice(0, 22)}</span> },
    { h: 'DAPI', n: 1, c: (h) => h.dapi ? (h.dapi.ok ? <span>{h.dapi.latencyMs} ms</span> : <span className="lv-down">fail</span>) : '—' },
    { h: 'TD peers', n: 1, c: (h) => h.platform?.peers ?? '—' },
    { h: 'core peers', n: 1, c: (h) => h.core?.peers ?? '—' },
    ...sys];
  if (role === 'masternode') return [...base, coreH,
    { h: 'MN', c: (h) => <MnState h={h} /> },
    { h: 'PoSe', n: 1, c: (h) => h.masternode ? <span className={h.masternode.pose > 0 ? 'lv-warn' : 'text-dim'}>{h.masternode.pose}</span> : '—' },
    { h: 'last paid', n: 1, c: (h) => h.masternode?.lastPaid > 0 ? <>{num(h.masternode.lastPaid)}<span className="text-faint ml-1 text-[11px]">({num(tips.core - h.masternode.lastPaid)} ago)</span></> : '—' },
    { h: 'core', c: (h) => <span className="mono">{coreVer(h)}</span> },
    { h: 'peers in/out', n: 1, c: (h) => h.core ? `${h.core.peersIn ?? '—'}/${h.core.peersOut ?? h.core.peers - (h.core.peersIn || 0)}` : '—' },
    { h: 'P2P', n: 1, c: (h) => h.p2p ? <span className={h.p2p.ok ? '' : 'lv-warn'}>{h.p2p.ok ? `:${h.p2p.port} ${h.p2p.ms}ms` : `:${h.p2p.port} closed`}</span> : '—' },
    ...sys];
  if (role === 'seed') return [...base, coreH,
    { h: 'core', c: (h) => <span className="mono">{coreVer(h)}</span> },
    { h: 'core peers in/out', n: 1, c: (h) => h.core ? `${h.core.peersIn ?? '—'}/${(h.core.peers ?? 0) - (h.core.peersIn ?? 0)}` : '—' },
    { h: 'tenderdash', c: (h) => <span className="mono">{ver(h, 'tenderdash') || '—'}</span> },
    { h: 'TD P2P sessions', n: 1, c: (h) => h.platform?.peers ?? '—' },
    { h: 'TD chain', c: (h) => <span className="mono text-dim">{h.platform?.network || '—'}</span> },
    { h: 'P2P', n: 1, c: (h) => h.p2p ? <span className={h.p2p.ok ? '' : 'lv-warn'}>{h.p2p.ok ? `:${h.p2p.port} ${h.p2p.ms}ms` : `:${h.p2p.port} closed`}</span> : '—' },
    ...sys];
  if (role === 'web') return [...base, coreH,
    { h: 'core', c: (h) => <span className="mono">{coreVer(h)}</span> },
    { h: 'insight', c: (h) => h.insight ? <span className="mono">{h.containers.find((k) => /insight/.test(k.image))?.version} · {h.insight.syncStatus} {num(h.insight.blocks)}</span> : '—' },
    { h: 'faucet', c: (h) => h.faucet ? <span className={h.faucet.status >= 400 ? 'lv-down' : ''}>{h.containers.find((k) => /faucet/.test(k.image))?.version} · HTTP {h.faucet.status} · {h.faucet.latencyMs} ms</span> : '—' },
    { h: 'containers', n: 1, c: (h) => `${h.containers.filter((k) => k.running).length}/${h.containers.length}` },
    ...sys];
  if (role === 'wallet') return [...base, coreH,
    { h: 'core', c: (h) => <span className="mono">{coreVer(h)}</span> },
    ...(hostsHaveServices ? [{ h: 'services', c: (h) => <Services h={h} /> }] : []),
    { h: 'wallets', c: (h) => Array.isArray(h.wallets) ? <span className="mono text-[11.5px]">{h.wallets.map((w) => `${w.name.replace(/^dashd-wallet-\d+-/, '')} ${dash(w.trusted)}`).join(' · ')}</span> : h.wallets ? `${h.wallets.count} loaded` : '—' },
    { h: 'peers', n: 1, c: (h) => h.core?.peers ?? '—' },
    ...sys];
  return [...base,
    { h: 'core height', n: 1, c: (h) => h.core ? <>{num(h.core.height)}<Delta value={tips.core - h.core.height} /></> : '—' },
    { h: 'software', c: (h) => <span className="mono text-[11.5px]">{coreVer(h) ? `core ${coreVer(h)}` : ''}{h.containers.filter((k) => !k.component).slice(0, 3).map((k) => ` ${k.image.split('/').pop()}`).join('')}</span> },
    { h: 'containers', n: 1, c: (h) => h.containers.length ? `${h.containers.filter((k) => k.running).length}/${h.containers.length}` : '—' },
    { h: 'type', c: (h) => <span className="text-dim mono">{h.instanceType}</span> },
    ...sys];
}

function MnState({ h }) {
  const m = h.masternode;
  if (!m) return '—';
  return <span className={m.state === 'READY' ? '' : 'lv-down'}>{m.state}</span>;
}

function RoleTable({ role, hosts, tips, now, open, setOpen, member, operator, network }) {
  const cols = columns(role, tips, now, hosts.some((h) => h.quorumServer || h.explorer || h.faucet?.kind === 'dash-faucet'));
  return (
    <table className="grid">
      <thead><tr>{cols.map((c, i) => <th key={i} className={c.n ? 'num' : ''} style={c.w ? { width: c.w } : undefined}>{c.h}</th>)}</tr></thead>
      <tbody>
        {hosts.map((h) => (
          <Fragment key={h.name}>
            <tr className={`${open === h.name ? 'open' : ''} ${h.duplicate ? 'opacity-50' : ''}`} onClick={() => setOpen(open === h.name ? null : h.name)}>
              {cols.map((c, i) => <td key={i} className={c.n ? 'num' : ''}>{c.c(h)}</td>)}
            </tr>
            {open === h.name && <tr className="detail"><td colSpan={cols.length}><HostDetail h={h} now={now} member={member} operator={operator} network={network} /></td></tr>}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function KV({ rows }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-[12px]">
      {rows.filter(Boolean).map(([k, v]) => <Fragment key={k}><dt className="text-dim">{k}</dt><dd className="mono break-all">{v ?? '—'}</dd></Fragment>)}
    </dl>
  );
}

function HostDetail({ h, now, member, operator, network }) {
  return (
    <div className="py-2 grid gap-4 xl:grid-cols-3 lg:grid-cols-2">
      <div>
        <div className="label mb-1">Status</div>
        {h.reasons.length ? h.reasons.map((r, i) => <div key={i} className="flex gap-2 text-[12px]"><Level level={r.level} /><span className="mono break-all">{r.text}</span></div>) : <div className="lv-ok text-[12px]">all checks passed</div>}
        <div className="label mt-3 mb-1">Host</div>
        <KV rows={[
          ['instance', member ? `${h.instanceId} · ${h.instanceType} · ${h.arch} · ${h.az}` : `${h.instanceType} · ${h.arch} · ${h.az}`],
          ['addresses', member ? `${h.publicIp || '—'} / ${h.privateIp || '—'}` : h.publicIp],
          member && ['EC2 Name', h.nameTag],
          member && ['launched', clock(h.launchTime)],
          ['os', h.system ? `${h.system.os} · ${h.system.kernel}` : null],
          ['memory', h.system ? `${h.system.memPercent}% of ${bytes(h.system.memTotal)}${h.system.swapPercent != null ? ` · swap ${h.system.swapPercent}%` : ''}` : null],
          ['disks', h.system?.disks?.map((d) => `${d.mount} ${d.percent}% of ${bytes(d.size)} (${bytes(d.avail)} free)`).join(' · ')],
          ['probe', h.probedAt ? `${clock(h.probedAt)} · ${h.probeMs} ms` : null],
          member && h.probeError && ['probe error', h.probeError],
          member && h.probeErrors?.length > 0 && ['source errors', h.probeErrors.join(' | ')],
          member && h.lastGood && ['last good probe', `${ago(h.lastGood.at, now)} ago`],
        ]} />
      </div>
      <div>
        {h.core && <><div className="label mb-1">Core</div><KV rows={[
          ['version', `${h.core.version} · protocol ${h.core.protocol}`],
          ['height', `${num(h.core.height)} (headers ${num(h.core.headers)}) · chainlock ${num(h.core.chainLock)}`],
          ['best block', h.core.bestBlock],
          ['sync', `${h.core.ibd ? 'initial sync' : 'synced'} · mnsync ${h.core.synced ? 'done' : 'pending'}`],
          ['peers', `${h.core.peers} (${h.core.peersIn} in)`],
          ['size on disk', bytes(h.core.sizeOnDisk)],
          ['mempool', h.core.mempool],
        ]} /></>}
        {h.masternode && <><div className="label mt-3 mb-1">Masternode</div><KV rows={[
          ['state', `${h.masternode.state} · ${h.masternode.type}`], ['proTxHash', h.masternode.proTxHash], ['service', h.masternode.service],
          ['PoSe', h.masternode.pose], ['registered', num(h.masternode.registered)], ['last paid', num(h.masternode.lastPaid)],
        ]} /></>}
        {Array.isArray(h.wallets) && <><div className="label mt-3 mb-1">Wallets</div>
          <table className="text-[12px] mono"><tbody>{h.wallets.map((w) => <tr key={w.name}><td className="pr-4 text-dim">{w.name}</td><td className="text-right pr-3">{dash(w.trusted)}</td><td className="text-faint text-right pr-3">{w.pending ? `+${dash(w.pending)} pending` : ''}</td><td className="text-faint text-right">{w.immature ? `${dash(w.immature)} immature` : ''}</td></tr>)}</tbody></table></>}
        {h.insight && <><div className="label mt-3 mb-1">Insight</div><KV rows={[['sync', `${h.insight.syncStatus} ${h.insight.syncPercentage}%`], ['blocks', num(h.insight.blocks)], ['network', h.insight.network]]} /></>}
        {h.faucet && <><div className="label mt-3 mb-1">Faucet</div><KV rows={h.faucet.kind === 'dash-faucet' ? [['/api/status', `${h.faucet.status} · ${h.faucet.state} · ${h.faucet.latencyMs} ms`], ['balance', dash(h.faucet.balance)], ['spendable UTXOs', h.faucet.utxos]] : [['HTTP', `${h.faucet.status} · ${h.faucet.latencyMs} ms`], ['title', h.faucet.title]]} /></>}
        {h.quorumServer && <><div className="label mt-3 mb-1">Quorum list server</div><KV rows={[['/health', `${h.quorumServer.status} · ${h.quorumServer.latencyMs} ms`], ['platform quorums', h.quorumServer.quorums]]} /></>}
        {h.explorer && <><div className="label mt-3 mb-1">Platform Explorer</div><KV rows={[['API /status', `${h.explorer.status} · ${h.explorer.latencyMs} ms · API ${h.explorer.apiVersion ?? '—'}`], ['indexed / chain', `${num(h.explorer.indexedHeight)} / ${num(h.explorer.chainHeight)}`], ['identities / transactions', `${h.explorer.identities ?? '—'} / ${h.explorer.transactions ?? '—'}`]]} /></>}
      </div>
      <div>
        {h.platform && <><div className="label mb-1">Platform</div><KV rows={[
          ['height', `${num(h.platform.height)}${h.platform.blockTime ? ` · ${ago(h.platform.blockTime, now)} ago` : ''}`],
          ['chain', h.platform.network], ['protocol', h.platform.protocol], ['tenderdash', h.platform.version],
          ['peers', h.platform.peers], h.platform.votingPower != null && ['voting power', `${h.platform.votingPower}${h.platform.inValidatorSet != null ? ` · ${h.platform.inValidatorSet ? 'in' : 'not in'} current set` : ''}`],
          ['node id', h.platform.nodeId],
        ]} /></>}
        {h.dapi && <><div className="label mt-3 mb-1">DAPI (local getStatus)</div><KV rows={[
          ['result', h.dapi.ok ? `ok · ${h.dapi.latencyMs} ms · height ${num(h.dapi.height)}` : `failed${h.dapi.error ? `: ${h.dapi.error}` : ''}`],
          ['versions', h.dapi.ok ? `dapi ${h.dapi.dapiVersion} · drive ${h.dapi.driveVersion}` : null],
          h.dapi.tls && ['certificate', `${h.dapi.tls.trusted ? 'publicly trusted' : 'not publicly trusted'} · ${h.dapi.tls.issuer || 'unknown issuer'}${h.dapi.tls.expiresAt ? ` · expires in ${duration(Math.max(0, (Date.parse(h.dapi.tls.expiresAt) - now) / 1000))}` : ''}`],
          h.dapiPublic && ['from status host', h.dapiPublic.ok ? `reachable ${h.dapiPublic.ms} ms` : 'not reachable'],
        ]} /></>}
        <div className="label mt-3 mb-1">Containers</div>
        {h.containers.length ? (
          <table className="text-[11.5px] mono w-full"><tbody>
            {h.containers.map((k) => (
              <tr key={k.name} className={k.running ? '' : 'text-dim'}>
                <td className="pr-2"><Dot level={k.running ? (k.health === 'unhealthy' ? 'warn' : 'ok') : 'stopped'} /></td>
                <td className="pr-3 break-all">{k.name}</td>
                <td className="pr-3 break-all" title={k.digest || ''}>{k.image.replace(/@sha256:(.{12}).*/, '@$1…')}</td>
                <td className="pr-3 whitespace-nowrap">{k.running ? `up ${ago(k.startedAt, now)}` : k.state}</td>
                <td className="text-right whitespace-nowrap">{k.restarts ? <span className="lv-warn">{k.restarts} restarts</span> : ''}</td>
              </tr>
            ))}
          </tbody></table>
        ) : <div className="text-dim text-[12px]">none</div>}
        {operator && network.deployable && ['validator', 'masternode', 'seed'].includes(h.role) && (
          <div className="mt-3 flex gap-2">
            <Link className="btn" to={`/n/${network.name}/deploy?nodes=${h.name}`}>Deploy to {h.name}…</Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Services({ h }) {
  const parts = [];
  if (h.quorumServer) parts.push(<span key="q" className={h.quorumServer.status === 200 ? '' : 'lv-down'}>quorums {h.quorumServer.status === 200 ? h.quorumServer.quorums : `HTTP ${h.quorumServer.status}`}</span>);
  if (h.explorer) parts.push(<span key="e" className={h.explorer.status === 200 ? '' : 'lv-down'}>explorer {h.explorer.status === 200 ? `${num(h.explorer.indexedHeight)}/${num(h.explorer.chainHeight)}` : `HTTP ${h.explorer.status}`}</span>);
  if (h.faucet?.kind === 'dash-faucet') parts.push(<span key="f" className={h.faucet.state === 'ok' ? '' : 'lv-warn'}>faucet {dash(h.faucet.balance)}</span>);
  return <span className="mono text-[11.5px] flex gap-3">{parts.length ? parts : '—'}</span>;
}

function Lifecycle({ n, member, admin }) {
  const l = n.lifecycle;
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const level = { ready: 'ok', creating: 'info', services: 'info', deleting: 'warn', failed: 'down' }[l.status] || 'stopped';
  // Keyed by network: a slower response for a previous network is ignored.
  const [faucet, setFaucet] = useState({ network: null, codes: {} });
  useEffect(() => {
    if (!member) return undefined;
    let current = true;
    api(`/api/networks/${n.name}/faucet-codes`).then((r) => current && setFaucet({ network: n.name, codes: r.codes || {} }), () => current && setFaucet({ network: n.name, codes: {} }));
    return () => { current = false; };
  }, [member, n.name]);
  const codes = faucet.network === n.name ? faucet.codes : {};
  const remove = async () => {
    setError(null);
    try { const r = await api(`/api/networks/${n.name}/ops`, { method: 'POST', body: { action: 'delete-devnet', confirmName: confirm } }); navigate(`/n/${n.name}/ops/${r.id}`); }
    catch (e) { setError(e); }
  };
  return (
    <div className="panel mt-3 px-3 py-2 text-[12px] flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="label">console devnet</span>
      <span className={`lv-${level}`}>{l.status}</span>
      {l.status === 'ready' && l.platform === 'starting' && <span className="lv-info">Platform starts as soon as the quorums form</span>}
      {l.status === 'ready' && l.platform === 'stopped' && <span className="lv-down">Platform has not started: resume its operation</span>}
      <span className="text-dim">Core block every {l.blockTimeSeconds}s{l.platformEpochSeconds ? ` · Platform epoch ${span(l.platformEpochSeconds)}` : ''}</span>
      <span className="text-dim">created by {l.createdBy} {l.createdAt ? ago(l.createdAt) + ' ago' : ''}</span>
      {member && l.operation && <Link className="link" to={`/n/${n.name}/ops/${l.operation}`}>creation log</Link>}
      {l.dns && Object.entries(l.dns).map(([k, v]) => <a key={k} className="link mono" href={`https://${v.host}/`} target="_blank" rel="noreferrer">{k}</a>)}
      {admin && !open && ['ready', 'failed', 'services'].includes(l.status) && <button className="btn !py-0.5 ml-auto" onClick={async () => {
        setError(null);
        try { const r = await api(`/api/networks/${n.name}/ops`, { method: 'POST', body: { action: 'devnet-services' } }); navigate(`/n/${n.name}/ops/${r.id}`); } catch (e) { setError(e); }
      }}>Update services…</button>}
      {admin && !open && <button className={`btn btn-danger !py-0.5 ${['ready', 'failed', 'services'].includes(l.status) ? '' : 'ml-auto'}`} onClick={() => setOpen(true)}>Delete devnet…</button>}
      {admin && open && <span className="ml-auto flex items-center gap-2"><span className="text-dim">type <span className="mono">{n.name}</span></span>
        <input className="input mono w-56" value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} />
        <button className="btn btn-danger !py-0.5" disabled={confirm !== n.name} onClick={remove}>Prepare deletion</button>
        <button className="btn !py-0.5" onClick={() => setOpen(false)}>cancel</button></span>}
      {member && Object.keys(codes).length > 0 && <span className="w-full text-dim">faucet promo codes (members only; once per IP per hour): {Object.entries(codes).map(([c, a]) => <span key={c} className="mr-3"><span className="mono text-fg">{c}</span> {a} DASH</span>)}</span>}
      {error && <span className="lv-down w-full">{error.message}</span>}
    </div>
  );
}

// Newer releases in each component's running line, with a one-click rollout
// across every healthy node that runs them (planned, then run at once).
function Updates({ n }) {
  const [state, setState] = useState({ network: null, updates: [] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const native = n.kind === 'dashnet';
  const hosts = n.hosts.filter((h) => OPERABLE.includes(h.role) && !h.duplicate && h.state === 'running' && h.level !== 'unreachable');
  const key = hosts.map((h) => h.name + COMPONENTS.map((c) => reported(h, c)).join()).join('|');
  useEffect(() => {
    let current = true;
    const components = COMPONENTS.filter((c) => (!native || c !== 'core' || (n.upgradeScopes || []).includes('core')) && hosts.some((h) => h.containers.some((k) => k.component === c)));
    Promise.all(components.map(async (c) => {
      const running = [...new Set(hosts.filter((h) => h.containers.some((k) => k.component === c)).map((h) => reported(h, c)).filter(Boolean))].sort(cmp)[0];
      try { const next = newestRelease((await api(`/api/images/${c}/tags`)).tags, running); return next ? { c, from: running, to: next } : null; } catch { return null; }
    })).then((list) => current && setState({ network: n.name, updates: list.filter(Boolean) }));
    return () => { current = false; };
  }, [n.name, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const updates = state.network === n.name ? state.updates : [];
  if (!updates.length) return null;
  const nodes = native ? [] : hosts.filter((h) => updates.some((u) => h.containers.some((k) => k.component === u.c))).map((h) => h.name);
  const upgrade = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api(`/api/networks/${n.name}/ops`, { method: 'POST', body: { action: 'upgrade', nodes, components: updates.map((u) => u.c), images: Object.fromEntries(updates.map((u) => [u.c, `${REPOS[u.c]}:${u.to}`])), options: { autoRun: true } } });
      navigate(`/n/${n.name}/ops/${r.id}`);
    } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <div className="panel mt-3 px-3 py-2 text-[12px] flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="label">updates available</span>
      {updates.map((u) => <span key={u.c}><span className="font-medium">{u.c}</span> <span className="mono text-dim">{u.from}</span> → <span className="mono">{u.to}</span></span>)}
      <span className="text-dim">{native ? 'every node, Core first, then Platform' : `${nodes.length} healthy node(s), one at a time`}</span>
      <span className="ml-auto flex gap-2">
        <Link to={`/n/${n.name}/deploy`} className="btn !py-0.5">Review first…</Link>
        <button className="btn btn-primary !py-0.5" disabled={busy} onClick={upgrade}>{busy ? 'Starting…' : 'Upgrade now'}</button>
      </span>
      {error && <span className="lv-down w-full">{error.message}</span>}
    </div>
  );
}
