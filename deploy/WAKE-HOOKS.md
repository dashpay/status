# Wake hooks

The status host is public. The machines that do our automated work are not: they sit
behind a home connection or inside a walled-off VM, so GitHub cannot deliver a webhook
to them, and they have been polling instead. A wake hook lets the status console take
the delivery and wake the machine that wants it.

```
GitHub ── POST /api/hooks/<name> ──▶ status console ◀── GET /api/hooks/<name>/wait ── listener
          (signed with the hook's secret)              (held open from the listener's side)
```

Nothing has to be opened towards the listener. It makes an ordinary outbound HTTPS
request and the console answers it when a delivery arrives.

**A wake is a signal, not a message.** The console stores nothing of a delivery and
passes nothing on. The listener learns that something happened on that hook and then
looks for itself, with its own access. So a forged, replayed or needless delivery costs
one extra look and nothing else, and what a pull request or a release says never
travels through this path. The console reads a delivery to check its signature. It
parses one only for a hook that has `match` rules, only once the sender is
authenticated, and only to decide whether this delivery wakes anyone.

This is separate from the incident pipeline (`INCIDENTS.md`): nothing here is queued,
retried, dispatched or acted on by the console.

## The two requests

`POST /api/hooks/<name>`: a delivery from the hook's sender. Which sender is the
hook's `source`:

| `source` | How the sender proves itself | Event name | Delivery id |
|---|---|---|---|
| `github` | `X-Hub-Signature-256`, the HMAC-SHA256 of the body with the hook's secret | `X-GitHub-Event` (`pull_request`) | `X-GitHub-Delivery` |
| `xenforo` | `XF-Webhook-Secret`, the hook's secret itself | `XF-Content-Type` and `XF-Webhook-Event`, joined by a dot (`user.insert`) | `xf-` and `XF-Webhook-Id`, which numbers the webhook, not the delivery |

A third source, `console`, has no sender outside: the console itself wakes the hook,
for work that follows what the console sees (triage of new faults, `deploy/TRIAGE.md`).
Such a hook has listeners and nothing else: no secret file, no `events`, no `match`.
A delivery posted to its name is answered like one to a name that is not a hook.

XenForo (2.3 and later, Admin CP → Setup → Webhooks) cannot sign: it sends the secret
in a header with every delivery. That secret is as private as the TLS connection and
the forum's database, and a delivery cannot be told from a replay. It is enough for a
wake and would not be for anything that carried an instruction.

| Answer | When |
|---|---|
| `202 {"accepted":true,"seq":N}` | authentic, and the listeners were woken |
| `202 {"accepted":true,"ignored":true}` | authentic, but not one of the hook's `events`, or none of its `match` rules matched |
| `200 {"accepted":true,"ping":true}` | GitHub's test delivery when the webhook is created |
| `400` | authentic, but the event or delivery headers are missing or malformed, or the hook has `match` rules and the body is not JSON |
| `401` | missing or wrong signature or secret; also a name that is not a hook, and a hook whose secret file is missing |
| `413` | larger than 5 MB (nginx on the status host already stops at 1 MB) |

XenForo retries a delivery that was not answered 2xx; GitHub does not. Deliveries have
a rate limit of their own, 6,000 a minute for each sending address, apart from the
console's general API limit: a hook may take a repository's whole `workflow_job`
stream, and a delivery answered 429 is gone.

Hook names are not public: a name that does not exist is read, hashed and answered
exactly like a wrong signature. A hook that is misconfigured therefore shows as `401`
in GitHub's "Recent Deliveries", and the reason is in the web log
(`hook-secret-missing`, `hook-signature-rejected`, at most once a minute each).

The signature covers the body only. `X-GitHub-Event` is an unsigned header: whoever
holds one signed delivery can replay it and name any event. That costs a look, which is
all a wake is; do not build anything on the event name.

`GET /api/hooks/<name>/wait?after=N` with `Authorization: Bearer <listener token>`:
answered at once with `{"hook","listener","seq","at","event"}` when `seq` differs from
`N` (or `after` is left out); otherwise held for up to 50 seconds and then answered
with the count as it is. A listener loops on it and acts whenever `seq` is not the one
it had. Compare for "different", not "greater": the count starts again if its file is
lost.

| Answer | When |
|---|---|
| `200` | the count, at once or after the hold |
| `401` | wrong token, or a name that is not a hook (one answer for both). Also every listener's answer while `hooks.json` does not parse: retry slowly, do not give up |
| `429` | this listener already holds four requests on the hook |

`GET /api/hooks` is what the **Webhooks** page shows. An account with access (and an
API token for every network) gets each hook by name: its sender, events and rules, its
listeners and whether each is connected, the last wake, and what arrived since the
console started (woke, ignored, refused). Everyone else gets counts: how many hooks
there are and how many are listening, deliveries that woke or were ignored, and two
times to the minute. Nothing in that names a hook, a listener or an event, and nothing
in it can be moved by a caller who holds no secret. Refused deliveries and the `warn`
level are left out of it for that reason: a refusal is counted only for a name that
exists, so a count of them would let anyone find names by sending a bad signature to a
guess and looking again. No secret and no token digest, for anyone. `invalid` is true
when `hooks.json` is there and does not parse.

A hook's level says whether a delivery would do its job right now:

| Level | When |
|---|---|
| `ok` | the secret file is usable and every listener asked within the last two minutes (a listener asks at least every 50 seconds) |
| `info` | the console started less than two minutes ago and the listener has not asked yet |
| `warn` | the newest delivery was refused (wrong signature or secret), within the last day |
| `down` | no usable secret file, no listener configured, or a listener that has not asked for two minutes: a delivery does not wake it, and its work runs on its own timer |

The counts of deliveries are kept in memory and start again with the console; the
count of wakes and the last wake are on disk.

## A listener must keep a timer of its own

GitHub does not retry a delivery that failed, a delivery over the size limit wakes
nobody, and the console may be restarting when one arrives. A wake makes the work
prompt; it does not make it certain. Keep a slow timer beside it (every 15 minutes, not
every 2).

## Adding a hook

On the status host, in `/etc/dash-status/hooks/` (root:ubuntu, mode 0750; files 0440):

1. `hooks.json`:

   ```json
   { "schemaVersion": 1, "hooks": {
       "agent-directory": {
         "source": "github",
         "events": ["pull_request", "push"],
         "listeners": { "worker-vm": "<sha256 of the listener's token, hex>" } } } }
   ```

   `source` is `github` or `xenforo`. `events` is optional; without it every event
   wakes. `match` is optional too, for a sender whose events are mostly not ours:

   ```json
   "platform-release-jobs": {
     "source": "github",
     "events": ["workflow_job"],
     "match": [ { "path": "workflow_job.labels", "pattern": "^platform-release-[0-9]+-[0-9]+-(npm|kotlin)$" } ],
     "listeners": { "ubuntu-server-2": "<sha256>" } }
   ```

   A rule names one field of the JSON payload by a dotted path (up to six names) and
   a regular expression. It matches when the field is a string or a number that the
   expression matches, or a list with such an element; one matching rule is enough,
   and a rule may carry its own `event` (one of the hook's) to apply to that event
   only. A repository sends a `workflow_job` delivery for every job of every run;
   with the rule above only the release jobs wake the listener, and the rest are
   answered `ignored`.

   What a rule is tested against was written by outsiders, so: a value longer than
   256 characters is no match (it is not cut down to one), only the first 200
   elements of a list are looked at, a path does not go through a list, and `true`
   and `false` never match. Write patterns that cannot backtrack badly: anchored,
   no quantifier inside a quantified group (`^(\w+\s?)+$` is the kind to avoid).

   A hook for the forum:

   ```json
   "forum-queue": {
     "source": "xenforo",
     "events": ["user.insert", "post.insert", "thread.insert"],
     "listeners": { "ubuntu-server-2": "<sha256>" } }
   ```

   Names are lower-case letters, digits and dashes. A key the console does not know
   is refused, in a hook and in a rule: a misspelt `match` would be a filter that
   silently does not apply. The file is read again when it changes: no restart.
   Replace it by rename (write a new file beside it, then `mv`): a file caught
   half-written does not parse, and while it does not, no hook exists.
2. `<name>.secret`: the sender's secret, 16 to 200 printable ASCII characters (it has
   to travel in a header unchanged). A file outside that opens nothing, and the web
   log says `hook-secret-missing`.
3. A listener token is 32 to 128 characters of `A-Z a-z 0-9 _ -`. Only its SHA-256 goes
   into `hooks.json`, so the status host can check a token and cannot use one:
   `printf %s "$token" | sha256sum`.
4. At the sender. GitHub, in the repository's (or organisation's) webhook settings:
   payload URL `https://status.testnet.networks.dash.org/api/hooks/<name>`, content
   type `application/json`, the secret, and the events the listener cares about.
   XenForo, in Admin CP → Setup → Webhooks: the same URL, content type JSON, SSL
   verification on, the secret, and per content type the events to send.

The first hook also needs the directory to exist before a deploy: `deploy.sh` includes
`wake-hooks-compose.yml` wherever `/etc/dash-status/hooks` exists. A hand-run
`docker compose` must name that file, or every delivery and every listener gets 401.

## Looking at it

- The **Webhooks** page of the console (`/webhooks`), signed in: one row for each hook.
  A red dot beside a listener means it is not connected; the line under the table says
  what is wrong in words.
- `docker logs dash-status-v2-web-1 | grep hook-` shows every wake (`hook-wake`, with
  the event it was `on`, the sender's delivery id, the count and how many listeners
  were waiting; a delivery that was `ignored` is not logged),
  a configuration that does not parse (`hooks-config-invalid`), a count that could
  not be saved (`hook-state-not-saved`), and a configured hook that refused a delivery
  (`hook-secret-missing`, `hook-signature-rejected`).
- The count per hook is in `data/hooks/<name>.json`.
- GitHub keeps each delivery and the answer it got under the webhook's "Recent
  Deliveries".
