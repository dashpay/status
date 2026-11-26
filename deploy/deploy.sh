#!/bin/sh
# Build the given ref on the status host and roll the web + agent containers.
# Usage: sudo /opt/dash-status/src/deploy/deploy.sh [git-ref]   (default origin/master)
#        DEPLOY_ONLY=web sudo -E ... rolls only the web container, leaving the
#        agent (and any devnet operation it is running) untouched.
set -eu
src=/opt/dash-status/src
cd "$src"
git fetch --quiet origin
git checkout --quiet --detach "${1:-origin/master}"
rev=$(git rev-parse HEAD)
dashnet_ref=${DASHNET_REF:-$(git ls-remote https://github.com/dashpay/dash-network-go refs/heads/main | cut -f1)}
echo "building status ${rev} with dash-network-go ${dashnet_ref}"
docker build --quiet -t "dash-status:${rev}" --build-arg "RELEASE_REVISION=${rev}" --build-arg "DASHNET_REF=${dashnet_ref}" . >/dev/null
# Fail before retagging/stopping services if an engine rebuild lost rollout support.
# This exercises actual candidate agent modules and CLI, not only the web bundle.
docker run --rm --network none --read-only \
  -v "$src/scripts/check-rollout-backend.mjs:/check-rollout-backend.mjs:ro" \
  --entrypoint node "dash-status:${rev}" /check-rollout-backend.mjs
previous=$(docker image inspect dash-status:current --format '{{.Id}}' 2>/dev/null || true)
install -d -o 1000 -g 1000 -m 0750 /srv/dash-status/data
install -d -o 1000 -g 1000 -m 0700 /srv/dash-status/agent /srv/dash-status/agent/devnets
# Preserve the optional incident and devnet key sidecars on future rollouts.
# Loading the small compose env file only supplies a non-secret receiver URL;
# never source it. The key sidecar is on wherever its socket directory exists
# (README, "Devnet operator keys"). Leaving its file out would drop web's socket
# and, on a full rollout, remove the helper as an orphan.
web_services=web
if [ -d /srv/dash-status/key-access ]; then web_services="web keys"; fi
compose() {
  files="-f deploy/compose.yml"; env_file=
  if [ -f /etc/dash-status/incidents/compose.env ]; then
    install -d -o 1000 -g 1000 -m 0700 /srv/dash-status/data/incidents
    env_file="--env-file /etc/dash-status/incidents/compose.env"; files="$files -f deploy/incident-compose.yml"
  fi
  if [ -d /srv/dash-status/key-access ]; then files="$files -f deploy/devnet-keys-compose.yml"; fi
  # Wake hooks are on wherever their configuration directory exists
  # (deploy/WAKE-HOOKS.md). Leaving the file out would silently turn every
  # hook into a 404, and the senders do not retry.
  if [ -d /etc/dash-status/hooks ]; then files="$files -f deploy/wake-hooks-compose.yml"; fi
  # shellcheck disable=SC2086 # deliberate word splitting of fixed option lists
  docker compose $env_file $files "$@"
}
docker tag "dash-status:${rev}" dash-status:current
# The key helper serves one read per request and runs no operation, so a
# web-only rollout may replace it together with web.
case "${DEPLOY_ONLY:-}" in
  "") compose up -d --remove-orphans ;;
  web) compose up -d --no-deps $web_services ;;
  *) echo "DEPLOY_ONLY must be empty or web" >&2; exit 2 ;;
esac
# Web's health endpoint does not consult the key socket, so a rollout that also
# replaced the key helper is healthy only when the helper's own check passes.
healthy() {
  curl -fsS -m 3 http://127.0.0.1:3006/api/health >/dev/null 2>&1 || return 1
  if [ "$web_services" = web ]; then return 0; fi
  keys_id=$(compose ps -q keys 2>/dev/null) || return 1
  [ -n "$keys_id" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$keys_id" 2>/dev/null)" = healthy ]
}
for i in $(seq 1 30); do
  if healthy; then
    echo "$web_services healthy on ${rev}"; compose ps --format '{{.Service}} {{.Status}}'
    # Each deploy leaves a ~370 MB image: keep the running one and the two
    # newest others for rollback, so the root disk never fills (a full disk
    # fails the next build mid-download).
    keep=$(docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' dash-status | grep -v ':current$' | sort -r | head -3 | cut -d'|' -f2)
    current=$(docker image inspect dash-status:current --format '{{.Id}}')
    for image in $(docker images --format '{{.Repository}}:{{.Tag}}' dash-status | grep -v ':current$'); do
      case " $(echo $keep) " in *" $image "*) continue ;; esac
      [ "$(docker image inspect "$image" --format '{{.Id}}')" = "$current" ] || docker rmi "$image" >/dev/null 2>&1 || true
    done
    # Never globally prune: this host may retain unrelated human/build images.
    exit 0
  fi
  sleep 2
done
echo "$web_services did not become healthy; rolling back" >&2
if [ -n "$previous" ]; then
  docker tag "$previous" dash-status:current
  if [ "${DEPLOY_ONLY:-}" = web ]; then compose up -d --no-deps $web_services; else compose up -d; fi
fi
exit 1
