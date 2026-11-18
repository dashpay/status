# Platform reset: initial protocol version

On `/n/<devnet>/reset`, **Initial Platform version (PV)** selects the initial
protocol version for the new Platform genesis. It is independent of the Drive,
DAPI and Tenderdash image tags; choose images supporting the requested PV.
Blank preserves the installed genesis PV (which can differ from current
consensus PV after protocol activation).

The API accepts `options.genesisProtocolVersion`, an optional integer in
`1..4294967295`. This applies to native dashnet and imported dashmate devnets,
including imported Tenderdash seeds. Preparation renders the choice without
wiping; review shows previous and selected genesis PV. Confirmation remains
required before the existing reset executor runs.

The only admitted genesis deltas are the reviewed ChainLock anchor and explicit
PV (`consensus_params.version.app_version`). Core, node keys and all other
genesis fields retain their existing preservation checks. Native transition
identity binds PV, and verified reset receipts update Connect's initial PV.
Original deployment plans and pinned executors stay immutable.

Focused checks:

```
node --test agent/reset-native.test.js agent/reset-journal.test.js agent/devnet-config.test.js agent/agent.test.js
python3 -m unittest agent/test_reset_dashnet.py agent/test_reset_pv.py
npm run build
node scripts/browser-reset-pv-check.mjs
```

Browser checks need the environment's cached Chromium dependencies. They use
local fixtures and submit to the real web handler; no cloud reset runs.
