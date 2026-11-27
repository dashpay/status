import { useEffect, useState } from 'react';
import { ago, useNow, useResource } from '../lib.js';
import { Empty, Err, Section, Stat } from '../ui.jsx';
import { METRICS, recommendations, segments, valueOf } from '../website-metrics.js';

const COLORS = ['#59b5ff', '#f5bc62'];
const color = (i) => COLORS[i] ?? `hsl(${(i * 137) % 360}, 60%, 65%)`;
const kib = (n) => Number.isFinite(n) ? `${(n / 1024).toFixed(1)} KiB` : '—';
const names = (sites) => new Intl.ListFormat('en', { type: 'conjunction' }).format(sites.map((s) => s.site));
const ms = (n) => n == null ? '—' : `${Math.round(n).toLocaleString()} ms`;
const utc = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function History({ sites, now }) {
  const [metric, setMetric] = useState('ttfbMs');
  const [hours, setHours] = useState(24);
  const [selected, setSelected] = useState(null); // inspected time in ms, so it stays put as the window advances
  const end = now, start = end - hours * 3600_000;
  const groups = sites.map((s) => segments(s.history, metric, start, end));
  const max = Math.max(100, ...groups.flat(2).map((s) => s.value)) * 1.1;
  const x = (t) => 65 + (t - start) / (end - start) * 895;
  const y = (v) => 240 - v / max * 210;
  const inspected = selected != null && selected >= start && selected <= end ? selected : null;
  const select = (position) => setSelected(start + Math.max(0, Math.min(1, position)) * (end - start));
  const nearest = (site) => {
    const candidates = (site.history || []).filter((s) => Date.parse(s.at) >= start && Date.parse(s.at) <= end);
    return candidates.reduce((a, b) => !a || Math.abs(Date.parse(b.at) - inspected) < Math.abs(Date.parse(a.at) - inspected) ? b : a, null);
  };
  const changeHours = (n) => { setHours(n); setSelected(null); };
  return <Section title="Response time over time">
    <div className="panel p-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <label className="text-dim">Metric <select aria-label="Timing metric" className="bg-panel-2 border border-line rounded px-2 py-1 text-fg ml-2 max-w-full" value={metric} onChange={(e) => setMetric(e.target.value)}>{Object.entries(METRICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="flex gap-1" aria-label="History window">{[1, 24, 168].map((h) => <button key={h} aria-pressed={hours === h} className={`btn ${hours === h ? '!bg-panel-2 !text-fg' : ''}`} onClick={() => changeHours(h)}>{h === 168 ? '7 days' : `${h} hour${h === 1 ? '' : 's'}`}</button>)}</div>
      </div>
      <div className="flex flex-wrap gap-4 text-[12px]">{sites.map((s, i) => <span key={s.site} style={{ color: color(i) }}>● {s.site}</span>)}<span className="text-dim">Lower is faster · milliseconds · UTC</span></div>
      <svg viewBox="0 0 990 285" className="w-full min-h-[160px]" role="img" aria-label={`${METRICS[metric]} history for ${names(sites)}; gaps indicate missing or failed checks`}
        onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); select(((e.clientX - r.left) / r.width * 990 - 65) / 895); }} onPointerLeave={() => setSelected(null)}>
        {[0, .5, 1].map((v) => <g key={v}><line x1="65" x2="960" y1={y(v * max)} y2={y(v * max)} stroke="#273342" /><text x="55" y={y(v * max) + 4} textAnchor="end" fill="#94a3b8" fontSize="12">{Math.round(v * max)}</text></g>)}
        {[0, .25, .5, .75, 1].map((v) => <text key={v} x={x(start + (end - start) * v)} y="266" textAnchor={v === 0 ? 'start' : v === 1 ? 'end' : 'middle'} fill="#94a3b8" fontSize="12">{new Date(start + (end - start) * v).toISOString().slice(hours > 24 ? 5 : 11, hours > 24 ? 10 : 16)}</text>)}
        {groups.map((g, i) => <g key={sites[i].site}>{g.map((points, j) => <g key={j}><polyline points={points.map((p) => `${x(p.t)},${y(p.value)}`).join(' ')} fill="none" stroke={color(i)} strokeWidth="2" />{points.map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p.value)} r={points.length === 1 ? 4 : 2} fill={color(i)}><title>{sites[i].site}: {ms(p.value)} · {utc(p.t)}</title></circle>)}</g>)}</g>)}
        {inspected != null && <line x1={x(inspected)} x2={x(inspected)} y1="20" y2="240" stroke="#cbd5e1" strokeDasharray="4 4" />}
      </svg>
      <label className="text-[11px] text-dim block">Inspect time (drag, hover graph, or use arrow keys)
        <input className="w-full block mt-1" type="range" aria-label="Inspect history time" min="0" max="1000" value={Math.round(((inspected ?? end) - start) / (end - start) * 1000)} onChange={(e) => select(Number(e.target.value) / 1000)} />
      </label>
      <div className="text-[12px] mt-2 min-h-[3rem]" aria-live="polite">{inspected == null ? <span className="text-dim">Real five-minute samples. Blank areas mean no data; lines break across failed checks or gaps longer than ten minutes. History starts when monitoring is enabled.</span> : <><div className="text-dim">{utc(inspected)}</div>{sites.map((s, i) => { const sample = nearest(s); const close = sample && Math.abs(Date.parse(sample.at) - inspected) <= 300_000; return <div key={s.site} style={{ color: color(i) }}>{s.site}: {close ? `${sample.ok ? ms(valueOf(sample, metric)) : sample.error || 'Check failed'} · ${utc(sample.at)}` : 'No sample near this time'}</div>; })}</>}</div>
    </div>
  </Section>;
}

function Site({ site, stale, now }) {
  const s = site.latest || {}, summary = site.summary24h || {};
  return <section className="panel p-4 min-w-0">
    <div className="flex flex-wrap justify-between gap-2 mb-3"><h2 className="font-semibold text-base"><a href={`https://${site.site}/`} target="_blank" rel="noreferrer" className="hover:underline">{site.site} ↗</a></h2><span className={stale ? 'lv-warn' : s.ok ? 'lv-ok' : 'lv-down'}>{stale ? 'Stale' : s.ok ? `HTTP ${s.status ?? '—'}` : 'Check failed'} · {ago(s.at, now)}</span></div>
    {!s.ok && <Err error={s.error} />}
    <div className="grid grid-cols-2 gap-2">
      <Stat label="First byte" value={ms(s.ok ? s.ttfbMs : null)} sub="Includes redirects" />
      <Stat label="HTML response" value={ms(s.ok ? s.totalMs : null)} sub="Not full page load" />
      <Stat label="24h median / p95 TTFB" value={`${ms(summary.ttfbP50Ms)} / ${ms(summary.ttfbP95Ms)}`} sub={`${summary.successes ?? '—'} successful samples`} />
      <Stat label="24h check success" value={summary.successPercent == null ? '—' : `${summary.successPercent}%`} sub={`${summary.successes ?? '—'}/${summary.samples ?? '—'} checks · not uptime`} />
    </div>
    <Section title="Latest timing breakdown"><dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">{Object.entries(METRICS).filter(([k]) => k.endsWith('Ms') && k !== 'ttfbMs' && k !== 'totalMs').map(([k, label]) => <div key={k} className="flex justify-between gap-2"><dt className="text-dim">{label}</dt><dd className="mono">{ms(s.ok ? s.phases?.[k] : null)}</dd></div>)}<div className="flex justify-between gap-2"><dt className="text-dim">HTML download</dt><dd className="mono">{ms(s.ok ? s.phases?.downloadMs : null)}</dd></div></dl></Section>
    {s.ok && <div className="mt-3 text-[12px] text-dim space-y-1 break-words">
      <p>Final URL: {s.finalUrl ?? '—'} · {s.redirects ?? '—'} redirect(s) · HTTP/{s.httpVersion ?? '—'}</p>
      <p>HTML: {kib(s.htmlBytes)} decoded / {kib(s.transferBytes)} transferred · {s.encoding ?? '—'}</p>
      <p>Cache: {s.cacheStatus ?? '—'}{s.age != null ? ` · age ${s.age}s` : ''} · {s.cacheControl ?? '—'}</p>
    </div>}
    <Section title={stale ? 'Recommendations from last recorded response' : 'What could be improved'}><ul className="list-disc pl-4 space-y-2 text-[12px] text-dim">{recommendations(s).map((text) => <li key={text}>{text}</li>)}</ul></Section>
  </section>;
}

const PROBLEM = { unreachable: 'no answer', status: 'error answer', not_html: 'not a page', moved: 'leads elsewhere', short: 'almost no text', title: 'other title',
  phrase: 'expected text missing', defaced: 'defacement marker', download_link: 'download link elsewhere', no_downloads: 'no download links', changed: 'text changed at once' };

// Whether each page still is the page it should be. One failed reading is shown as it is and is not a fault yet.
function Pages({ pages, now }) {
  const list = Array.isArray(pages?.list) ? pages.list : [];
  if (!list.length) return null;
  const stale = !pages.at || now - Date.parse(pages.at) > 12 * 60_000, wrong = list.filter((p) => !p.ok);
  return <Section title="Page checks" right={<span className={`text-[12px] ${stale ? 'lv-warn' : wrong.length ? 'lv-down' : 'lv-ok'}`}>{stale ? 'Stale' : wrong.length ? `${wrong.length} of ${list.length} not in order` : `${list.length} pages in order`} · {ago(pages.at, now)}</span>}>
    <div className="panel p-4 min-w-0" data-page-checks>
      <p className="text-[12px] text-dim mb-3">Each page is read every five minutes and must be the page it should be: its own address, title and text, no defacement marker, download links that point where they should, and no sudden change of most of its text. A page that fails twice in a row is filed as a fault.</p>
      <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-1 text-[12px]">{list.map((p) => <li key={p.site + p.path} className="flex justify-between gap-3 min-w-0">
        <a href={`https://www.${p.site}${p.path}`} target="_blank" rel="noreferrer" className="mono truncate hover:underline">{p.site}{p.path}</a>
        <span className={`text-right ${p.ok ? 'lv-ok' : p.failures > 1 ? 'lv-down' : 'lv-warn'}`}>{p.ok ? 'OK' : `${p.problems.map((c) => PROBLEM[c] || c).join(', ') || 'not in order'}${p.failures > 1 ? '' : ' · first reading'}`}</span>
      </li>)}</ul>
    </div>
  </Section>;
}

export default function Websites() {
  const { data, error, reload } = useResource('/api/websites');
  const now = useNow(30_000);
  useEffect(() => { const t = setInterval(reload, 60_000); return () => clearInterval(t); }, [reload]);
  const stale = data?.stale || !data?.generatedAt || now - Date.parse(data.generatedAt) > 12 * 60_000;
  const sites = (Array.isArray(data?.sites) ? data.sites : []).filter((s) => s?.site);
  return <>
    <div className="mt-5 flex flex-wrap justify-between items-start gap-3"><div><h1 className="text-lg font-semibold">Website performance</h1><p className="text-dim mt-1">dash.dev &amp; dash.org · {data?.location || 'AWS status host'} · every 5 minutes</p></div><button className="btn" onClick={reload}>Refresh data</button></div>
    <p className="text-[12px] text-dim mt-3">HTTPS homepage checks from one AWS location, using fresh IPv4 connections and compression. TTFB is time to first byte of the final response, including redirects. Server wait includes network round-trip time. These are synthetic HTML checks, not global visitor latency, full-page load times or Core Web Vitals.</p>
    <div className="mt-3"><Err error={error} />{data && stale && <Err error={data.error || 'Collector data is stale. Last results are retained, not current health.'} />}</div>
    {!data ? <Empty>{error ? 'Website measurements are unavailable. Use Refresh data to try again.' : 'Loading website measurements…'}</Empty> : !sites.length ? <Empty>Waiting for the first status-host checks. No history has been fabricated.</Empty> : <><History sites={sites} now={now} /><div className="grid lg:grid-cols-2 gap-4 mt-5">{sites.map((s) => <Site key={s.site} site={s} stale={stale} now={now} />)}</div><Pages pages={data.pages} now={now} /><p className="text-dim text-[11px] mt-3">Last collection: {data.generatedAt ? utc(data.generatedAt) : '—'} · Seven days retained. Percentiles use successful checks only; small samples are not representative. Recommendations are HTML/header heuristics, not a browser audit.</p></>}
  </>;
}
