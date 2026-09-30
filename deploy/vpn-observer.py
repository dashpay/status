#!/usr/bin/env python3
"""Fixed read-only VPN control-plane probe. No arguments, config or client data.

Install root-owned at /usr/local/libexec/dash-status-vpn-probe.py, invoked only
through the documented restricted SSH authorization. Nothing is written.
"""
import json
import re
import subprocess
import time


def command(argv):
    return subprocess.run(argv, capture_output=True, timeout=4, check=True).stdout.decode()


def collect():
    start = time.monotonic()
    try:
        unit = 'openvpn@openvpn_udp_1194.service'
        facts = dict(line.split('=', 1) for line in command(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']).splitlines() if '=' in line)
        pid = int(facts.get('MainPID', '0'))
        sockets = command(['ss', '-H', '-lunp'])
        listening = pid > 0 and any(re.search(r'\S+:1194\s', line) and ('pid=%d,' % pid) in line for line in sockets.splitlines())
        service = dict(service='openvpn', scope='control-plane', state=facts.get('ActiveState'),
                       processRunning=pid > 0 and facts.get('SubState') == 'running', udpListening=bool(listening),
                       ok=facts.get('ActiveState') == 'active' and facts.get('SubState') == 'running' and bool(listening))
    except Exception as exc:
        service = dict(service='openvpn', scope='control-plane', ok=None, reason=type(exc).__name__)
    return dict(role='vpn', containers=[], services=[service], probeMs=round((time.monotonic() - start) * 1000))


if __name__ == '__main__':
    print(json.dumps(collect(), separators=(',', ':')))
