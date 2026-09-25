# Docker release and live-host migration

`Stage release` builds native Linux AMD64/ARM64 Docker images with a pinned Node
22 base. The artifacts are Docker-save archives (`*-docker-ARCH.tar.gz`) with
checksums and JSON manifests. They are real container images, not application
bundles or registry-published tags. `configDigest` pins the exact configuration
bytes, including the uncompressed layer digests. Docker classic and containerd
stores can expose different image IDs for this same content. Load only the host's
architecture; never substitute a mutable tag for verification.

```sh
sha256sum --check SHA256SUMS --ignore-missing
docker load --input dash-status-VERSION-docker-arm64.tar.gz
python3 scripts/image-archive.py verify dash-status-VERSION-docker-arm64.tar.gz dash-status-VERSION-docker-arm64.json
```

Use the verifier from the exact release source revision (Python 3.11+ and Docker
CLI). It checks the archive checksum, architecture and release labels, then
re-exports the immutable loaded image to prove its configuration digest matches.
Temporary disk space for one uncompressed image is required. Only after all checks
pass does it print the host's immutable image ID. Pin that returned
`STATUS_IMAGE=sha256:...` in `/etc/dash-status/compose.env`; do not use `latest`.
`buildEngineImageId` is diagnostic, not a portable deployment identity.
The verifier also accepts the earlier `v0.1.0-rc.2` manifest's `imageId` field,
but only if that value equals the archive and loaded configuration digests.
No registry credential or host Node upgrade is required. Keep the verified image
archive for disaster recovery.

## Host layout

- `/etc/dash-status/compose.yml`: the reviewed [Compose file](compose.yml).
- `/etc/dash-status/compose.env`: image ID and loopback port (default `3002`).
- `/etc/dash-status/runtime.env`: runtime variables, root-owned `0600`.
- `/etc/dash-status/config/`: runtime configuration/inventory and the existing
  collector credential if using legacy mode; mounted read-only. Private keys
  stay `0600`, owned by the application UID `1000`. Never bake these into images.
- `/var/lib/dash-status/`: persistent operations/state, owned by UID `1000`,
  mode `0700`; not part of a release or rollback.

For the existing testnet collector, preserve all current env values but remap
`INVENTORY_PATH=/etc/dash-status/testnet.inventory` and
`SSH_KEY_PATH=/etc/dash-status/dashmon-testnet`. Do not add `NETWORKS_CONFIG`:
that would activate a different application mode. The legacy collector uses the
same restricted dashmon identity and the same inventory; no monitored-node
configuration or access is changed by this migration.

For a separately approved console activation, set
`NETWORKS_CONFIG=/etc/dash-status/networks.json`, mount observations read-only,
and keep operations under `/var/lib/dash-status`. Do not silently enable Actions,
OAuth grants, private networks or a second independent collector during a
container migration.

## Conversion of the existing `.250` host

1. Record native service state, source revision, TLS response, node count and
   per-node freshness/health. Back up systemd/nginx configuration and private
   inventory/env under a root-only directory on the host. Keep the original
   checkout, host Node and SSH key unchanged.
2. Install the distro Docker Engine and Compose v2. Enable Docker on boot. Do not
   add the web user to the Docker group or mount the Docker socket.
3. Prepare the above paths and the verified image. Start on loopback `3002`:
   `docker compose --env-file /etc/dash-status/compose.env -f /etc/dash-status/compose.yml up -d`.
   During the short verification window the restricted read-only poller may run
   alongside the old one. Verify full inventory, data freshness, assets and
   Docker health before switching traffic; process health alone is not enough.
4. Update nginx's frontend **and** API locations together to proxy to `3002`,
   retaining TLS/certbot settings and SSE buffering/timeout configuration. Run
   `nginx -t` before reload. Stop and disable the original `status-dashboard`
   service after verified cutover so two collectors do not remain active.
5. Verify public HTTPS, asset loading, API data, SSE, fresh polling and restart
   recovery. Docker binds to loopback only. The Compose restart policy and
   enabled Docker service own startup; the old native unit stays available but
   disabled. Do not reboot the host merely to test the conversion.

## Rollback

Retain the root-only native backup until a later deliberate retirement. For a
failed conversion, start the original native service, check its loopback `3001`
health, restore the saved nginx configuration, validate/reload nginx, and only
then stop the Docker service. Re-enable `status-dashboard.service`. The original
private inventory and credential paths were never edited. Do not erase container
operation state during rollback.

For a later Docker-only rollback, change `STATUS_IMAGE` to the previous verified
image ID and run Compose again. Keep configuration and operation state external
and unchanged. Never remove volumes or run an unscoped `docker system prune`.
