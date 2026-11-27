# Issues: how monitoring derives them and how a case ends

Monitoring keeps one issue per failing check, in `data/incidents/state.json`.
This file says how the issues are derived, how a case ends and which settings
shape them. What happens to an issue next (which ones are new, who is woken,
the repair switch) is triage: see [`TRIAGE.md`](TRIAGE.md).

Until November 2026 the issues were also delivered, as signed events, to a
repair receiver on another host (`deploy/incident-broker/`). That receiver was
retired and its code removed. Nothing in this repository sends an issue
anywhere: triage reads the file, and a worker reads triage.

## API

`GET /api/issues` is additive. It returns `schemaVersion: 1`, observation time,
`stale`, and incident lifecycle records. HTTP 503 means the issue collector is
missing/stale; it must not be interpreted as an empty healthy fleet.

Anonymous callers see only public-network issues and redacted CI/AWS summaries.
Host identities, resource IDs, error text, branches, evidence and private networks
are absent. Network membership is not account-wide infrastructure access.
Admins, or a dedicated read-only bearer token loaded through
`INCIDENT_API_TOKEN_FILE`, receive complete evidence and source coverage.
Never put tokens in query strings or reuse the OAuth/agent credential.

The complete answer still has a `delivery` object, for readers written when
events were delivered. It always reads
`{ "configured": false, "pending": 0, "quarantined": 0 }`.

Records carry stable fingerprints, revisions, first/last observation, severity,
source identity, and open/resolved state. Recovery requires positive fresh
rule-specific evidence. Missing observations, maintenance suppression and failed
collection never count as recovery. Evidence is untrusted data, not executable
instructions. Incident history is separate from operation history.

An issue's `revision` counts the times it opened, reopened, changed (another
severity, other faults, released from a hold) or ended while it was not held.
`lastEventAt` is when that last happened. A fault that only lasts is not
revised. The counters are kept after an issue leaves the list (30 days after it
ended), so the same fault seen again is not numbered from one.

`GET /api/remediation` gives the same issues as a list of cases for reading:
open faults by severity with what is wrong, held ones with the reason, and what
recovered or closed in the last 24 hours (at most 200 listed; the counts are
complete). The read-only bearer token or an administrator session adds targets
and details. Public responses omit them and leave non-visible networks out of
both cases and counts. It is not what the Remediation page shows: the page
shows triage.

## How a case ends

A case that could only end by a proof that can never arrive (a job that already
left the queue, a host that no longer exists) used to stay open for good. The
rules below end them. A resolved case records why in
`resolutionEvidence.reason`, and the case list shows two kinds of ending apart.

Three kinds of case still wait for their own proof and can stay open: an
`aws_collection_failed` for a scan that is not refreshed with every inventory
(it has no completeness clock of its own), an `aws_alarm` that moved from
`ALARM` to `INSUFFICIENT_DATA`, and every case of a CI host listed in
`remediation.excludedCiHosts`, which is left exactly as it is while excluded.

**Recovered**: monitoring saw the fault end.

| Reason | Rule |
|---|---|
| (none) | The rule's own check passed on a fresh, complete observation taken after the last fault. |
| `left_queue` | `queue_wait`: GitHub recorded the job starting on one of our runners; or the job is not among the queued jobs of a current listing that is whole for its repository (every page answered, none cut short, not cut for display, every queued job counted whatever its labels), for a run the poller still follows, in two listings in a row (one listing can miss a run that changes status between its two requests). Then it started, finished or was cancelled. A case that does not record when its run began cannot use the listing. |
| `later_attempt_passed`, `later_run_passed` | `job_failed`: a later attempt of the same run, or a later run (a higher run id) of the same workflow job on the same refs, passed after the failure. An older run that was slow to pass does not count. The refs are the head branch and the run's own ref, so pull requests from two forks with the same branch name stay apart, except under `pull_request_target`, where the ref is the base branch. Such a failure is not filed at all when the pass is already on record, and a pass still on record wins over expiry. |
| `quiet` | `host_health`: every fault is either proven healthy by its own rule or has gone unreported through `QUIET_SAMPLES` (10) consecutive valid probes of the host. A fault such as a task container that was removed has no state that could prove it healthy. On a host that stays faulty the same count drops such a fault from the evidence. |
| `verified_control_signal` | A verified scale-in control alarm (below). |

**Closed**: the case is over without a recovery. No repair is implied.

| Reason | Rule |
|---|---|
| `network_removed` | The network is no longer configured. |
| `target_removed` | The host, endpoint, disk, runner, reporter, volume, address, instance or alarm has been absent for 10 minutes (`GONE_AFTER_MS`), judged only by complete, current inventories of its kind. The 10 minutes are measured between the inventories' own times, so it takes a later inventory to end a case; the same one read again counts once. The collector and discovery cases of a network generation that a reset replaced end the same way. An inventory with an error, a failed discovery, a stale report, or a host report that lists only the first six of more disks is not evidence of absence, and does not restart the clock. A replaced instance is a new identity: its predecessor's case closes this way, never because the successor is healthy. |
| `expired` | `job_failed`: 24 hours after the failure with no later pass on record (the producer sees finished jobs for a day). `queue_wait`: not seen waiting for 24 hours while the queue was being observed. |
| `ignored_job` | `job_failed` for a job listed in `remediation.ignoredCiJobs` (see the README). |
| `superseded` | A release compatibility task whose release has a newer one in the same `major.minor` line. A release is superseded only by a newer release; a prerelease by any newer version. A superseded release is never opened as a task. |

A maintenance hold does not keep a closed case open: an operation on a network
does not preserve the cases of the hosts it replaced.

Cases resolved before the receiver was retired can carry the reason
`compatibility_report` (a release task its worker reported on). No rule gives
that reason any more.

DynamoDB scale-in controls are informational only when fresh complete collection
proves the exact alarm, action and target-tracking policy/resource association.
The collector requires read-only `application-autoscaling:DescribeScalingPolicies`
in the checked-in status IAM policy. Names alone never suppress alarms; denied,
partial, stale or mismatched evidence keeps the warning actionable. Correction
of an old generic warning records explicit classification evidence and is shown
as **Monitoring corrected**, not table recovery. No scaling policy is modified.
A verified control is in `ALARM` whenever its table is idle, so no case is filed
for it; an alarm that fails verification is filed as `aws_alarm` as before.

## The sidecar

The unprivileged `STATUS_MODE=incidents` sidecar is the **single writer** of
`data/incidents/state.json`. The rest of `/data` is read-only to it; it has no
cloud, SSH or Docker credentials and makes no network request. Every minute it
evaluates network state, CI reporters, the GitHub queue and the AWS inventory
and runtime-health results, and writes the file. Its container is healthy while
the file is less than three minutes old.

Deploy `compose.yml` together with `incident-compose.yml`. The deployment
script includes this override while the file
`/etc/dash-status/incidents/compose.env` exists; the override itself no longer
reads anything from that file. The web container gets the read-only token for
`GET /api/issues` and `GET /api/remediation` as a restricted file
(`INCIDENT_API_TOKEN_FILE`), never through Git, container environment text,
command-line arguments or build layers.

The settings of the retired receiver (`INCIDENT_WEBHOOK_URL`,
`INCIDENT_HMAC_FILE`, `INCIDENT_ALERT_WEBHOOK_FILE`) are ignored when they are
still set.

The Go deployment binary remains pinned by `DASHNET_REF`; enabling monitoring
must not implicitly upgrade a network or adopt a newer deployment recipe.

### The state file across releases

A state written by the release that still delivered events holds an `outbox`
of waiting events, possibly a `quarantined` list, the receiver's last answer in
`delivery`, and a `stall` record. The first cycle of this release drops all
four: `outbox` is written as an empty list, `delivery` as
`{ "configured": false }`, and the other two are gone. Issues, their ids,
revisions and times are untouched, and the revision counters first take in any
higher revision that only a waiting event remembered.

That earlier release can read the file again: it finds an empty `outbox`, which
it requires, and treats the rest as a state with no receiver contacted yet.
Going back to it also needs what its own `incident-compose.yml` asks for: the
three receiver variables in `compose.env` and the HMAC secret file.

## Settings

Both are in `settings.json` under `remediation` and are described in the README.

- `excludedCiHosts`: CI reporter IDs whose cases are left out of triage and of
  the case list. The observations stay; the cases are kept exactly as they are
  and neither end nor are revised while the host is excluded.
- `ignoredCiJobs`: jobs whose failure is a verdict on the change under test.
  No case is filed for them, and cases already filed end as `ignored_job`.

## Recognised change: upgrades are held, not reported as new

Expected downtime is held, never resolved and never hidden. A held issue stays
open, marked `suppressed`, and is not revised. Triage puts it in its `held`
pile, so it opens no incident and wakes nobody. When the hold ends, a fault
that is still present is revised with fresh evidence and is new to triage.

| Signal | Holds | Ends |
| --- | --- | --- |
| Dashboard operation confirmed/running | the network | terminal status, or lease expiry |
| Dashboard operation **succeeded** | the network | 20 minutes after it finished |
| dashnet journal claimed by another runner | the network | 20 minutes after release; at once if the journal records an error |
| Container recreated (started under 20 minutes ago, `RestartCount` 0, running) | that host, the network's endpoint checks, its EC2 status check | 20 minutes after the last such start |
| Host rebooted (uptime under 20 minutes) | same | 20 minutes after boot |
| Two or more hosts changing at once | the network, except a host in a crash loop | when fewer than two are changing |

`server/change-activity.js` derives the observational signals from the fresh
probe every cycle, so a manual `docker compose pull && up` of the quorum
server, or a hand-run Testnet upgrade, is recognised without a dashboard
operation. A crash loop under a restart policy increments `RestartCount` and is
not a planned change; seen in a fresh probe, it ends that host's hold at once,
even inside the settle window an earlier clean start opened. A network hold
inferred from other hosts changing does not cover that host either: its fault
and its EC2 status check stay actionable while the rest of the network stays
held. A dashboard operation or a journal claim still holds every host, since
restarts are part of the operation. Failed, cancelled and interrupted
operations get no settle window, and a journal that records an error also ends
rolling inference for that operation. Holds are bounded: a host is held at most
90 minutes per episode and a network at most three hours, so a recreate loop,
or a journal claim left behind by a crashed runner, becomes actionable. Mainnet
and external networks are never held by inference.

An abandoned operation record expires after 35 minutes without a saved progress
update, with an absolute 24-hour cap, so it cannot silence monitoring for good.

## Upstream release compatibility tasks

A network is built from three components: Dash Core, Platform and Tenderdash. A
new release of any of them can break `dash-network-go` before anyone deploys
it, so each published release becomes one issue: check `dash-network-go`
against that exact release.

| Repository | GitHub ID | Issue code |
| --- | --- | --- |
| `dashpay/platform` | 424232911 | `platform_release_compatibility` |
| `dashpay/dash` | 19352450 | `core_release_compatibility` |
| `dashpay/tenderdash` | 283521505 | `tenderdash_release_compatibility` |

GitHub delivers to the status server:

- `POST /api/webhooks/github/release` (the original
  `/api/webhooks/github/platform-release` is the same handler and keeps
  working). The signature (`X-Hub-Signature-256`) is checked over the raw body
  with the secret in the file named by `GITHUB_RELEASE_WEBHOOK_SECRET_FILE`;
  without it the endpoint answers 503. On each repository the webhook is:
  that URL, content type `application/json`, the shared secret, **Releases**
  events only.
- Only `published` is acted on, for a repository whose name and ID both match
  the table. Pre-releases count. A release promoted later, or redelivered, is
  the same release and creates nothing new.
- What is kept is repository, release ID, tag, pre-release flag and times, in
  `data/release-inbox/<repository ID>-<release ID>.json`. **The title and
  release notes are never stored or passed on**: they are upstream free text
  and must not reach an agent as instructions. The tag must look like a
  version.
- The incident sidecar turns each record into one `maintenance` issue (scope
  `dash-network-go`, severity `info`), with `mode: code-and-tests-only` and
  `liveChangesAllowed: false` in its evidence. Triage takes it as new, like
  any other issue. A release of any of the three repositories becomes a task
  at once.

A task ends when a newer release of its line supersedes it. Nothing else ends
one: the version-bound report that used to resolve a task came through the
retired receiver, and no replacement for it exists. A worker's report on the
incident (`TRIAGE.md`) is recorded there and does not end the issue.

Not covered: images with no GitHub release (nightlies, forks, patched tags).

## Coverage and remaining limits

| Domain | Current evidence | Explicit limits |
| --- | --- | --- |
| Networks | Fresh collector/discovery, per-host evaluated faults, endpoints, Core/Platform/DAPI/service checks | Existing inventory scope; mainnet remains a limited observer, not fleet ownership. No production payment/transaction sent as a synthetic check. |
| CI | Every registered reporter including never-seen hosts, measured freshness, disk/memory, unavailable runners, failed jobs and stale/long queue | Only registered reporters/known repositories; failed tests are not necessarily infrastructure faults. No human-idleness inference from runner-idle alone. |
| AWS | Inventory freshness/errors, EC2 system/instance checks and scheduled events, existing CloudWatch alarms, review-only unattached resources | Existing alarms only, not automatic alarm provisioning. No target-group health, AWS Health API, S3/application SLO checks or cost-anomaly/budget detector yet. Empty alarm sets are not proof of service health. |
| Pipeline | Freshness of the sidecar's state: `stale` in every answer, HTTP 503 from `GET /api/issues`, the container health check. Triage moves nothing on a stale state. | Nothing outside the status host notices that the host, or the sidecar, has stopped. |

`dash-network-go`'s artifact resolution proves architecture/digest availability,
not Platform Explorer compatibility. Explorer is launched by `status`'s auxiliary
service code, outside the Go core component contract. PE 2.5.3's Platform 4.1
codec cannot handle newer V2 document transitions. A replacement requires the
real failing block fixture, protocol-aware handlers, isolated replay through tip,
and immutable artifact pins; restarting/skipping a block is not a repair.

## Validation

Run the Node tests with an executable `TMPDIR` when `/tmp` is mounted noexec,
then lint and the frontend build. The tests cover private API projection,
positive-only resolution, every rule that ends a case, pagination failure, and
the first cycle over a state of the release that still delivered events.

Before a rollout preserve the image ID, compose files and settings. Verify no
active network operation before replacing the agent.
