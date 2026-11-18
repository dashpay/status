# Upgrade rollout controls

Both Deploy and the network's Upgrade now panel provide a maximum number of
nodes to replace together (1–16), plus an optional **Stop mining before upgrade**
toggle. The toggle stages a policy; it does not stop anything while editing or
reviewing a plan. Review shows the plan-bound maximum and exact mining hosts.
Mining automatically resumes on success, failure and cancellation.

Legacy Testnet controls the two discovered, tagged, instance-pinned `miner-1`
and `miner-2` services. Native devnets use the mining host in their deployment
plan; Core handles it last, on its own. An unsafe validator batch is reduced to
fit the observed quorum. Ordinary masternodes use the requested concurrency.

New plans use readiness checks, not fixed four-minute waits between nodes.
Regular managed masternode batches check affected targets, without repeatedly
scanning unrelated fleet services; selected-target progression is checked once
at the end. Startup/database migration time remains real work and is displayed.

Request options: `{ "concurrency": 3, "pauseMining": true }`. An omitted policy
retains old API behavior. Each native phase and managed plan must return matching
`rollout` fields or preparation fails; older executors cannot silently ignore the
options. Upgrade binaries are immutable per operation. Native adoption retains
existing recipe compatibility checks, including the optional mining recipe.
Configuration/schema migrations are separate and cannot combine these controls.

This change does not modify live nodes, running plans or deployed executors.
Deploy the matching engine and console together while operation runners are idle.
The new UI controls require an executor that supports both flags; older/incompatible
native pins produce an explicit compatibility error rather than unsafe adoption.

Focused UI verification: build the frontend, then run
`node scripts/browser-rollout-check.mjs` with Playwright available. It submits
Testnet/native options through the real web handler at desktop and mobile sizes,
using local fixtures, without an agent or cloud operation.
