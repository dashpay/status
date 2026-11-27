// What a reason is about. The evaluator attaches one of these codes to every
// reason it gives (shared/evaluate.js); the incident producer keys a host's
// faults on the code and subject (server/incidents.js) and never reads the
// sentence, so the wording on the board can change without touching a case.
//
// Open cases are keyed on these names: renaming a code, or changing what its
// subject holds, closes and reopens every case that has it. A value names the
// subject: one host can have several such faults, told apart by it.
export const REASON_CODES = Object.freeze({
  probe: null, core_rpc: null, core_chain: null, core_sync: null, core_lag: null, core_headers: null,
  chainlock_age: null, chainlock_lag: null, dkg: null, peers: null, mn_sync: null, mn_ready: null, pose: null,
  platform_rpc: null, platform_sync: null, platform_lag: null, dapi: null, dapi_query: null, protocol: null,
  chain_ids: null, dapi_public: null, tls: null, consensus_round: null, memory: null, insight_query: null, insight: null,
  faucet_queue: null, faucet_wait: null, coinjoin: null, core_progress: null, platform_progress: null,
  faucet_balance: null, faucet_http: null, quorums: null, explorer_api: null, explorer_runtime: null,
  explorer_heights: null, explorer_lag: null, mainnet: null, images: null,
  disk: 'mount', wallet: 'wallet name', container: 'container name', p2p: 'port', service: 'service name', scrapes: 'service name',
});
// Shown with the host, never a fault of its own (info, stopped, deploying).
// The incident producer has no rule for it: asked, it answers "unclassified".
export const NOTE = 'note';
