import { ago, num, useNow, ROLE_LABEL } from '../lib.js';
import { Bar, Dot, Empty, Err, Level, Link } from '../ui.jsx';

export default function Overview({ overview }) {
  const now = useNow(1000);
  const { data, error } = overview;
  if (error) return <div className="mt-6"><Err error={error} /></div>;
  if (!data) return <div className="mt-6 text-dim">Loading…</div>;
  if (!data.networks.length) return <div className="mt-6"><Empty>No networks configured.</Empty></div>;
  return (
    <div className="mt-5 grid gap-4 xl:grid-cols-3 lg:grid-cols-2">
      {data.networks.map((n) => <NetworkCard key={n.name} n={n} now={now} />)}
    </div>
  );
}

function NetworkCard({ n, now }) {
  const s = n.summary || {};
  const coreAge = s.core?.blockTime ? (now - s.core.blockTime) / 1000 : null;
  const platAge = s.platform?.blockTime ? (now - s.platform.blockTime) / 1000 : null;
  const versions = Object.entries(s.versions || {});
  return (
    <Link to={`/n/${n.name}`} className="panel block hover:border-line-2 transition-colors">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-line">
        <Dot level={n.level} />
        <span className="font-semibold text-[14px]">{n.displayName}</span>
        <span className="text-dim mono text-[11px]">{n.chainType} · {s.core?.chain || n.coreNetwork}{s.platform?.chainId ? ` · ${s.platform.chainId}` : ''}</span>
        <span className="ml-auto text-dim mono text-[11px]" title={n.generatedAt}>{ago(n.generatedAt, now)}</span>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">
        <Fact k="Core height" v={num(s.core?.height)} sub={coreAge != null ? `block ${ago(s.core.blockTime, now)} ago` : null} warn={coreAge > 1800} />
        <Fact k="ChainLock" v={num(s.core?.chainLock)} sub={s.core?.height && s.core?.chainLock ? `${s.core.height - s.core.chainLock} behind tip` : s.core ? 'no ChainLock yet' : null} warn={!!(s.core?.chainLock && s.core.height - s.core.chainLock > 2)} />
        <Fact k="Platform height" v={num(s.platform?.height)} sub={platAge != null ? `block ${ago(s.platform.blockTime, now)} ago` : 'no platform'} warn={platAge > 600} />
        <Fact k="Protocol" v={s.platform?.protocol != null ? `v${s.platform.protocol}` : '—'} sub={s.core?.protocol ? `core ${s.core.protocol}` : null} />
        <Fact k="Masternodes READY" v={s.masternodes?.total ? `${s.masternodes.ready}/${s.masternodes.total}` : '—'} sub={s.masternodes?.pose ? `${s.masternodes.pose} with PoSe` : null} warn={s.masternodes && s.masternodes.ready < s.masternodes.total} />
        <Fact k="DAPI getStatus" v={s.dapi?.total ? `${s.dapi.ok}/${s.dapi.total}` : '—'} sub={s.platform?.validatorSet ? `validator set ${s.platform.validatorSet}` : null} warn={s.dapi && s.dapi.ok < s.dapi.total} />
        {s.mainnet && <>
          <Fact k="Mainnet bans" v={s.mainnet.bigBans ?? '—'} sub={s.mainnet.quorumCount != null ? `${s.mainnet.quorumCount} quorums listed` : null} warn={(s.mainnet.bigBans || 0) > 0} />
          <Fact k="Mainnet stalls" v={s.mainnet.coreStall || s.mainnet.platformStall ? 'stalled' : 'clear'} sub={s.mainnet.platformHeight ? `Platform ${num(s.mainnet.platformHeight)}` : null} warn={s.mainnet.coreStall || s.mainnet.platformStall} />
        </>}
      </div>
      <div className="px-4 pb-3">
        <div className="flex items-center justify-between text-[11px] text-dim mb-1.5">
          <span>{n.hostCount} hosts</span>
          <span className="mono">{['ok', 'deploying', 'warn', 'down', 'unreachable', 'stopped'].filter((k) => s.counts?.[k]).map((k) => <span key={k} className={`ml-2 lv-${k}`}>{s.counts[k]} {k}</span>)}</span>
        </div>
        <Bar counts={s.counts || {}} />
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-dim">
          {Object.entries(n.roles || {}).map(([r, c]) => <span key={r}><span className="text-fg mono">{c}</span> {ROLE_LABEL[r]?.toLowerCase() || r}</span>)}
        </div>
      </div>
      {versions.length > 0 && (
        <div className="px-4 py-2 border-t border-line text-[11px] grid grid-cols-[70px_1fr] gap-y-0.5">
          {versions.map(([c, vs]) => (
            <div key={c} className="contents">
              <span className="text-dim">{c}</span>
              <span className="mono truncate">{Object.entries(vs).sort((a, b) => b[1] - a[1]).map(([v, k]) => `${v}×${k}`).join('  ')}</span>
            </div>
          ))}
        </div>
      )}
      {n.endpoints?.length > 0 && (
        <div className="px-4 py-2 border-t border-line flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {n.endpoints.map((e) => (
            <span key={e.label} className="flex items-center gap-1.5" title={e.url}><Dot level={e.ok ? 'ok' : 'down'} /><span className="text-dim">{e.label}</span><span className="mono">{e.status ?? e.error}{e.ms != null ? ` ${e.ms}ms` : ''}</span></span>
          ))}
        </div>
      )}
      {n.problems?.length > 0 && (
        <div className="px-4 py-2 border-t border-line text-[11.5px] space-y-0.5">
          {n.problems.slice(0, 6).map((p) => (
            <div key={p.name} className="flex gap-2 min-w-0"><Level level={p.level} /><span className="mono shrink-0">{p.name}</span><span className="text-dim truncate">{p.reason}</span></div>
          ))}
          {n.problems.length > 6 && <div className="text-dim">+{n.problems.length - 6} more</div>}
        </div>
      )}
    </Link>
  );
}

function Fact({ k, v, sub, warn }) {
  return (
    <div className="min-w-0">
      <div className="text-dim text-[11px]">{k}</div>
      <div className={`mono text-[15px] ${warn ? 'lv-warn' : ''}`}>{v}</div>
      {sub && <div className="text-faint text-[11px] mono truncate">{sub}</div>}
    </div>
  );
}
