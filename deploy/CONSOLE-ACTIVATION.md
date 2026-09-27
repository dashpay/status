# Existing-host console activation

Run the public console and observers as separate processes. The web container
needs only the registry, read-only observation files, its operations directory
and GitHub OAuth client credentials. Do not mount deployment SSH keys, AWS
credentials, or the Docker socket into it.

1. Keep the existing legacy collector private on host loopback `:3002` during
   migration. Retain its pinned image, inventory and restricted monitoring key.
2. Run `server/collect.js` on a trusted observer with the reviewed fleet
   manifests and known-hosts files. Schedule it as a bounded command, not an AI
   turn; use a lock to prevent overlap. Publish reports atomically. Failed or
   partial runs must publish their collection status, not hide targets.
3. If managed import covers only a subset of the old inventory, configure
   `legacySnapshot` and a fixed `legacyTargets` list (`name`, `type`, `host`).
   Run `python3 deploy/legacy-observer.py OUTPUT testnet` from a one-minute
   systemd timer on the status host. This bridges only its loopback API.
   The public projection never exposes addresses or SSH errors. These extra
   nodes are **observed**, not certified by managed-doctor. Managed targets
   retain precedence; duplicates, missing nodes, stale timestamps and changed
   identities never become healthy. `expectedTargets` (`name`, `role`) keeps
   managed targets visible even if their snapshot becomes unreadable.
4. Start the console on a different loopback port with `NETWORKS_CONFIG` and
   root-only OAuth env input. Use the exact HTTPS origin and callback
   `/api/auth/callback`. Grant operators by verified numeric GitHub ID.
   Keep `workflow.enabled=false` until the Actions integration is configured.
5. Check the candidate's full target union, freshness, public redaction,
   anonymous mutation denial, OAuth redirect/cookies, and browser UI. Set
   `trustedProxies` only to the actual local proxy/gateway addresses so API
   rate limiting is per client, not shared across all visitors.
6. Save the nginx configuration, then switch the upstream and reload after
   `nginx -t`. Verify public HTTPS, both network pages and container restart.
   Rollback restores the saved nginx config and private legacy upstream;
   it does not touch any monitored node.

Actual operator login requires the human to complete GitHub authorization.
A redirect check or fixture session is not proof of their real login.
If observers stop, the public console must become stale; the frontend does not
start SSH work or manufacture a fresh observation timestamp.
