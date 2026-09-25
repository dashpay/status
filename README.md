# Dash Network Observatory

Public network health and a separately authorized operator workspace for
[dash-network-go](https://github.com/dashpay/dash-network-go). Testnet and Moutai
are first-class networks. Login is not an administration grant.

## Releases

Use **Actions → Stage release** to prepare a versioned draft with tested native
Linux AMD64/ARM64 bundles and checksums. There is no staging environment and no
automatic site deployment. See [release staging and promotion](deploy/RELEASING.md).

## Run and verify

```sh
npm ci --include=dev
npm test
npm run lint
npm run build
npx playwright install --with-deps chromium
node scripts/browser-check.mjs

# Private configuration; no AWS/SSH credentials are needed by the web process.
NETWORKS_CONFIG=/etc/dash-status/networks.json npm start
```

The browser check exercises actual rendered desktop/mobile pages, login,
per-network permissions, plan review, dispatch and logout against **fixture**
identity/workflow providers. It does not contact an identity provider or change
a real network. Screenshots land in ignored `artifacts/`.

Without `NETWORKS_CONFIG`, the existing single-network collector and dashboard
remain active. This allows a staged migration without replacing the live service
merely by merging source. Legacy routes are **not** mounted in console mode.

## Two views, one source of observations

- **Public:** explicitly published networks, node roles, running image versions,
  Core/Platform heights, DAPI availability, fresh/stale/unknown health and approved
  developer endpoints. No AWS IDs, IP inventory, private networks, configuration,
  logs, action history or controls.
- **Operator:** the same pages plus permitted network details, exact plan review,
  workflow history, enrollment, scoped upgrades and stopped-workload recovery.
  Operations use the same CLI through GitHub Actions. There is no browser shell
  or direct cloud credential path.

An import says **observed**, not healthy. Health requires a matching independent
`managed-doctor` result. Old observations become stale. Every intended target stays
in the report, including testnet's unresolved seed. A green Actions run never
replaces ongoing health collection.

The initial console launches **prepared plans**, not arbitrary versions supplied
by a browser. `managed-deploy` restores captured workloads: it is not presented as
new-node provisioning or a network reset. Protocol migration and automatic
downgrade are not inferred from image compatibility.

## Configuration and independent collection

Start from [networks.json](examples/networks.json) and
[collector.json](examples/collector.json). Inputs and operation state belong
outside the checkout and web root. Only explicitly listed endpoint URLs become
public; URLs with embedded credentials, query strings or fragments are refused.

`server/collect.js` is a separate process which runs only `managed-import` and
`managed-doctor` with a pinned CLI. It writes validated results atomically,
retains partial imports, and never promotes a report from another network.
Complete imports proceed to an independent health observation. Collector failure
is visible even when an older report is available. Both networks are observed
concurrently; repeated timer invocations do not overlap.

The example systemd units in [deploy/](deploy/) use separate `dash-observer` and
`dash-status` users. Prepare report directories owned by `dash-observer`, group
`dash-observations`, mode `0750`; grant the web process group read access only.
Reports are `0640`, collector logs `0600`. Keep SSH/AWS credentials and manifests
in `/etc/dash-observer`, accessible only to the observer. The web user cannot read
them. The observer AWS policy needs scoped read-only EC2/STS access, not deployment
permissions. Its SSH account must be an explicitly approved operational identity.
No new remote access authority is silently provisioned by the collector.

Use a health window longer than the network's empty-block interval (currently
four minutes for Moutai). The web process defaults to loopback; terminate HTTPS
at a trusted reverse proxy and configure the **exact** public origin. For a
container, set `BIND_ADDRESS=0.0.0.0` only behind the intended proxy boundary.

## GitHub sign-in and authority

Configure a GitHub OAuth application with callback
`https://YOUR-ORIGIN/api/auth/callback`. Install its `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` through the host's secret manager, never browser
configuration, Git, chat, or public artifacts. Missing credentials leave the
public view available and sign-in unavailable.

Grants use stable **numeric GitHub user IDs**, not mutable display names:

```json
"operators": {
  "123456": {
    "networks": ["testnet", "devnet-moutai"],
    "actions": ["import", "doctor", "enroll", "upgrade", "deploy"]
  }
}
```

Replace the example ID after verifying identity and authority. An authenticated
but unlisted user remains a public viewer. Private networks require a configured
viewer or network grant. OAuth state is single-use and browser-bound. Sessions
are server-side, expire after eight hours and are lost on restart; run one console
instance until a shared session store is deliberately implemented. Cookies are
HttpOnly, SameSite=Lax and Secure on HTTPS. Mutations require both the exact Origin
and a session CSRF token. Logout invalidates the server session.

## Reviewed operations and Actions

Keep `workflow.enabled` false until the corresponding trusted-main workflow,
protected `testnet-operations`/`devnet-operations` environments, scoped AWS OIDC
roles, private artifact bucket and SSH trust have been configured and verified.
The console dispatches only `dashpay/dash-network-go`, `managed.yml`, `main`.
The backend computes inputs; browsers cannot supply workflow URLs or refs.

Prefer a narrowly installed GitHub App with Actions write and Contents read for
that repository. Set `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` and
`GITHUB_APP_PRIVATE_KEY_FILE` on the server. Short-lived installation tokens are
cached server-side. A repository-scoped `DASHNET_WORKFLOW_TOKEN` is also supported
for an explicitly provisioned deployment; it is never returned to a browser.

Publish the same reviewed plan to the console's private `plan` path and the
workflow's private artifact input. The exact plan ID shown to the operator is
passed as CLI confirmation; a changed artifact is rejected. Read-only imports
and plan outputs are **not** automatically promoted to privileged inputs.

Every request has a durable unique ID before dispatch. An ambiguous response is
marked unknown and never blindly dispatched twice. Run names include that ID;
reconciliation links only a unique matching main-branch run. Pending/unknown
requests block additional console operations on the same network. Actions
concurrency and the CLI's shared journal provide execution exclusion independently
of this UI. Keep `/var/lib/dash-status/operations` durable and private.

Do not remove a pending request to make a failed run disappear. Inspect Actions
and the shared CLI journal, establish that the previous controller has stopped,
then recover the exact existing operation using the CLI runbook.

## Delivery boundaries

This source does not publish a website, create OAuth applications, grant access,
enroll Moutai/testnet, or restart their services. Real login and real workflow
dispatch must be verified against configured infrastructure before enabling
operator execution. Browser fixtures and unit tests are not that live proof.
