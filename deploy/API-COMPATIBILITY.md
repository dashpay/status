# Preserve the original status API

The multi-network UI, GitHub login and operator controls are additions to the
status dashboard. They must not replace its existing API. Original routes keep
their Testnet meaning and exact payloads; network-specific APIs use new paths.

| Original route | Contract |
| --- | --- |
| `GET /api/nodes` | Original node array, complete inventory and all original fields |
| `GET /api/nodes/:name` | Node object; invalid name 400, missing node 404 |
| `GET /api/proposer` | Current/next proposer, node names, height and update time |
| `GET /api/config` | Original network name |
| `GET /api/health` | Node totals, health-category counts and SSE client count |
| `GET /api/events` | Unbuffered SSE, including `nodeUpdate` and `proposerUpdate` |

Existing optional `API_TOKEN` authentication stays with the original collector.
Forward Authorization unchanged. Do not inject a token, require an OAuth session
for previously public routes, or reconstruct a reduced payload from console data.

## Existing AWS host

The original collector runs privately on `127.0.0.1:3002`; the console is on
`127.0.0.1:3004`. Install [nginx-legacy-api.conf](nginx-legacy-api.conf) as
`/etc/nginx/snippets/dash-status-legacy-api.conf` and include it in **both** public
HTTP/HTTPS application server blocks. Keep the normal `/api/` and `/` locations
pointing at the console. Do not use a `^~ /api/` prefix that overrides the legacy
route allow-list. Never proxy arbitrary legacy paths into the new namespace.

Before changing nginx, save a root-only backup and check the collector's node
coverage. Run `nginx -t`, reload, then allow the new workers to start and verify:

```sh
node scripts/check-legacy-api.mjs https://status.testnet.networks.dash.org 82
```

This tests real JSON responses, error codes, live SSE delivery, network pages and
anonymous operator denial without printing private inventory. For an API-token
deployment, pass the token through `STATUS_API_TOKEN` using protected runtime
configuration, never command-line arguments. The deployed collector is a live
API dependency, **not only a rollback container**: retain its health/restart
checks, private configuration and inventory. The console container's own
loopback health endpoint is separate from the public legacy `/api/health`.

If validation fails, restore nginx from the backup, validate and reload. No
collector or web-container restart is required for this routing correction.

## Release gate

`scripts/smoke-api-compat.mjs` starts the real original collector and console
behind nginx using this exact snippet. It checks the old API and SSE alongside
new routes, then repeats with the collector's existing bearer-token protection.
All subsequent UI, collector and operator changes must pass this compatibility
gate. Adding Moutai or controls is not permission to remove fields, routes,
original target coverage or update events.
