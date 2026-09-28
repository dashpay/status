#!/bin/sh
# Build the given ref on the status host and roll the web + agent containers.
# Usage: sudo /opt/dash-status/src/deploy/deploy.sh [git-ref]   (default origin/master)
set -eu
src=/opt/dash-status/src
cd "$src"
git fetch --quiet origin
git checkout --quiet --detach "${1:-origin/master}"
rev=$(git rev-parse HEAD)
dashnet_ref=${DASHNET_REF:-$(git ls-remote https://github.com/dashpay/dash-network-go refs/heads/main | cut -f1)}
echo "building status ${rev} with dash-network-go ${dashnet_ref}"
docker build --quiet -t "dash-status:${rev}" --build-arg "RELEASE_REVISION=${rev}" --build-arg "DASHNET_REF=${dashnet_ref}" . >/dev/null
previous=$(docker image inspect dash-status:current --format '{{.Id}}' 2>/dev/null || true)
install -d -o 1000 -g 1000 -m 0750 /srv/dash-status/data
install -d -o 1000 -g 1000 -m 0700 /srv/dash-status/agent /srv/dash-status/agent/devnets
docker tag "dash-status:${rev}" dash-status:current
docker compose -f deploy/compose.yml up -d --remove-orphans
for i in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:3006/api/health >/dev/null 2>&1; then
    echo "web healthy on ${rev}"; docker compose -f deploy/compose.yml ps --format '{{.Service}} {{.Status}}'
    # Each deploy leaves a ~370 MB image: keep the running one and the two
    # newest others for rollback, so the root disk never fills (a full disk
    # fails the next build mid-download).
    keep=$(docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' dash-status | grep -v ':current$' | sort -r | head -3 | cut -d'|' -f2)
    current=$(docker image inspect dash-status:current --format '{{.Id}}')
    for image in $(docker images --format '{{.Repository}}:{{.Tag}}' dash-status | grep -v ':current$'); do
      case " $(echo $keep) " in *" $image "*) continue ;; esac
      [ "$(docker image inspect "$image" --format '{{.Id}}')" = "$current" ] || docker rmi "$image" >/dev/null 2>&1 || true
    done
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done
echo "web did not become healthy; rolling back" >&2
if [ -n "$previous" ]; then docker tag "$previous" dash-status:current; docker compose -f deploy/compose.yml up -d; fi
exit 1
