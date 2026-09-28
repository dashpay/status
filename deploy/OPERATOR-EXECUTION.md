# Node operations

The status page retains the original collector, original JSON/SSE API, network tabs and compact node cards. The additions live under `/api/networks` and authenticated operation endpoints.

## Operator flow

Sign in, select Testnet or Moutai, then choose nodes and an action under **Operations**. Node details also offer **Operate this node**.

- **Upgrade:** select Core, Drive, DAPI, Tenderdash, gateway or helper; specify versioned images. Only components common to the selected nodes are offered. Preparation resolves architecture-specific immutable digests and displays the exact source/target images.
- **Recover services:** restore selected captured workloads with their existing images; never reset data or downgrade automatically.
- **Check health / Refresh inventory:** read-only fleet evidence. Mutation targets and quorum observations remain separate; the inventory is not silently reduced to healthy nodes.
- **Run reviewed operation:** queues the exact prepared artifact. Preparation is not execution. A failed finished run can resume the same plan; ambiguous dispatches must be reconciled first.

Drive explicitly includes Tenderdash's graceful stop/start dependency. Core/data/configuration/identities and unselected services remain preserved unless included in the reviewed operation. Protocol migrations are not part of an image-only upgrade.

## Credential separation

The public web container mounts only its registry, read-only reports, OAuth environment and the operation queue. It has **no AWS credentials, SSH keys, Docker socket or GitHub dispatch token**.

Set `workflow.transport: "queue"` and enable `workflow.enabled` only after the broker and Actions path are proved. Operator grants bind GitHub numeric user IDs to explicit networks/actions.

`deploy/operator-queue.py` is installed root-owned at `/usr/local/sbin/dash-status-operator-queue` on the web host. It reads bounded JSON and updates only allowlisted queue metadata. The queue is `/var/lib/dash-status/operations`.

`deploy/operator-broker.py` runs under a serialized command timer on the trusted infrastructure runner, not inside a browser request. Its private JSON configuration provides frozen CLI path, AWS profile, private S3 bucket, known-host records, exact manifests, permitted operator IDs and status-host transport. It prepares immutable plans, stores private request artifacts and dispatches `dashpay/dash-network-go/.github/workflows/console-operation.yml` on `main`. It reconciles by exact UUID; a lost dispatch response never causes a blind duplicate.

Separate `testnet-operations` and `devnet-operations` environments use repository-ID/environment-bound OIDC. Each role can read only its network's request prefix, write its result prefix and update only its DynamoDB network partition. Neither role can create, stop, replace or delete EC2 infrastructure. SSH is limited by the request's validated fleet and retained host trust, with the credential held only by the trusted runner/Actions environment.

## Recovery and verification

The shared journal serializes each network. The executor rejects changed snapshots, stale plans, competing owners and unsafe validator withdrawals. The same pinned binary/plan must recover an interrupted node before another is changed. No automated force-unlock, reset or downgrade.

Test UI selection, actor/network binding, CSRF, exact-plan replay, ambiguous dispatch and selected component preservation. Prove a read-only Actions request through the real environments before enabling execution. Do not perform a live upgrade just to test the website. Public verification still includes `scripts/check-legacy-api.mjs`, both rendered networks, sign-in routing and desktop/mobile browser checks.

The observer assesses reachable nodes even when another target is unavailable; unknown nodes remain visible. Regular masternodes receive Core health checks; validator health also includes consensus and DAPI.
