# Restricted VPN observation

Optional, disabled by default. Applies only to the existing Testnet/Moutai VPN
hosts; Mainnet and `mainnet-support` are excluded. Measures the OpenVPN systemd
unit, running PID and that PID's UDP/1194 socket. This is control-plane readiness,
not proof of an authenticated client tunnel.

Before enabling, independently verify each instance's SSH host key, and obtain
authorization for the bounded monitoring access grant. Preserve all existing
administration keys and effective SSH policy. Never enable general agent-key
enrollment on VPNs; authentication failure must not invoke Instance Connect.

Install `vpn-observer.py` as root:root mode 0644 at
`/usr/local/libexec/dash-status-vpn-probe.py`, below root-owned non-writable
parents. Append the existing status agent public key to the existing `ubuntu`
account with this exact restriction:

```
restrict,command="sudo -n /usr/bin/python3 /usr/local/libexec/dash-status-vpn-probe.py" ssh-ed25519 <agent-public-key> dash-status-vpn-observer
```

The fixed root-owned program ignores SSH_ORIGINAL_COMMAND and stdin. It performs
no mutations, emits no client identities, addresses, routes, configuration or
key material, and has bounded subprocess timeouts. Do not change sudo policy.

Seed the collector's instance-ID host-key pins using the independent evidence
while its process is stopped. Then set `observeVpn: true` only for the approved
network entries and start the tested collector image. Verify a fresh sample for
both targets, preservation of existing administration access, and that an
arbitrary command sent with the collector key returns only the probe result.
