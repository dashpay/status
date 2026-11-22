# Mainnet service monitoring

`mainnet-services.py` runs on `ubuntu-server-2` every 60 seconds
(`dash-mainnet-services.timer`) and writes its results to
`/var/lib/dash-mainnet-services/samples.json`. The mainnet observer on the same
host forwards that file to the console as `serviceChecks`, and the console shows
the rows under Mainnet. The probes only read. Nothing here changes mainnet.

The observer deployed on the host has the forwarding code;
`deploy/mainnet-observer.py` in this repository does not have it yet.

## What is checked

| Id | Check |
|---|---|
| `quorums` | The quorum API's hash set equals the `llmq_100_67` list of the host's own mainnet Core |
| `insight` | Insight is synced, within 6 blocks of Core, serves a block and a transaction, and agrees with Core on the block hash |
| `seed-1`, `seed-2`, `seed-3` | Trusted TLS with more than 36 hours left, then a `@dashevo/dapi-client` bootstrap through that seed alone |
| `bootstrap` | A `@dashevo/dapi-client` bootstrap with the client's default seeds |
| `quorums-tls`, `insight-tls` | Trusted TLS with more than 36 hours left |
| `observer` | The console's mainnet report is younger than 4 minutes and Core answered |
| `core`, `platform`, `chainlocks` | The stall and ChainLock-age signals in that report |

A check that has no reference to compare against reports `reference-unavailable`,
never a success. A check that throws reports `probe-failed`.

## What it needs on the host

- Python 3, standard library only.
- Docker, and the mainnet Core container `dashmate_dbb2a15d_mainnet-core-1` for
  the reference chain and quorum list (`docker exec … dash-cli`).
- The npm tree from `mainnet-services-runtime/` in
  `/opt/dash-mainnet-services/runtime`. Each bootstrap check runs it in its own
  `docker run --rm` container from a Node image pinned by digest: read-only,
  non-root, no capabilities, with the tree mounted read-only.

Until 2026-11-22 the bootstrap checks ran with `docker exec` inside the OpenClaw
gateway container. When that container was stopped, the four checks reported
`probe-failed` every minute without testing anything. A container per probe
leaves nothing that can be stopped.

## Install

```sh
install -d /opt/dash-mainnet-services/runtime
install -m 0644 deploy/mainnet-services-runtime/package.json \
  deploy/mainnet-services-runtime/package-lock.json /opt/dash-mainnet-services/runtime/
docker run --rm -v /opt/dash-mainnet-services/runtime:/work -w /work \
  "$(sed -n "s/^NODE_IMAGE = '\(.*\)'$/\1/p" deploy/mainnet-services.py)" \
  npm ci --omit=dev --ignore-scripts
install -m 0644 deploy/mainnet-services.py deploy/test_mainnet_services.py /opt/dash-mainnet-services/
(cd /opt/dash-mainnet-services && python3 -m unittest test_mainnet_services.py)
install -m 0644 deploy/dash-mainnet-services.service deploy/dash-mainnet-services.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dash-mainnet-services.timer
```

To replace the script: stop `dash-mainnet-services.timer`, wait until
`dash-mainnet-services.service` is inactive, copy `mainnet-services.py` and
`test_mainnet_services.py` into `/opt/dash-mainnet-services/`, run the tests
there (`python3 -m unittest test_mainnet_services.py`), then start the timer.

## Paging

The script also holds a notifier (`mainnet-services.py notify`). It pages Slack
`C0AMAE6E82F` once per issue after three consecutive failed samples and keeps
its receipts in `alerts.json`. It does not run: its timer,
`dash-mainnet-alerts.timer`, is disabled on the host since 2026-10-31, and its
unit files are not in this repository. It sends through the OpenClaw gateway
container, so it could not deliver while that container is stopped.

## Limits

- The probes and the observer share one host. If the host is lost, the only
  signal is the console marking the mainnet report stale.
- The seed checks cover the three managed seed hostnames. `bootstrap` covers
  what a default client sees, which includes seeds this team does not run.
- Disk and memory of the quorum and Insight hosts are not checked here.
