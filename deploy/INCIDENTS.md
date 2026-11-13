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
without a shell or external delivery. A failed/mismatched pin never invokes a
model and never inherits the global CLIProxy default: the batch returns to the
queue and the same route is retried with backoff (see "Self-recovery" below). A
per-run `.route.json` records the verified selection without credentials.
Normal completion requires explicit CLI success and a fresh run-specific
completion receipt declaring no outstanding child sessions. Uncertain completion
is independently reconciled from the Gateway. It never
claims service recovery from agent completion. Uncertainty retains
its slot/locks and a `HELD-<run>` marker: a known scope leaves a reviewed
disjoint lane free, serial mode and unknown scopes admit nothing else. Restart
converts `running` rows that had reached the model to `uncertain` with the same
run and saved locks; rows claimed but never invoked return to the queue. A
supervisor exits if an essential thread dies so
systemd's restart policy can recover instead of silently losing the worker.

### Self-recovery: nothing waits for a person to notice

`ENABLED` is the host operator's switch and the broker never renames or removes
it (the dashboard switch below is a second, independent gate).
Automatic holds live in SQLite and end by themselves:

- **Before the model is invoked** (fresh readback, evidence files, route pin, any
  unexpected error or a restart) nothing has run, so the batch returns to the
  queue. `events.invoked` is written immediately before the agent call and is
  the only thing that turns an interruption into a hold.
- **Route breaker.** A failed pin, or an invocation that ends within three
  minutes without a verified result (typically an unavailable account), opens
  `route_breaker`. Admission backs off 1, 2, 5, 10, then 30 minutes; the first
  claim after each delay is the probe and success closes the breaker. There is
  no fallback model or account.
- **Bounded holds.** A hold ends by receipt as before, or by lease: once the hold
  is older than its lease (15 minutes when the invocation died at once, two
  hours otherwise) **and** two Gateway observations a minute apart show no turn
  executing (`INACTIVE_STATES`, no pending permission, no activity for 15
  minutes), the slot and locks are released and `<run>.released.json` records
  the basis. The events become `abandoned` and are never replayed; the issue
  returns through the producer's next revision (a change, or the six-hourly
  reminder). An active session, or a Gateway that cannot be read, keeps the
  hold. Check `INACTIVE_STATES` against what `sessions.describe` reports for a
  failed run on the installed Gateway; an unlisted state only means the hold is
  kept and reported.
- **Bookkeeping check.** Up to three attempts per run (immediately, after 15
  minutes, after an hour). The route is pinned before an attempt is recorded,
  so an unavailable route defers the check instead of consuming it.
- **Admission delay.** A new event waits five minutes before it can be claimed,
  so the producer can recognise an upgrade in progress (below) and the fresh
  readback can withdraw the event. Withdrawn batches consume no dispatch budget.

Whatever still needs a person is listed in `attention` in the authenticated
ACK: an open route breaker, a hold older than 30 minutes, a queue that has
waited over an hour, or a configuration/worker/lifecycle error. The producer
turns that into the stall alert below.

On first start this release restores `ENABLED` from a single
`PAUSED-route-unavailable` or `PAUSED-<run>` left by an earlier release, since
those were automatic pauses. Any other `PAUSED-*` name is treated as an
operator's pause and left alone.

Every 30 seconds, read-only lifecycle reconciliation verifies the actual session.
Two identical terminal observations at least 30 seconds apart, a non-aborted
terminal run, and a fresh no-children receipt after admission can release a held
response. Original CLI output (including timeout) remains untouched; a separate
`.reconciled.json` records the basis. This does not resolve the service incident.
No receipt-based release while the session is active or identity/completion
evidence is missing. If an idle session lacks a valid receipt, a bounded number
of bookkeeping-only requests is allowed on the required route. They cannot redo
the repair, spawn children, mutate infrastructure or send messages. Each attempt
is recorded before its invocation. A run that never produces a receipt is
released by lease as `abandoned`, never as completed.

`queue-state.json` and authenticated delivery health expose active scopes, queued
events and admission reasons (paused, route, capacity, resource conflict, budget,
cooldown, settling, eligible), plus lifecycle/check status. They contain no credentials.
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

## Recognised change: upgrades do not enter the queue

Expected downtime is held, never resolved and never hidden. A held issue stays
open on the board as **Maintenance** with the reason, emits no event, and is
withdrawn by the receiver's fresh readback if it was already queued. When the
hold ends, a fault that is still present is emitted with fresh evidence.

| Signal | Holds | Ends |
| --- | --- | --- |
| Dashboard operation confirmed/running (existing) | the network | terminal status, or lease expiry |
| Dashboard operation **succeeded** | the network | 20 minutes after it finished |
| dashnet journal claimed by another runner (existing) | the network | 20 minutes after release; at once if the journal records an error |
| Container recreated (started under 20 minutes ago, `RestartCount` 0, running) | that host, the network's endpoint checks, its EC2 status check | 20 minutes after the last such start |
| Host rebooted (uptime under 20 minutes) | same | 20 minutes after boot |
| Two or more hosts changing at once | the network | when fewer than two are changing |

`server/change-activity.js` derives the observational signals from the fresh
probe every cycle, so a manual `docker compose pull && up` of the quorum
server, or a hand-run Testnet upgrade, is recognised without a dashboard
operation. A crash loop under a restart policy increments `RestartCount` and is
not a planned change. Failed, cancelled and interrupted operations get no
settle window, and a journal that records an error also ends rolling inference
for that operation. Holds are bounded: a host is held at most 90 minutes per
episode and a network at most three hours, so a recreate loop, or a journal
claim left behind by a crashed runner, becomes actionable. Mainnet and external networks are never held by inference.

## Stall alert

A stalled worker cannot report its own stall through the queue it is failing to
drain. The producer therefore raises it out of band when the receiver is
unreachable, the worker heartbeat is stale, dispatch is paused on the receiver
host with a backlog (switching it off from the dashboard is deliberate and is
not a stall), or the ACK's `attention` list is not empty. After 15 minutes it posts to the
optional webhook, repeats every six hours and posts once on recovery. The
`/remediation` board shows the same reasons (details for administrators only).

Set `INCIDENT_ALERT_WEBHOOK_FILE` to a restricted file holding an `https`
Slack-compatible incoming-webhook URL. It is a credential: never Git, command
lines or container environment text. The message names scopes and blockers,
never evidence. Without it the stall is still recorded and shown.

## Dispatch switch and queue clear

Administrators have two controls on `/remediation`:

- **Switch off / Switch on.** The switch is **off by default**: a new or upgraded
  receiver dispatches nothing until an administrator switches it on. Switching
  off starts nothing new; repairs in progress continue, and holds are still
  reconciled and released. The receiver host's `ENABLED` file remains the
  master switch: dispatch needs both, and the dashboard can never enable
  dispatch that the host has disabled.
- **Clear queue.** Marks every queued event `cleared` without repairing it.
  Running and held runs are untouched. An issue that is still open returns on
  the producer's next revision (a change, or the six-hourly reminder).

`POST /api/remediation/dispatch` (`{"enabled": true|false}`) and
`POST /api/remediation/clear` require an administrator session and the CSRF
token; the read-only incident bearer token cannot use them. The web process
records the request, with who and when, in `data/remediation-control.json`.
The incident sidecar, which has that file read-only, forwards three fields on
its next signed heartbeat: `seq`, `dispatch` (`on`/`off`) and `clearSeq`. The
receiver validates that closed vocabulary, applies it inside the ingest
transaction and reports what it applied in the ACK, so the board shows a
request as pending until it is acknowledged (normally within a minute; longer
while delivery is failing). The counters only move forward, so redelivery and
a replayed older envelope change nothing. Payloads still never choose commands,
targets, models, sessions or credentials.

Controls are sent only after the receiver has announced them in an ACK, so an
older receiver never sees an unknown envelope field. Deploy the receiver first;
until then the buttons are disabled.

## Remediation board

`/remediation` shows unique issues, queued event revisions, active work, waiting
reasons, blockers and recovery. `GET /api/remediation` is read-only; the existing
incident API bearer token or administrator session enables curated repair notes.
Public responses omit target identities, session keys, resource locks and notes,
and exclude non-visible networks from both cases and counts. SSE invalidation
contains only a timestamp; 15-second polling provides a reconnect fallback.

The receiver adds a bounded remediation snapshot to its authenticated delivery
ACK, which the producer already persists. No separate public receiver, new
inbound endpoint on the receiver, session enumeration or executable report
parsing is added; the administrator controls above reuse the signed heartbeat.
Missing/stale data is explicit, never an apparently healthy empty queue.

Terminal receipts include `summary`, `changes` (verified changes only),
`blocker` and `nextAction`, plus `issues` keyed by issue ID with each issue's
own `outcome` (`resolved`, `blocked`, or `no_change`) and notes. One blocked
dependency must not contaminate unrelated verified repairs in the same batch.
Historical receipts can be supplemented by a private
`presentations.json` in the receiver state directory, keyed by run ID; optional
`issues` maps override notes and response outcome by issue ID only after explicit
report/evidence review. It cannot change the stored receipt, release reservations,
or resolve monitoring incidents. Never
copy secrets or raw report bodies into it. It is not committed to the repository.

A blocked response with independently recovered symptoms is shown as
**Recovered · follow-up**, preserving its root-cause work without counting an
ongoing blocked outage. A resolved
response is only shown as verified fixed when independent monitoring also records
recovery; otherwise it awaits verification. Monitoring-only recovery is labelled
recovered, without attributing an autonomous fix. Completed investigations are
not automatically successful repairs. The only dashboard actions that change the
queue are the administrator switch and clear above; neither starts a repair.

DynamoDB scale-in controls are informational only when fresh complete collection
proves the exact alarm, action and target-tracking policy/resource association.
The collector requires read-only `application-autoscaling:DescribeScalingPolicies`
in the checked-in status IAM policy. Names alone never suppress alarms; denied,
partial, stale or mismatched evidence keeps the warning actionable. Correction
of an old generic warning records explicit classification evidence and is shown
as **Monitoring corrected**, not table recovery. No scaling policy is modified.

Each readmission has a distinct attempt ID derived from its persisted admission
time. Earlier receipts/results are retained, not overwritten by retrying the
same event IDs. Receiver updates must wait for active invocations to finish;
an idle-boundary rollout must preserve current owner authorization and locks.

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
