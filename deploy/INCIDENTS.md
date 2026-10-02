# Issues API and autonomous incident response

## API

`GET /api/issues` is additive. It returns `schemaVersion: 1`, observation time,
`stale`, and incident lifecycle records. HTTP 503 means the issue collector is
missing/stale; it must not be interpreted as an empty healthy fleet.

Anonymous callers see only public-network issues and redacted CI/AWS summaries.
Host identities, resource IDs, error text, branches, evidence and private networks
are absent. Network membership is not account-wide infrastructure access.
Admins, or a dedicated read-only bearer token loaded through
`INCIDENT_API_TOKEN_FILE`, receive complete evidence, source coverage and delivery
state. Never put tokens in query strings or reuse the OAuth/agent credential.

Records carry stable fingerprints, revisions, first/last observation, severity,
source identity, and open/resolved state. Resolution requires positive fresh
rule-specific evidence. Missing observations, maintenance suppression and failed
collection never count as recovery. Evidence is untrusted data, not executable
instructions. Incident history is separate from operation history.

## Data and delivery

The unprivileged `STATUS_MODE=incidents` sidecar is the **single writer** of
`data/incidents/state.json`. The rest of `/data` is read-only; it has no cloud,
SSH, Docker or OpenClaw credentials. Every minute it evaluates network state,
CI reporters/GitHub queue and AWS inventory/runtime-health results. Events are
committed before transmission and acknowledged only after receiver persistence.

- Deterministic issue/revision IDs; receiver rejects conflicting duplicates.
- HMAC-SHA256 over `timestamp + '.' + exact JSON body`, five-minute request window.
- HTTPS to a pinned Tailscale node; redirect following disabled. The status host
  remains publicly accessible over its existing HTTPS listener.
- Durable outbox, byte-bounded batches, retry backoff, and poison-event quarantine.
  Delivery health reports backlog, last ACK, receiver worker state and quarantines.
- A local receiver watchdog diagnoses a missing producer heartbeat after five
  minutes, even if the status server itself cannot send an alert.

Deploy `compose.yml` together with `incident-compose.yml`. The normal deployment
script automatically retains this override when
`/etc/dash-status/incidents/compose.env` exists. The environment file supplies
`INCIDENT_WEBHOOK_URL`, `INCIDENT_RECEIVER_HOST`, and `INCIDENT_RECEIVER_IP`.
The latter pins the FQDN to its tailnet IPv4 address while TLS verifies its name.
Provision distinct HMAC and API-reader secrets as restricted files, never Git,
container environment text, command-line arguments or build layers.

The Go deployment binary remains pinned by `DASHNET_REF`; enabling monitoring
must not implicitly upgrade a network or adopt a newer deployment recipe.

## Receiver and worker

`deploy/incident-broker/broker.py` uses Python's standard library and SQLite
(WAL + FULL synchronization). Install its systemd unit on the trusted OpenClaw
host, not the public status server. Site-specific unit settings supply paths,
the exact Tailscale peer and the container state-directory mapping.

Bind the receiver to loopback behind **Tailscale Serve HTTPS port 8444**. Serve
must stay tailnet-only; do not enable Funnel. It forwards the authenticated
network peer in `X-Forwarded-For`; the receiver also verifies the HMAC. Preserve
any existing dashboard Serve handler. Root/public nginx does not proxy this API.

Before activation, install a local `authorization.json` recording the real owner
instruction, source session and allowed scope. The repository policy alone does
not authorize infrastructure changes. An `ENABLED` file admits worker execution;
removing it pauses new work without discarding the inbox.

The worker defaults to one batch, with per-scope sessions and a 15-minute
cooldown, capped globally at eight batches/hour and 48/day. An operator-reviewed
`concurrency.json` beside the inbox may allow two disjoint batches:

```json
{
  "schemaVersion": 1,
  "maxActive": 2,
  "scopes": {
    "network:example-a": ["fleet:example-a", "host:shared-builder"],
    "network:example-b": ["fleet:example-b"],
    "ci:shared-builder": ["host:shared-builder"],
    "aws:example-region": ["fleet:example-a", "fleet:example-b"]
  }
}
```

The map is trusted local deployment configuration, never telemetry. Review
physical host aliases, network ownership, AWS overlap and shared infrastructure
before granting concurrency. Pause admission and check existing ownership before
changing it; never shrink the resource set of an active/uncertain scope. Missing
configuration preserves serial behavior; malformed configuration admits nothing.
Unknown scopes run only alone. SQLite atomically reserves capacity and intersecting
resource locks; running **and uncertain** scopes count toward the two-slot cap.
The same scope cannot run twice. Agents must stay within their assigned scope;
shared control-plane changes require coordinated exclusive admission. These are
scheduler reservations and agent constraints, not an OS-level mutation sandbox.

An optional `bindings` array narrows admission for **exact** verified targets,
not every alert in the same region. Each entry has `scope`, `code`, `target`,
nonempty `resources`, and `identity` (the expected live identity to reverify).
For example, a known CloudWatch disk alarm bound to an exact Testnet EC2 ID
can carry `fleet:testnet` and `ec2:<instance-id>` instead of a broad AWS-region
lock. Unknown targets keep the conservative scope locks. A missing/mismatched
live identity is a hold, not permission to follow the new target. Event resource
locks persist in SQLite at claim time and survive config changes and restart.

Fresh private API readback
supersedes stale/recovered backlog before triage. The fixed local policy requires
independent live reproduction before every mutation. Payload strings never choose
commands, models, tools, session paths or credentials.

Before each invocation the worker uses `sessions.patch` to persist and verify
`openai/gpt-6-astra@openai:work` at `high` (the owner's
`daniel@ktechmidas.net` OAuth account). User-origin model/account pins disable
the Gateway model fallback ladder. Invocation is through
`docker exec infraclaw openclaw agent --model openai/gpt-6-astra --thinking high`,
without a shell or external delivery. A failed/mismatched pin pauses dispatch
before invoking a model; never inherit the global CLIProxy default. A per-run
`.route.json` records the verified selection without credentials.
Normal completion requires explicit CLI success and a fresh run-specific
completion receipt declaring no outstanding child sessions. Uncertain completion
is independently reconciled from the Gateway, not inferred from elapsed time. It never
claims service recovery from agent completion. Known-scope uncertainty retains
its slot/locks and a `HELD-<run>` marker while a disjoint lane may continue.
Unknown uncertainty and route failure pause admission globally. Restart converts
abandoned `running` rows to `uncertain` with the same run and saved locks; known
disjoint work may continue. A supervisor exits if an essential thread dies so
systemd's restart policy can recover instead of silently losing the worker.

Every 30 seconds, read-only lifecycle reconciliation verifies the actual session.
Two identical terminal observations at least 30 seconds apart, a non-aborted
terminal run, and a fresh no-children receipt after admission can release a held
response. Original CLI output (including timeout) remains untouched; a separate
`.reconciled.json` records the basis. This does not resolve the service incident.
No release while the session is active or identity/completion evidence is missing.
If an idle session lacks a valid receipt, one durable, bounded bookkeeping-only
request is allowed on the required route. It cannot redo the repair, spawn
children, mutate infrastructure or send messages. The once-per-run marker is
written before invocation; ambiguous delivery is not retried. A remaining
ambiguity is visible as attention required, not falsely completed.

`queue-state.json` and authenticated delivery health expose active scopes, queued
events and admission reasons (paused, capacity, resource conflict, budget,
cooldown, eligible), plus lifecycle/check status. They contain no credentials.
Read these before assuming an idle slot means the queue is empty. Receiver-wide
outage still needs the independent external observer described below.

Scoped **infrastructure, service and network/wallet operations** are autonomous.
The owner's latest clarification explicitly allows ProTx/PoSe recovery, mixing
controls, incident-related wallet/network-state repairs and Core/Platform runtime
configuration changes. Do not fork/patch Core or Platform product code, libraries
or custom builds; report product defects to the configured Slack alerts channel
(`C0C5QSM5FFG`). Operating those products is not modifying their source. Difficult auxiliary-service
or cross-repository issues are discussed with a direct Astra/High session on the
same pinned work account carrying the
same limits. Every incident request includes this boundary through the fixed
`incident-broker/policy.md`; keep the live local authorization record aligned.
Require durable root-cause correction and recurrence verification, not merely
file deletion, a restart or additional disk space. For example, diagnose and fix
broken log rotation/retention rather than repeatedly clear logs. A temporarily
recovered service with an unresolved cause remains an explicit follow-up/blocker.
Human CI jobs/workspaces/caches, wallet backups and unrelated balances/data are
preserved. No broad prune, destructive reset or idle-resource deletion is
authorized merely by telemetry. Reverify target/network/wallet identity and live
ownership before operational repairs; no duplicate active repair. See
`incident-broker/policy.md` and the deployment-local authorization record.

## Remediation board

`/remediation` shows unique issues, queued event revisions, active work, waiting
reasons, blockers and recovery. `/api/remediation` is read-only; the existing
incident API bearer token or administrator session enables curated repair notes.
Public responses omit target identities, session keys, resource locks and notes,
and exclude non-visible networks from both cases and counts. SSE invalidation
contains only a timestamp; 15-second polling provides a reconnect fallback.

The receiver adds a bounded remediation snapshot to its authenticated delivery
ACK, which the producer already persists. No separate public receiver, inbound
control endpoint, session enumeration or executable report parsing is added.
Missing/stale data is explicit, never an apparently healthy empty queue.

Terminal receipts may include `summary`, `changes` (verified changes only),
`blocker` and `nextAction`. Historical receipts can be supplemented by a private
`presentations.json` in the receiver state directory, keyed by run ID; optional
`issues` maps override notes by issue ID. This read-only presentation file cannot
change outcomes, release reservations or resolve monitoring incidents. Never
copy secrets or raw report bodies into it. It is not committed to the repository.

A blocked response remains blocked even after symptom recovery. A resolved
response is only shown as verified fixed when independent monitoring also records
recovery; otherwise it awaits verification. Monitoring-only recovery is labelled
recovered, without attributing an autonomous fix. Completed investigations are
not automatically successful repairs, and no dashboard action mutates the queue.

## Coverage and remaining limits

| Domain | Current evidence | Explicit limits |
| --- | --- | --- |
| Networks | Fresh collector/discovery, per-host evaluated faults, endpoints, Core/Platform/DAPI/service checks | Existing inventory scope; mainnet remains a limited observer, not fleet ownership. No production payment/transaction sent as a synthetic check. |
| CI | Every registered reporter including never-seen hosts, measured freshness, disk/memory, unavailable runners, failed jobs and stale/long queue | Only registered reporters/known repositories; failed tests are not necessarily infrastructure faults. No human-idleness inference from runner-idle alone. |
| AWS | Inventory freshness/errors, EC2 system/instance checks and scheduled events, existing CloudWatch alarms, review-only unattached resources | Existing alarms only, not automatic alarm provisioning. No target-group health, AWS Health API, S3/application SLO checks or cost-anomaly/budget detector yet. Empty alarm sets are not proof of service health. |
| Pipeline | Producer snapshot freshness, durable delivery/backlog, receiver watchdog and worker state | Host/tailnet-wide failure needs an independently hosted external observer for redundancy. |

`dash-network-go`'s artifact resolution proves architecture/digest availability,
not Platform Explorer compatibility. Explorer is launched by `status`'s auxiliary
service code, outside the Go core component contract. PE 2.5.3's Platform 4.1
codec cannot handle newer V2 document transitions. A replacement requires the
real failing block fixture, protocol-aware handlers, isolated replay through tip,
and immutable artifact pins; restarting/skipping a block is not a repair.

## Validation and rollback

Run Node tests with an executable `TMPDIR` when `/tmp` is mounted noexec, lint,
frontend build, Python probe tests, and `incident-broker/test_broker.py`. Test
invalid/stale/future authentication, replay, crash/lost-ACK recovery, private API
projection, positive-only resolution, pagination failure, and worker ambiguity.
A `pipeline_self_test` is explicitly no-mutation and verifies a real private
OpenClaw turn and its completion receipt.

Before rollout preserve the image ID, compose files, settings and authorization
record. Verify no active network operation before replacing the agent. Rollback
restores the prior image/compose while preserving incident inbox/outbox and all
network/CI/user data. Pause the worker by removing `ENABLED`; do not delete its
database or rerun uncertain records. Stop the producer before editing its code.
