#!/bin/sh
# Roll the status host to an image that CI built and published
# (.github/workflows/publish.yml). Nothing is built here: the host has two
# cores, and a build on it has taken the site down.
# Usage: sudo /opt/dash-status/src/deploy/deploy.sh [revision]   (default origin/master)
#   DEPLOY_ONLY=web   roll only web and the key helper, leaving the agent (and
#                     any operation it is running) untouched
#   DEPLOY_IMAGE=ref  an image other than <registry>:sha-<revision>, for example
#                     one published by hand with another engine
#   DEPLOY_DESPITE_OPERATIONS=1  restart the agent although an operation is
#                     active: it is marked interrupted and can be resumed
#   DEPLOY_CHECK=1    pull and check the image, then stop: nothing is rolled
# Pass the variables through sudo with -E.
set -eu
# The checkout below replaces this file while it runs, and a shell reads its
# script as it goes. So all of it is one function, read whole before it starts.
main() {
src=/opt/dash-status/src
project=dash-status-v2
registry=${DEPLOY_REGISTRY:-ghcr.io/dashpay/status}
only=${DEPLOY_ONLY:-}
case "$only" in ""|web) ;; *) echo "DEPLOY_ONLY must be empty or web" >&2; exit 2 ;; esac
cd "$src"
# The compose files of the deployed revision are used, so the checkout moves
# with the image. Local edits would be lost, or stop the checkout half way.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$src has local changes: get them merged upstream or discard them first" >&2; exit 2
fi
git fetch --quiet origin
rev=$(git rev-parse --verify --quiet "${1:-origin/master}^{commit}") || { echo "unknown revision: ${1:-origin/master}" >&2; exit 2; }
image=${DEPLOY_IMAGE:-$registry:sha-$rev}
echo "pulling $image"
# An image that is already here will do when the registry cannot be reached:
# going back to the revision before must not depend on it.
docker pull --quiet "$image" >/dev/null || docker image inspect "$image" >/dev/null 2>&1 || {
  echo "cannot pull $image. Is the revision published (Actions, \"Publish image\")? If the package is private, this host needs: docker login ghcr.io" >&2; exit 1
}
revision_of() { docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true; }
built=$(revision_of "$image")
[ "$built" = "$rev" ] || { echo "$image was built from ${built:-an unnamed revision}, not from $rev" >&2; exit 1; }
new=$(docker image inspect "$image" --format '{{.Id}}')
previous=$(docker image inspect dash-status:current --format '{{.Id}}' 2>/dev/null || true)
# What a failed rollout goes back to: the image that is current now. When that
# already is the new one (a second run after a failed one, or a full rollout
# after a web-only one) it is the image kept from before. Its compose files are
# those of the revision it was built from, not whatever the checkout holds.
back=$previous
if [ "$back" = "$new" ]; then back=$(docker image inspect dash-status:previous --format '{{.Id}}' 2>/dev/null || true); fi
if [ "$back" = "$new" ]; then back=; fi
was=$([ -z "$back" ] || revision_of "$back")
git cat-file -e "${was:-none}^{commit}" 2>/dev/null || was=$(git rev-parse HEAD)

# The engine is part of the image. Say so when it changes: plans prepared with
# the old one keep their own copy, but everything new uses this one.
engine_new=$(docker run --rm --network none --entrypoint dashnet "$image" version 2>/dev/null | head -n 1)
agent_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=agent | head -n 1)
engine_was=$([ -z "$agent_id" ] || docker exec "$agent_id" dashnet version 2>/dev/null | head -n 1)
echo "status ${rev}, dashnet ${engine_new:-unknown}"
[ -z "$engine_was" ] || [ "$engine_was" = "$engine_new" ] || echo "NOTE: the engine changes, from $engine_was"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Fail before retagging or stopping anything if an engine rebuild lost rollout
# support. This exercises the candidate's own agent modules and CLI.
git show "$rev:scripts/check-rollout-backend.mjs" > "$tmp/check-rollout-backend.mjs"
chmod 0755 "$tmp"; chmod 0644 "$tmp/check-rollout-backend.mjs"
docker run --rm --network none --read-only \
  -v "$tmp/check-rollout-backend.mjs:/check-rollout-backend.mjs:ro" \
  --entrypoint node "$image" /check-rollout-backend.mjs

# A full rollout restarts the agent. An operation it is running is interrupted
# and has to be resumed by a person, so do not do that by accident.
if [ -z "$only" ] && [ -z "${DEPLOY_DESPITE_OPERATIONS:-}" ] && [ -d /srv/dash-status/data/ops ]; then
  active=$(docker run --rm --network none --read-only --user 1000:1000 -v /srv/dash-status/data/ops:/ops:ro --entrypoint node "$image" -e '
    const fs = require("fs"), busy = [];
    for (const f of fs.readdirSync("/ops")) {
      if (!f.endsWith(".json")) continue;
      try {
        const o = JSON.parse(fs.readFileSync("/ops/" + f, "utf8"));
        if (["queued", "preparing", "confirmed", "queued-run", "running"].includes(o.status)) busy.push(o.network + " " + String(o.id).slice(0, 8) + " " + o.status);
      } catch { /* a file being replaced */ }
    }
    console.log(busy.join(", "));')
  if [ -n "$active" ]; then
    echo "an operation is active ($active): wait for it, or roll web alone with DEPLOY_ONLY=web, or set DEPLOY_DESPITE_OPERATIONS=1" >&2; exit 1
  fi
fi

if [ -n "${DEPLOY_CHECK:-}" ]; then echo "checks passed for $image (${new}); nothing was changed"; exit 0; fi

install -d -o 1000 -g 1000 -m 0750 /srv/dash-status/data
install -d -o 1000 -g 1000 -m 0700 /srv/dash-status/agent /srv/dash-status/agent/devnets
# Preserve the optional sidecars on every rollout: each is on wherever its
# directory exists. Leaving a file out would drop what it gives web and, on a
# full rollout, remove its service as an orphan. The small compose env file
# only supplies non-secret values; never source it.
web_services=web
if [ -d /srv/dash-status/key-access ]; then web_services="web keys"; fi
compose() {
  files="-f deploy/compose.yml"; env_file=
  if [ -d /etc/dash-status/incidents ]; then
    install -d -o 1000 -g 1000 -m 0700 /srv/dash-status/data/incidents
    if [ -f /etc/dash-status/incidents/compose.env ]; then env_file="--env-file /etc/dash-status/incidents/compose.env"; fi
    files="$files -f deploy/incident-compose.yml"
  fi
  # README, "Devnet operator keys".
  if [ -d /srv/dash-status/key-access ]; then files="$files -f deploy/devnet-keys-compose.yml"; fi
  # Wake hooks (deploy/WAKE-HOOKS.md). Without the file every delivery is
  # refused, and the senders do not retry.
  if [ -d /etc/dash-status/hooks ]; then files="$files -f deploy/wake-hooks-compose.yml"; fi
  # shellcheck disable=SC2086 # deliberate word splitting of fixed option lists
  docker compose $env_file $files "$@"
}
# The key helper serves one read per request and runs no operation, so a
# web-only rollout may replace it together with web.
roll() {
  # shellcheck disable=SC2086 # deliberate word splitting of a fixed service list
  if [ "$only" = web ]; then compose up -d --no-deps --pull never $web_services
  else compose up -d --pull never --remove-orphans; fi
}
# Web answers, and every container of the stack is running and passes its own
# check: web's health endpoint does not consult the key socket or the agent.
healthy() {
  curl -fsS -m 3 http://127.0.0.1:3006/api/health >/dev/null 2>&1 || return 1
  ids=$(compose ps -q 2>/dev/null) || return 1
  [ -n "$ids" ] || return 1
  for id in $ids; do
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$id" 2>/dev/null) || return 1
    [ "$state" = "running healthy" ] || return 1
    # After a full rollout nothing may still run the image from before.
    [ -n "$only" ] || [ "$(docker inspect --format '{{.Image}}' "$id")" = "$new" ] || return 1
  done
}
# The log is a convenience: a disk too full to take a line must not stop a rollback.
record() { printf '%s %s %s image=%s previous=%s only=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$rev" "$new" "${previous:-none}" "${only:-all}" >> /var/log/dash-status-deploys.log 2>/dev/null || true; }

if [ -n "$previous" ] && [ "$previous" != "$new" ]; then docker tag "$previous" dash-status:previous; fi
# From here on a failure of any step is a failed rollout and is rolled back,
# whether a command fails or the stack does not come up healthy.
ok=
if git checkout --quiet --detach "$rev" && docker tag "$image" dash-status:current && roll; then
  # A container reports healthy after its first check, half a minute in.
  for _ in $(seq 1 75); do
    if healthy; then ok=1; break; fi
    sleep 2
  done
fi
if [ -n "$ok" ]; then
  echo "healthy on ${rev}"; compose ps --format '{{.Service}} {{.Status}}' || true
  record deployed
  # The registry has every published revision, so two images are kept here: the
  # running one and the one before it, for the rollback below and for a
  # registry that cannot be reached. Each is about 400 MB, and a full disk
  # fails the next pull. Every other tag of this console is removed, and an
  # image goes with its last tag. Images are told apart by id, not by name: one
  # that is kept keeps all its names, so none is left behind without a name.
  # Other people's images are not touched, nor is one a container still uses.
  kept=$(docker image inspect dash-status:previous --format '{{.Id}}' 2>/dev/null || true)
  used=" $(docker ps -aq | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null | tr '\n' ' ')"
  for row in $(docker images --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}' dash-status; docker images --no-trunc --format '{{.ID}}|{{.Repository}}:{{.Tag}}' "$registry"); do
    id=${row%%|*}; ref=${row#*|}
    case "$ref" in *":<none>") continue ;; esac
    if [ "$id" = "$new" ] || [ "$id" = "$kept" ]; then continue; fi
    case "$used" in *" $id "*) continue ;; esac
    docker rmi "$ref" >/dev/null 2>&1 || true
  done
  exit 0
fi
set +e
echo "the rollout to ${rev} failed or is not healthy; going back" >&2
compose ps --format '{{.Service}} {{.Status}}' >&2
record failed
if [ -n "$back" ]; then
  docker tag "$back" dash-status:current
  git checkout --quiet --detach "$was"
  if roll; then echo "back on ${was}; check that it is healthy" >&2
  else echo "GOING BACK FAILED TOO: dash-status:current is the image from before, the checkout is at $(git rev-parse --short HEAD); bring the stack up by hand" >&2; fi
else
  echo "there is no image from before to go back to" >&2
fi
exit 1
}
main "$@"
