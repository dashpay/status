import { useState } from 'react';
import { span, useResource } from '../lib.js';
import { Empty, Err, Section, Stat } from '../ui.jsx';

function copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); }
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label = 'copy' }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="text-dim hover:text-fg text-[11px]" onClick={() => { copy(text); setDone(true); setTimeout(() => setDone(false), 1200); }}>{done ? 'copied' : label}</button>;
}

// Members' view of a console devnet's connection files, in the shape of the
// legacy dash-network-configs outputs (devnet-<name>.conf / .inventory / .yml).
export default function Connect({ name }) {
  const { data, error } = useResource(`/api/networks/${name}/config`, (t, d) => t === 'network' && (d.name === name || d.name === '*'));
  const [file, setFile] = useState(0);
  if (error) return <div className="mt-4">{error.status === 404 ? <Empty>{error.message}</Empty> : <Err error={error} />}</div>;
  if (!data) return <div className="mt-4 text-dim">Loading…</div>;
  const { facts: f, files } = data;
  const validators = f.hosts.filter((h) => h.role === 'validator');
  const current = files[file] || files[0];
  return (
    <div>
      <div className="mt-4 grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Core devnet" value={f.core.devnet} sub={`${f.core.chain} · port ${f.core.port}`} />
        <Stat label="Core block time" value={`${f.core.blockSeconds} s`} sub={`genesis height ${f.core.genesisCoreHeight ?? '—'}`} />
        <Stat label="Platform chain" value={f.platform.chainId} sub={`protocol ${f.platform.initialProtocolVersion}`} />
        <Stat label="Platform epoch" value={span(f.platform.epochSeconds)} sub={`${f.platform.epochSeconds} s`} />
        <Stat label="DAPI endpoints" value={f.platform.dapi.length} sub={`gateway TLS ${f.platform.gatewayTls}`} />
        <Stat label="Spork address" value={f.core.sporkAddress || '—'} title={f.core.sporkAddress || ''} />
      </div>

      <div className="grid gap-x-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Section title="Files" right={<span className="flex items-center gap-3"><CopyButton text={current.text} /><button type="button" className="text-dim hover:text-fg text-[11px]" onClick={() => download(current.name, current.text)}>download</button></span>}>
          <div className="panel">
            <div className="flex gap-1 px-2 pt-2 border-b border-line">
              {files.map((x, i) => (
                <button key={x.name} type="button" onClick={() => setFile(i)} className={`px-2.5 py-1 text-[12px] rounded-t mono ${i === file ? 'bg-panel-2 text-fg' : 'text-dim hover:text-fg'}`}>{x.name}</button>
              ))}
            </div>
            <pre className="p-3 text-[11.5px] mono overflow-auto max-h-[560px] whitespace-pre">{current.text}</pre>
          </div>
          <div className="mt-1.5 text-faint text-[11px]">Public facts only, like the legacy dash-network-configs outputs. Operator, spork and faucet private keys stay on the hosts.</div>
        </Section>

        <div className="min-w-0">
          <Section title="Services">
            <div className="panel p-3 text-[12px] space-y-1.5">
              {Object.entries(f.services).map(([k, url]) => (
                <div key={k} className="flex gap-2 min-w-0"><span className="text-dim w-20 shrink-0">{k}</span><a className="link mono truncate" href={url} target="_blank" rel="noreferrer">{url}</a></div>
              ))}
              {f.faucetAddress && <div className="flex gap-2 min-w-0"><span className="text-dim w-20 shrink-0">faucet addr</span><span className="mono truncate">{f.faucetAddress}</span><CopyButton text={f.faucetAddress} /></div>}
            </div>
          </Section>
          <Section title="DAPI addresses" right={<CopyButton text={f.platform.dapi.join(',')} label="copy comma-separated" />}>
            <div className="panel p-3 text-[12px] mono space-y-0.5 max-h-[220px] overflow-auto">{f.platform.dapi.map((u) => <div key={u}>{u}</div>)}</div>
          </Section>
          <Section title="Seed nodes (addnode)" right={<CopyButton text={f.core.seeds.map((s) => `addnode=${s}`).join('\n')} />}>
            <div className="panel p-3 text-[12px] mono space-y-0.5">{f.core.seeds.map((s) => <div key={s}>{s}</div>)}</div>
          </Section>
        </div>
      </div>

      <Section title={`Evo masternodes (${validators.length})`}>
        <div className="panel overflow-x-auto">
          <table className="grid w-full text-[12px]">
            <thead><tr><th>Node</th><th>Public IP</th><th>ProTx hash</th><th>Operator public key</th><th>Platform node id</th></tr></thead>
            <tbody className="[&_tr]:!cursor-default">
              {validators.map((h) => (
                <tr key={h.name}>
                  <td className="mono">{h.name}</td>
                  <td className="mono">{h.publicIp}</td>
                  <td className="mono" title={h.proTxHash || ''}>{h.proTxHash ? <span className="flex items-center gap-2">{h.proTxHash.slice(0, 16)}…<CopyButton text={h.proTxHash} /></span> : '—'}</td>
                  <td className="mono" title={h.operatorPublicKey || ''}>{h.operatorPublicKey ? `${h.operatorPublicKey.slice(0, 16)}…` : '—'}</td>
                  <td className="mono">{h.platformNodeId || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
