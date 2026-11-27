# Triage

Monitoring (`server/incidents.js`, the `incidents` sidecar) keeps one issue per failing check. Triage (`server/triage.js`, in the web process) sorts the open ones by whether anybody needs to hear about them, and wakes a worker for what is new.

## Piles

| Pile | What is in it |
|---|---|
| Known | Somebody filed it with a reason. It is being lived with. |
| Expected | It follows from something known: a known entry covers it. |
| Held | A recognised operation is in progress on its network or host. |
| Review | Informational. Nothing to repair. |
| New | None of the above. |

An issue of a CI host excluded from remediation (`settings.remediation.excludedCiHosts`) is in no pile.

What is new is grouped into **incidents**: one per network, CI host, repository queue, failing job or AWS resource. An incident opens once, however many faults join it. Its **revision** goes up when it becomes worse than it has been, or when something else fails in the same place (another host or check of that network; the same job failing or waiting again is the same thing). It ends when monitoring has seen none of its faults for an hour, or at once when what was new in it is filed as known. At most 500 incidents are open at once; what would open more is counted (`unopened`) until there is room.

A **known entry** is a reason and a list of patterns. A pattern names issues by domain, scope, target and code (`*` for any run of characters), optionally by CI job name, and has a severity ceiling: the same fault grown worse than it was when filed is new again. A pattern must name a scope or a target at least in part, or one code written out, so a whole domain cannot be filed away in one line. An entry lapses when nothing has matched it for a day, unless it is kept ("keep after it recovers"). An end date removes it on that date, kept or not.

**A fault counts once it has lasted.** A new issue becomes part of an incident only when monitoring has seen it for three minutes without a break (`TRIAGE_SETTLE_SECONDS`, default 180: three looks), and a higher severity counts only once it has held that long. A probe that fails for one sample, or a host that reads critical for one, opens nothing, revises nothing and wakes nobody. Such issues are counted apart (`counts.settling`) and listed nowhere. A fault that belongs to an open incident and comes back needs no second wait.

Nothing moves while monitoring is stale: no incident opens, ends or wakes anybody on an old list.

## The worker

A new incident, or a new revision of one, wakes the triage worker through a wake hook with source `console` (`deploy/WAKE-HOOKS.md`). The worker is woken once for each revision, across restarts of the console. Its name is `TRIAGE_HOOK`, by default `remediation`:

```json
"remediation": { "source": "console", "listeners": { "<listener id>": "<sha256 of its token>" } }
```

A console hook has no secret file and takes nothing from outside. With no such hook configured nothing is woken, and the worker finds the incident on its own timer.

The worker reads and writes with a token of its own, kept on the status host as a digest in `TRIAGE_WORKERS_FILE`:

```json
{ "schemaVersion": 1, "workers": { "infraclaw": "<sha256 of its token, hex>" } }
```

The token is 32 to 128 characters of `A-Z a-z 0-9 _ -` and must not begin with `dst_` (that prefix is a console API token). It reaches the four routes below and nothing else on the console.

| Route | Who | What |
|---|---|---|
| `GET /api/remediation/triage` | anyone | Administrators and the worker get incidents with evidence, known entries with reasons, and reports, from a fresh look. Everyone else gets counts by network and area, from the last look and kept for a few seconds: such a request sorts nothing, writes nothing and wakes nobody. |
| `PUT /api/remediation/incidents/<id>` | worker, administrator | What was done: `{ "state": "working" \| "fixed" \| "needs_you" \| "noted", "summary", "slack": { "channel", "ts" }, "thread", "revision" }`. `revision` is the one the incident was read at. Slack and thread are kept once given. The answer is `{ "ledger", "revision" }`: when the incident's `revision` is above the ledger's, it moved on while the worker was busy, and the worker looks again. |
| `POST /api/remediation/known` | worker, administrator | File as known: `{ "incident": "<id>", "reason", "wide", "standing", "until" }`, or `{ "match": [patterns], "covers": [patterns], "reason" }`. |
| `PATCH /api/remediation/known/<id>` | worker, administrator | "This follows from that": `{ "incident": "<id>" }` or `{ "covers": [patterns] }` puts more under an entry as expected. `reason` and `standing` can be changed by an administrator, and by the worker on entries it filed. The entry keeps who filed it and records who changed it last. |
| `DELETE /api/remediation/known/<id>` | administrator | Remove an entry. The worker can file a thing away and cannot bring one back. |

`fixing` in the answer is the administrator's switch on the Remediation page (`data/remediation-control.json`, off unless switched on). Off means the worker looks and announces and repairs nothing. The console does not enforce that: the worker reads it and keeps to it.

"Fixed" is the worker's claim. Only monitoring ends an incident.

## Files

All under the data directory, written by the web process only.

| File | What |
|---|---|
| `remediation-known.json` | The known entries. |
| `remediation-triage.json` | Open incidents with the worker's reports, those ended in the last week, and which ones the worker has been woken for. |
