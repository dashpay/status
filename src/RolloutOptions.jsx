export default function RolloutOptions({ concurrency, setConcurrency, pauseMining, setPauseMining, native, miningEnabled = true }) {
  return <div className="flex flex-wrap gap-x-6 gap-y-2 items-end text-[12px]" data-rollout-options>
    <label><div className="text-dim mb-1">Nodes at once (maximum)</div>
      <select className="input mono" aria-label="Nodes at once" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
        {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{n === 1 ? ' · serial' : ''}</option>)}
      </select>
    </label>
    {miningEnabled && <div>
      <button type="button" className={`btn ${pauseMining ? '!border-accent' : ''}`} aria-pressed={pauseMining} onClick={() => setPauseMining(!pauseMining)}>Stop mining before upgrade: {pauseMining ? 'on' : 'off'}</button>
      <div className="text-dim mt-1">{native ? 'This devnet’s mining node' : 'miner-1 and miner-2'}. Automatically resumes after completion, failure or cancellation.</div>
    </div>}
    <div className="text-dim w-full">Each batch must preserve consensus quorum and pass readiness checks before the next. {native && 'For Core, the mining host is upgraded last, separately.'} No mining is stopped until the upgrade runs.</div>
  </div>;
}
