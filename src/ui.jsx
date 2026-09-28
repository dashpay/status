import { LEVEL_LABEL, linkProps } from './lib.js';

export function Dot({ level, className = '' }) {
  return <span className={`dot bg-lv-${level} ${className}`} title={LEVEL_LABEL[level]} />;
}

export function Level({ level }) {
  return <span className={`inline-flex items-center gap-1.5 lv-${level} font-medium`}><Dot level={level} />{LEVEL_LABEL[level]}</span>;
}

export function Link({ to, className = '', children, ...rest }) {
  return <a {...linkProps(to)} className={className} {...rest}>{children}</a>;
}

export function Stat({ label, value, sub, level, title }) {
  return (
    <div className="panel px-3 py-2 min-w-0" title={title}>
      <div className="label truncate">{label}</div>
      <div className={`mono text-[17px] leading-6 mt-0.5 truncate ${level ? `lv-${level}` : ''}`}>{value}</div>
      {sub != null && <div className="text-dim text-[11px] mono truncate">{sub}</div>}
    </div>
  );
}

export function Section({ title, right, children, className = '' }) {
  return (
    <section className={`mt-5 ${className}`}>
      <div className="flex items-end justify-between gap-3 mb-2">
        <h2 className="label !text-[12px] !text-fg">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Bar({ counts, total }) {
  const order = ['ok', 'warn', 'down', 'unreachable', 'stopped'];
  const t = total || order.reduce((a, k) => a + (counts[k] || 0), 0) || 1;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-line">
      {order.map((k) => counts[k] ? <div key={k} className={`bg-lv-${k}`} style={{ width: `${(counts[k] / t) * 100}%` }} title={`${counts[k]} ${k}`} /> : null)}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="panel p-6 text-dim text-center">{children}</div>;
}

export function Err({ error }) {
  if (!error) return null;
  return <div className="panel border-down/50 bg-[#1d1011] text-[#ffb4ae] px-3 py-2 text-[12px] mono whitespace-pre-wrap">{error.message || String(error)}</div>;
}

export function Delta({ value }) {
  if (value == null) return null;
  if (value <= 1) return null; // the tip moves during one probe sweep
  return <span className={`ml-1 text-[11px] ${value > 0 ? 'lv-warn' : 'text-dim'}`}>−{value}</span>;
}

export function Meter({ value, warn = 85 }) {
  if (value == null) return <span className="text-faint">—</span>;
  const level = value >= warn ? 'warn' : 'ok';
  return (
    <span className="inline-flex items-center gap-1.5 justify-end w-full">
      <span className="inline-block w-8 h-1 rounded bg-line overflow-hidden"><span className={`block h-full bg-lv-${level}`} style={{ width: `${Math.min(100, value)}%`, opacity: 0.8 }} /></span>
      <span className={level === 'warn' ? 'lv-warn' : ''}>{Math.round(value)}%</span>
    </span>
  );
}

const STATUS_LEVEL = { queued: 'stopped', preparing: 'info', review: 'warn', confirmed: 'info', running: 'info', succeeded: 'ok', failed: 'down', cancelled: 'stopped', interrupted: 'warn', rejected: 'down' };
const ACTIVE = new Set(['queued', 'preparing', 'confirmed', 'running']);

export function OpBadge({ status }) {
  const l = STATUS_LEVEL[status] || 'stopped';
  return <span className={`inline-flex items-center gap-1.5 lv-${l} font-medium`}><span className={`dot bg-lv-${l} ${ACTIVE.has(status) ? 'live' : ''}`} />{status}</span>;
}

