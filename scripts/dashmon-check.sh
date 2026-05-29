#!/bin/bash
# /usr/local/bin/dashmon-check
# Read-only monitoring script for the dash testnet status dashboard.
# Deployed to all masternodes. This is the forced command for the dashmon SSH key.
# Detects HP vs regular masternode by checking for dashmate configuration.
#
# HP node path AVOIDS `dashmate status`. That command performs port-reachability
# probes against mnowatch.org as part of its "Core Service Status" / "Platform
# Status" fields, and the dashboard polls every few seconds across every
# masternode -- that pattern abuses an external third-party service.
#
# Instead we pull equivalent fields from on-node sources only:
#   * Core RPC via `dashmate core cli` (forwards to dash-cli inside the
#     core container -- same data as the regular masternode path)
#   * Tenderdash local RPC on 127.0.0.1:36657 for platform-side info
#     (height, peers, network, sync state, proposer rotation)
#
# A future improvement is to call rs-dapi (Platform.getStatus /
# Core.getBlockchainStatus / Core.getMasternodeStatus) via the local
# JSON-RPC / gRPC endpoints. JSON-RPC currently only maps Platform.getStatus,
# and the gRPC Core methods need either a gateway TLS round-trip or grpcurl,
# neither of which we want to require on every node. The Tenderdash + Core RPC
# combination already gives us the data we need without extra deps, so we
# defer the rs-dapi switch until that JSON-RPC mapping is broader.
set -euo pipefail

if [[ -f /home/dashmate/.dashmate/config.json ]]; then
    # HP masternode: Core RPC + Tenderdash. No mnowatch.org calls.
    #
    # Fields surfaced on HP cards/details vs the old `dashmate status` source:
    #   coreVersion              -> getnetworkinfo.subversion (this script)
    #   coreSize                 -> getblockchaininfo.size_on_disk
    #   posePenalty / lastPaid*  -> masternode status dmnState
    # Intentionally NOT surfaced (would require scanning the full MN list +
    # per-block headers, which is too expensive at our poll cadence):
    #   lastPaidTime, paymentQueuePosition, nextPaymentTime.
    echo "===BLOCKCHAIN==="
    sudo -u dashmate dashmate core cli getblockchaininfo 2>&1 || true
    echo "===MASTERNODE==="
    sudo -u dashmate dashmate core cli masternode status 2>&1 || true
    echo "===NETWORKINFO==="
    sudo -u dashmate dashmate core cli getnetworkinfo 2>&1 || true
    echo "===TENDERDASH==="
    # One python invocation pulls proposer rotation, sync state, peers, and
    # node info from Tenderdash's local RPC. Best-effort: partial results are
    # still emitted if a single endpoint fails.
    python3 -c '
import json, urllib.request
# Tenderdash HTTP RPC returns JSON-RPC envelopes
# ({"jsonrpc":"2.0","id":-1,"result":{...}} or {"error":{...}}).
# Unwrap result here so downstream code can address fields directly.
def fetch(path):
    data = json.loads(urllib.request.urlopen(
        "http://127.0.0.1:36657" + path, timeout=5
    ).read())
    if isinstance(data, dict) and data.get("error") is not None:
        raise RuntimeError(json.dumps(data["error"]))
    if isinstance(data, dict) and "result" in data:
        return data["result"]
    return data
out = {}
try:
    block = fetch("/block")
    header = block["block"]["header"]
    cur_prop = header["proposer_pro_tx_hash"]
    out["currentProposer"] = cur_prop
    out["platformHeight"] = int(header["height"])
except Exception as e:
    out["proposerError"] = str(e)
try:
    if "currentProposer" in out:
        validators = fetch("/validators?per_page=100")
        sorted_ptx = sorted(v["pro_tx_hash"] for v in validators["validators"])
        idx = sorted_ptx.index(out["currentProposer"])
        out["nextProposer"] = sorted_ptx[(idx + 1) % len(sorted_ptx)]
except Exception as e:
    out["nextProposerError"] = str(e)
try:
    status = fetch("/status")
    ni = status.get("node_info", {}) or {}
    si = status.get("sync_info", {}) or {}
    if ni.get("network"): out["platformNetwork"] = ni.get("network")
    if "catching_up" in si: out["platformCatchingUp"] = bool(si["catching_up"])
    if "latest_block_height" in si and "platformHeight" not in out:
        try: out["platformHeight"] = int(si["latest_block_height"])
        except Exception: pass
except Exception as e:
    out["statusError"] = str(e)
try:
    net_info = fetch("/net_info")
    out["platformPeers"] = int(net_info.get("n_peers", 0))
except Exception as e:
    out["netInfoError"] = str(e)
print(json.dumps(out))
' 2>/dev/null || echo '{"error":"tenderdash-unavailable"}'
    echo "===SYSMETRICS==="
else
    # Regular masternode: dash-cli as the ubuntu user.
    echo "===BLOCKCHAIN==="
    sudo -u ubuntu dash-cli getblockchaininfo 2>&1 || true
    echo "===MASTERNODE==="
    sudo -u ubuntu dash-cli masternode status 2>&1 || true
    echo "===SYSMETRICS==="
fi

# System metrics (no privileges needed)
head -1 /proc/loadavg
nproc
free -m | grep Mem
df -h / | tail -1
