# Dash Status

Live infrastructure board and operator console for DCG-run Dash networks
(testnet, devnets such as Moutai, mainnet support hosts), served at
https://status.testnet.networks.dash.org.

## How it works

```
EC2 (tag DashNetwork=<net>, Name dn-<net>-<role>-<n>)
        │ discovery every 5 min
        ▼
   agent ──SSH every 30 s──▶ every host: agent/probe.py (read-only)
     │                         Docker, Core RPC, Tenderdash RPC/P2P, DAPI gRPC,
     │                         Insight, faucet, wallets, load/mem/disk
     │  writes /srv/dash-status/data/state/<net>.json
     │
     │  reads  /srv/dash-status/data/requests/*.json   (from web)
     │  runs   dashnet managed-import / enroll / plan / upgrade / deploy / doctor
     ▼  writes /srv/dash-status/data/ops/<id>.{json,log}
   web ─── public board, GitHub sign-in, deploy form, review, live logs, settings
```

- **agent** (`STATUS_MODE=agent`) is the only process with credentials: the
  status host's IAM role (`dash-status-server`: EC2 describe, Instance Connect,
  dashnet journal) and its own SSH key. When the key is not yet authorized on a
  newly discovered host it pushes it once through EC2 Instance Connect. Host keys
  are pinned per instance ID. Deployments use the
  [dash-network-go](https://github.com/dashpay/dash-network-go) `dashnet` CLI,
  built into the image from its `main` branch.
- **web** (`STATUS_MODE=web`) has no cloud or SSH access. It evaluates agent
  state (every status carries its reason), serves the UI and SSE updates, writes
  operator settings, and queues operation requests.
- **legacy** (`INVENTORY_PATH` set) is the original single-network Testnet API
  (`/api/nodes`, `/api/events`, …), kept for existing consumers; see
  [API compatibility](deploy/API-COMPATIBILITY.md).

## Operating

Sign in with GitHub. Access is per GitHub account (bound to the numeric user id)
and managed by admins in **Settings → Access**: look up a login, choose a role
and networks, save.

| Role | Can |
| --- | --- |
| viewer | see granted networks in full detail (including private ones) and operation logs |
| operator | deploy, restore and health-gate the granted networks |
| admin | everything, on every network: settings, users, new devnets, Platform resets, deletion |

**Existing networks (testnet, Moutai):** *Deploy* chooses nodes, components and
image tags (Docker Hub suggestions, architecture check). The agent imports live
state, enrolls nodes that are not yet enrolled (no restarts) and plans with images
pinned by digest. Nothing changes until the plan is confirmed; execution withdraws
one host at a time behind dashnet health gates, with live progress and log.
Also *Restore stopped*, *Health gate* and *Enroll*.

**New devnet** (admins): name, sizing, component versions and service settings;
the agent runs dash-network-go `resolve` and `provision-plan` (read-only) and shows
the footprint, cost estimate, pinned digests and DNS names for review. After
confirmation: `provision` (BYOIP addresses) → `bootstrap-plan` → `host-trust` →
`bootstrap` → `deployment-plan` → `deploy` (Core, EvoNode registration, quorums,
Platform) → services → `doctor`. Every stage resumes after interruption, with the
exact dashnet binary the plans were made with. The devnet appears on the board
while it is built. Each devnet's wallet host also runs:

- `quorum-list-server` → `https://quorums.<name>.networks.dash.org`
- Platform Explorer (Postgres, indexer, API, per-devnet frontend) → `https://explorer.<name>…`
- dash-faucet from source, with its own funded wallet topped up every 15 minutes → `https://faucet.<name>…`
- Caddy with Let's Encrypt for all three.

Console devnets can be upgraded (dash-network-go `upgrade-plan`/`upgrade`, Drive,
DAPI, gateway, helper or Tenderdash, one validator at a time), have their services
re-applied from Settings defaults, and be deleted (instances, disks, BYOIP
addresses, DNS; the journal record keeps the name reserved).

**Platform wipe/redeploy** (admins, dashmate devnets such as Moutai) follows the
Platform reset rulebook: baseline and private backups on every HPMN and the seed,
image staging, a fresh ChainLock anchor verified everywhere and a canary on a
temporary dashmate home — all before review. After confirmation: wipe Platform on
all HPMNs, reset only the seed's Tenderdash data, apply images/anchor/epoch writing
only `config.json`, rendered Platform files and `dynamic-compose.yml`, start, and
verify READY, images, consensus, epochs (config/env/parsed), DAPI TLS and Core
preservation. Each stage must succeed on every target before the next.

**Settings** (admins): probe/discovery cadence, thresholds, access, new devnet
defaults (placement, sizing, versions, services) and per network: EC2 tag, chain,
visibility, deployability, balance visibility, observation window, timeout and
checked endpoints (HTTP or DAPI gRPC-Web). Applied on the agent's next cycle;
AWS account/region changes take effect after an agent restart.

Mainnet is monitored only.

## Develop

```sh
npm ci --include=dev
npm test && npm run lint && npm run build
npx playwright install chromium
node scripts/browser-check.mjs        # fixture state, public + operator flow, screenshots in artifacts/
STATUS_MODE=web STATUS_DATA_DIR=./data PUBLIC_ORIGIN=http://localhost:3001 npm start
```

## Deploy

On the status host (images are built there, Go and Node stages included):

```sh
sudo /opt/dash-status/src/deploy/deploy.sh            # origin/master
sudo /opt/dash-status/src/deploy/deploy.sh <git-ref>  # any ref
```

The script builds `dash-status:<rev>`, retags `dash-status:current`, restarts the
`web` and `agent` services from [deploy/compose.yml](deploy/compose.yml) and rolls
back if the web health check fails. nginx proxies `/` and `/api/` to
`127.0.0.1:3006`; the legacy routes in
[nginx-legacy-api.conf](deploy/nginx-legacy-api.conf) go to the legacy container
on `127.0.0.1:3002`. Operation history and agent state survive redeploys; an
agent restart during a running operation marks it interrupted (resumable).
