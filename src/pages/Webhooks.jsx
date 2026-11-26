import { useEffect } from 'react';
import { ago, clock, num, useNow, useResource, useSession } from '../lib.js';
import { Dot, Empty, Err, Section, Stat } from '../ui.jsx';

// Wake hooks: a webhook from GitHub or the forum is taken here and wakes a
// listener on a machine the sender cannot reach (deploy/WAKE-HOOKS.md).
const SENDER = { github: 'GitHub', xenforo: 'XenForo' };
const WORD = { ok: 'listening', warn: 'check', down: 'not listening', info: 'starting' };

function Listener({ listener, now }) {
  const title = listener.lastSeenAt ? `last asked ${clock(listener.lastSeenAt)}` : 'has not asked since the console started';
  return (
    <span className="inline-flex items-center gap-1.5 mr-3" title={title}>
      <Dot level={listener.connected ? 'ok' : 'down'} title={listener.connected ? 'connected' : 'not connected'} />
      <span className="mono">{listener.id}</span>
      {!listener.connected && <span className="lv-down">{listener.lastSeenAt ? `away ${ago(listener.lastSeenAt, now)}` : 'never seen'}</span>}
    </span>
  );
}

export default function Webhooks() {
  const session = useSession();
  const now = useNow(1000);
  const { data, error, reload } = useResource('/api/hooks', (t) => t === 'hooks' || t === 'settings');
  // A wake is pushed; a listener going away is not an event, so look again now and then.
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]);
  if (!data?.summary) return <div className="pt-4">{error ? <Err error={error} /> : <span className="text-dim">Loading…</span>}</div>;
  const s = data.summary, hooks = data.hooks || [];
  // The public view has no refusals and no "to check": those are what a stranger could move by guessing names.
  const trouble = [s.down && `${s.down} not listening`, s.warn && `${s.warn} to check`, s.starting && `${s.starting} starting`].filter(Boolean).join(' · ');
  const deliveries = s.woke + s.ignored + (s.refused || 0);
  return (
    <div className="pt-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-[15px] font-semibold">Webhooks</h1>
        <span className="text-dim text-[12px]">deliveries from GitHub and the forum that wake work on machines they cannot reach</span>
      </div>
      {data.public && <div className="mt-2 text-[12px] text-dim">Public view: counts only. Which hooks exist and what listens to them is left out. {session.user ? 'Your account has no access to more.' : 'Sign in for details.'}</div>}
      {/* What is on screen is the last answer; say so when a newer one could not be had. */}
      {error && <div className="mt-2"><Err error={{ message: `Not refreshed since ${clock(data.at)}: ${error.message || error}` }} /></div>}
      {data.invalid && <div className="mt-2"><Err error={{ message: 'The hooks file on the status host does not parse, so no hook exists: every delivery is refused and every listener is turned away until it is fixed.' }} /></div>}
      <div className="mt-3 grid gap-2 grid-cols-2 md:grid-cols-4">
        <Stat label="Hooks listening" value={`${s.listening}/${s.hooks}`} level={s.hooks === 0 ? (data.invalid ? 'down' : undefined) : s.down ? 'down' : s.starting ? 'info' : 'ok'}
          sub={s.hooks === 0 ? 'none configured' : trouble || 'every listener connected'} />
        <Stat label="Last wake" value={s.lastWakeAt ? `${ago(s.lastWakeAt, now)} ago` : '—'} sub={s.lastWakeAt ? clock(s.lastWakeAt) : 'none yet'} />
        <Stat label="Last delivery" value={s.lastDeliveryAt ? `${ago(s.lastDeliveryAt, now)} ago` : '—'} sub={s.lastDeliveryAt ? 'accepted, woke or not' : 'none since the console started'} />
        <Stat label="Deliveries" value={num(deliveries)} level={s.warn ? 'warn' : undefined} title={`since the console started, ${clock(data.startedAt)}`}
          sub={`${num(s.woke)} woke · ${num(s.ignored)} ignored${s.refused == null ? '' : ` · ${num(s.refused)} refused`}`} />
      </div>
      {!data.public && (
        <Section title="Hooks" right={<span className="text-dim text-[11px]">counts since the console started, {ago(data.startedAt, now)} ago</span>}>
          {hooks.length === 0 ? <Empty>No hook is configured on this host.</Empty> : (
            <div className="panel scroll-x">
              <table className="grid w-full text-[12px]">
                <thead><tr><th>Hook</th><th>Sender</th><th>Wakes on</th><th>Listener</th><th>Last wake</th><th className="num" title="Wakes ever, kept across restarts of the console">All wakes</th><th className="num" title="Deliveries since the console started that woke the listener">Woke</th><th className="num" title="Authentic deliveries since the console started that the hook does not wake for">Ignored</th><th className="num" title="Deliveries since the console started with a wrong signature or secret">Refused</th></tr></thead>
                <tbody>
                  {hooks.map((h) => (
                    <tr key={h.name} className="!cursor-default">
                      <td><span className={`inline-flex items-center gap-1.5 lv-${h.level}`} title={h.reason || WORD[h.level]}><Dot level={h.level} title={WORD[h.level]} /><span className="mono text-fg">{h.name}</span></span></td>
                      <td>{SENDER[h.source] || h.source}</td>
                      <td className="mono text-dim">{h.events ? h.events.join(', ') : 'every event'}{h.matchRules > 0 && <span className="tag ml-1.5" title="Only deliveries that match one of the hook's rules wake; the rest are ignored">{h.matchRules} rule{h.matchRules === 1 ? '' : 's'}</span>}</td>
                      <td>{h.listeners.length ? h.listeners.map((l) => <Listener key={l.id} listener={l} now={now} />) : <span className="lv-down">none</span>}</td>
                      <td className="mono" title={h.at ? clock(h.at) : undefined}>{h.at ? <>{ago(h.at, now)} ago <span className="text-dim">· {h.event}</span></> : <span className="text-dim">never</span>}</td>
                      <td className="num text-dim">{num(h.seq)}</td>
                      <td className="num">{num(h.deliveries.woke)}</td>
                      <td className="num text-dim">{num(h.deliveries.ignored)}</td>
                      <td className={`num ${h.level === 'warn' ? 'lv-warn' : 'text-dim'}`} title={h.deliveries.lastRefusedAt ? `last refused ${clock(h.deliveries.lastRefusedAt)}` : undefined}>{num(h.deliveries.refused)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hooks.filter((h) => h.reason).map((h) => (
            <div key={h.name} className={`mt-2 text-[12px] lv-${h.level}`}><span className="mono">{h.name}</span>: {h.reason}</div>
          ))}
          <p className="mt-3 text-[12px] text-dim max-w-[900px]">
            A wake carries no data: the console checks who sent a delivery and tells the listener only that something happened; the work then looks for itself.
            Ignored deliveries are authentic ones the hook does not wake for. A refused one had a wrong signature or secret.
            When a listener is not connected nothing is lost for good: each piece of work keeps a slower timer of its own.
          </p>
        </Section>
      )}
    </div>
  );
}
