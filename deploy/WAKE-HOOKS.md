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

**A wake is a signal, not a message.** The console reads a delivery only to check its
signature. It does not parse it, store it or pass it on. The listener learns that
something happened on that hook and then looks for itself, with its own access. So a
forged, replayed or needless delivery costs one extra look and nothing else, and what a
pull request or a release says never travels through this path.

This is separate from the incident pipeline (`INCIDENTS.md`): nothing here is queued,
retried, dispatched or acted on by the console.

## The two requests

`POST /api/hooks/<name>`: a GitHub webhook delivery. It needs a valid
`X-Hub-Signature-256` for the hook's secret, `X-GitHub-Event` and `X-GitHub-Delivery`.

| Answer | When |
|---|---|
| `202 {"accepted":true,"seq":N}` | signed, and the listeners were woken |
| `202 {"accepted":true,"ignored":true}` | signed, but the hook lists its events and this is not one of them |
| `200 {"accepted":true,"ping":true}` | GitHub's test delivery when the webhook is created |
| `401` | missing or wrong signature |
| `404` | no such hook, or its secret file is missing |
| `413` | larger than 5 MB (nginx on the status host already stops at 1 MB) |

`GET /api/hooks/<name>/wait?after=N` with `Authorization: Bearer <listener token>`:
answered at once with `{"hook","listener","seq","at","event"}` when `seq` differs from
`N` (or `after` is left out); otherwise held for up to 50 seconds and then answered
with the count as it is. A listener loops on it and acts whenever `seq` is not the one
it had. Compare for "different", not "greater": the count starts again if its file is
lost. A wrong token and an unknown hook are the same `401`.

`GET /api/hooks` (admins): the hooks, their listeners' ids, how many are waiting, and
when each last woke.

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

   `events` is optional; without it every event wakes. Names are lower-case letters,
   digits and dashes. The file is read again when it changes: no restart.
2. `<name>.secret`: the secret GitHub signs with, 16 characters or more.
3. A listener token is 32 to 128 characters of `A-Z a-z 0-9 _ -`. Only its SHA-256 goes
   into `hooks.json`, so the status host can check a token and cannot use one:
   `printf %s "$token" | sha256sum`.
4. In the repository's (or organisation's) webhook settings: payload URL
   `https://status.testnet.networks.dash.org/api/hooks/<name>`, content type
   `application/json`, the secret, and the events the listener cares about.

The first hook also needs the directory to exist before a deploy: `deploy.sh` includes
`wake-hooks-compose.yml` wherever `/etc/dash-status/hooks` exists. A hand-run
`docker compose` must name that file, or every hook answers 404.

## Looking at it

- `docker logs dash-status-v2-web-1 | grep hook-` shows every wake (`hook-wake`, with
  the event name, GitHub's delivery id, the count and how many listeners were waiting),
  a configuration that does not parse (`hooks-config-invalid`) and a count that could
  not be saved (`hook-state-not-saved`).
- The count per hook is in `data/hooks/<name>.json`.
- GitHub keeps each delivery and the answer it got under the webhook's "Recent
  Deliveries".
