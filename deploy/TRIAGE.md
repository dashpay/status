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

What is new is grouped into **incidents**: one per network, CI host, repository queue, failing job or AWS resource. An incident opens once, however many faults join it. It is revised only when it becomes worse than it has been. It ends when monitoring has seen none of its faults for an hour, or at once when it is filed as known.

A **known entry** is a reason and a list of patterns. A pattern names issues by domain, scope, target and code (`*` for any run of characters), optionally by CI job name, and has a severity ceiling: the same fault grown worse than it was when filed is new again. An entry lapses when nothing has matched it for a day, unless it is kept ("keep after it recovers") or has an end date.

Nothing moves while monitoring is stale: no incident opens, ends or wakes anybody on an old list.

## The worker

A new incident, or one that got worse, wakes the triage worker through a wake hook with source `console` (`deploy/WAKE-HOOKS.md`). Its name is `TRIAGE_HOOK`, by default `remediation`:

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
| `GET /api/remediation/triage` | anyone | Administrators and the worker get incidents with evidence, known entries with reasons, and reports. Everyone else gets counts by network and area. |
| `PUT /api/remediation/incidents/<id>` | worker, administrator | What was done: `{ "state": "working" \| "fixed" \| "needs_you" \| "noted", "summary", "slack": { "channel", "ts" }, "thread", "revision" }`. Slack and thread are kept once given. |
| `POST /api/remediation/known` | worker, administrator | File as known: `{ "incident": "<id>", "reason", "wide", "standing", "until" }`, or `{ "match": [patterns], "covers": [patterns], "reason" }`. |
| `PATCH /api/remediation/known/<id>` | worker, administrator | "This follows from that": `{ "incident": "<id>" }` or `{ "covers": [patterns] }` puts more under an entry as expected. |
| `DELETE /api/remediation/known/<id>` | administrator | Remove an entry. The worker can file a thing away and cannot bring one back. |

`fixing` in the answer is the administrator's switch on the Remediation page (`data/remediation-control.json`, off unless switched on). Off means the worker looks and announces and repairs nothing. The console does not enforce that: the worker reads it and keeps to it.

"Fixed" is the worker's claim. Only monitoring ends an incident.

## Files

All under the data directory, written by the web process only.

| File | What |
|---|---|
| `remediation-known.json` | The known entries. |
| `remediation-triage.json` | Open incidents with the worker's reports, those ended in the last week, and which ones the worker has been woken for. |
