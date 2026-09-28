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

Sign in with GitHub. Operators (GitHub user IDs in Settings) get:

- **Deploy**: choose nodes (evo/regular masternodes, seeds), components and image
  tags (Docker Hub suggestions, architecture check). The agent imports live state,
  enrolls nodes that are not yet enrolled (no restarts), and plans with images
  pinned by digest. Nothing changes until the plan is confirmed. Execution
  withdraws one host at a time behind dashnet health gates; progress and the full
  dashnet log stream live. Stopped/interrupted runs resume the same plan.
- **Restore stopped**, **Health gate** (managed-doctor) and **Enroll**.
- **Settings**: probe/discovery cadence, thresholds, operators, and per network:
  EC2 tag, chain, visibility, deployability, wallet balance visibility,
  observation window, timeout and checked endpoints (HTTP or DAPI gRPC-Web).
  Applied on the agent's next cycle.

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
