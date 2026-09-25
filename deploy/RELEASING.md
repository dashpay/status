# Stage a release, not an environment

There is **no staging environment**. `Stage release` builds, verifies and creates
a **draft GitHub Release**. Neither merging code, staging a draft, nor publishing
it changes any host, nginx configuration, DNS record or running network.

## Maintainer workflow

1. Merge the reviewed change to `master`.
2. Run **Actions → Stage release** on `master`, with a fresh version such as
   `v0.1.0-rc.1`. Only the upstream `dashpay/status` repository may publish drafts.
3. The workflow tests the console and real desktop/mobile browser flow, builds
   native Linux AMD64/ARM64 bundles and Docker images. It starts each unpacked
   bundle and tests legacy/console modes in non-root, read-only containers.
4. Review the resulting **draft**: all four archives, per-architecture manifests,
   `SHA256SUMS` and the exact source commit. Existing versions are never replaced.
5. Publish deliberately when approved. **Publishing is not deployment.** If a
   workflow failed after creating a partial draft, inspect/delete that unpublished
   draft before retrying the same version, or use a new version. Never modify a
   published version's artifacts.

CLI equivalent, for a maintainer with Actions access:

```sh
gh workflow run release.yml --repo dashpay/status --ref master -f version=v0.1.0-rc.1
gh run list --repo dashpay/status --workflow release.yml
```

PR CI builds and boots the same artifact format with a `v0.0.0-ci.RUN_ID` label,
but does **not** create releases or use release-write credentials. Artifacts from
a PR are test builds, not approved production releases. Native dependencies are
built on the matching architecture; no ARM64 bundle is assembled with AMD64 npm
modules. CI smoke tests use synthetic observations and no AWS/SSH/OAuth secrets.

Native bundles contain only built `dist/`, tracked runtime `server/` source, production
`node_modules`, package metadata and `release.json`. They omit `.env`, `networks/`,
SSH keys, live observations and operator state. They require **Node 22**, not an
unreviewed runtime download during an emergency. The build OS is Ubuntu 24.04.

## Production promotion boundary

The existing native Node/systemd service and its legacy difficulty-alert checkout
must be retained for rollback during the Docker migration. Do not overwrite its
untracked private `networks/` or `.env`. Docker includes Node 22; the host Node 20
installation need not change. Follow [DOCKER.md](DOCKER.md) for the approved
on-host preflight, cutover and rollback. PR merging alone is not a host migration.

Before a host rollout:

- Verify the published version's revision/checksums and pick its architecture.
- Preserve the existing release, private configuration and systemd/nginx setup.
- Install the bundle into a new versioned release directory, not the live
  checkout. Keep observation, session/operation state and secrets outside it.
- Test its loopback health and public data projection using the intended private
  configuration before changing the active release. This is an on-host promotion
  check, **not** a second staging environment.
- Switch frontend and backend together, verify public TLS/assets/API and collector
  freshness, and retain the previous release for rollback. An HTTP 200 alone does
  not prove network health. OAuth/operation grants require their own live proof.
- Roll back the active release and service configuration if verification fails;
  do not overwrite operation state or silently run concurrent collectors.

Host activation is intentionally not part of this release-staging workflow. The
old Docker Hub `:latest` publisher has been removed. The same release workflow
stages Docker-save archives with exact image IDs; it does not publish registry
tags or require a registry login on production.

## Access

Staging a release uses the repository's `GITHUB_TOKEN` with Contents write only
in the final draft job. No AWS role, SSH secret or site credential is needed.
An upstream maintainer with Actions access must dispatch the workflow. No
production credential should be put in a release, repository or chat.
