#!/bin/bash
# Deploy the dashmon monitoring user, SSH key, monitoring script, and sudoers
# to all masternodes in the testnet inventory.
#
# Usage: bash scripts/deploy-dashmon.sh [INVENTORY_PATH] [SSH_KEY_PATH]
#
# Defaults:
#   INVENTORY_PATH = ~/code/dash-network-deploy/networks/testnet.inventory
#   SSH_KEY_PATH   = ~/.ssh/evo-app-deploy.rsa  (admin key for initial deployment)
set -euo pipefail

INVENTORY="${1:-$HOME/code/dash-network-deploy/networks/testnet.inventory}"
ADMIN_KEY="${2:-$HOME/.ssh/evo-app-deploy.rsa}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAX_PARALLEL="${MAX_PARALLEL:-10}"

DASHMON_PUBKEY="$(cat "$HOME/.ssh/dashmon-testnet.pub")"
MONITOR_SCRIPT="$SCRIPT_DIR/dashmon-check.sh"
SUDOERS_FILE="$SCRIPT_DIR/dashmon-sudoers"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"

if [[ ! -f "$INVENTORY" ]]; then
    echo "ERROR: Inventory file not found: $INVENTORY"
    exit 1
fi
if [[ ! -f "$ADMIN_KEY" ]]; then
    echo "ERROR: Admin SSH key not found: $ADMIN_KEY"
    exit 1
fi
if [[ ! -f "$MONITOR_SCRIPT" ]]; then
    echo "ERROR: Monitor script not found: $MONITOR_SCRIPT"
    exit 1
fi
if [[ ! -f "$SUDOERS_FILE" ]]; then
    echo "ERROR: Sudoers file not found: $SUDOERS_FILE"
    exit 1
fi
if [[ -z "$DASHMON_PUBKEY" ]]; then
    echo "ERROR: Public key not found at ~/.ssh/dashmon-testnet.pub"
    exit 1
fi

# Build the authorized_keys content with command= restriction
AUTHKEYS="command=\"/usr/local/bin/dashmon-check\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${DASHMON_PUBKEY}"

# Extract masternode hosts from inventory (both hp-masternode-N and masternode-N)
readarray -t NODES < <(grep -E '^(hp-)?masternode-[0-9]+\s' "$INVENTORY")

echo "=== Dashmon Deployment ==="
echo "Inventory:    $INVENTORY"
echo "Admin key:    $ADMIN_KEY"
echo "Nodes found:  ${#NODES[@]}"
echo "Parallelism:  $MAX_PARALLEL"
echo

LOGDIR=$(mktemp -d)
echo "Logs: $LOGDIR"
echo

deploy_node() {
    local line="$1"
    local logfile="$2"

    local name host
    name=$(echo "$line" | awk '{print $1}')
    host=$(echo "$line" | grep -o "ansible_host=[^ ]*" | cut -d= -f2)

    if [[ -z "$host" ]]; then
        echo "[$name] SKIP: no ansible_host" | tee "$logfile"
        return 0
    fi

    echo "[$name] Deploying to $host..." | tee "$logfile"

    # 1. Create user + .ssh dir
    ssh $SSH_OPTS -i "$ADMIN_KEY" "ubuntu@${host}" bash -s <<'REMOTE_SETUP' >> "$logfile" 2>&1
set -e
if ! id dashmon &>/dev/null; then
    sudo useradd -m -s /bin/bash -p '!' dashmon
    echo "  Created dashmon user"
else
    echo "  dashmon user already exists"
fi
sudo mkdir -p /home/dashmon/.ssh
sudo chown dashmon:dashmon /home/dashmon/.ssh
sudo chmod 700 /home/dashmon/.ssh
REMOTE_SETUP

    # 2. Deploy authorized_keys with command= restriction
    echo "$AUTHKEYS" | ssh $SSH_OPTS -i "$ADMIN_KEY" "ubuntu@${host}" \
        "sudo tee /home/dashmon/.ssh/authorized_keys > /dev/null && sudo chown dashmon:dashmon /home/dashmon/.ssh/authorized_keys && sudo chmod 600 /home/dashmon/.ssh/authorized_keys" >> "$logfile" 2>&1

    # 3. Deploy monitoring script
    cat "$MONITOR_SCRIPT" | ssh $SSH_OPTS -i "$ADMIN_KEY" "ubuntu@${host}" \
        "sudo tee /usr/local/bin/dashmon-check > /dev/null && sudo chmod 755 /usr/local/bin/dashmon-check" >> "$logfile" 2>&1

    # 4. Deploy sudoers (validate before writing)
    cat "$SUDOERS_FILE" | ssh $SSH_OPTS -i "$ADMIN_KEY" "ubuntu@${host}" \
        "cat > /tmp/dashmon-sudoers && sudo visudo -cf /tmp/dashmon-sudoers && sudo mv /tmp/dashmon-sudoers /etc/sudoers.d/dashmon && sudo chown root:root /etc/sudoers.d/dashmon && sudo chmod 440 /etc/sudoers.d/dashmon" >> "$logfile" 2>&1

    echo "[$name] OK" | tee -a "$logfile"
}

# Deploy in parallel batches
RUNNING=0
TOTAL=0
FAILED=0

for line in "${NODES[@]}"; do
    name=$(echo "$line" | awk '{print $1}')
    logfile="$LOGDIR/${name}.log"

    deploy_node "$line" "$logfile" &
    RUNNING=$((RUNNING + 1))
    TOTAL=$((TOTAL + 1))

    if [[ $RUNNING -ge $MAX_PARALLEL ]]; then
        wait -n 2>/dev/null || true
        RUNNING=$((RUNNING - 1))
    fi
done

# Wait for remaining
wait

# Summary
echo
echo "=== Deployment Complete ==="
echo "Total: $TOTAL nodes"

SUCCESS=0
for logfile in "$LOGDIR"/*.log; do
    name=$(basename "$logfile" .log)
    if grep -q "OK$" "$logfile"; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAILED=$((FAILED + 1))
        echo "FAILED: $name"
        cat "$logfile" | sed 's/^/  /'
    fi
done

echo "Success: $SUCCESS"
echo "Failed:  $FAILED"
echo "Logs:    $LOGDIR"
