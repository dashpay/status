#!/usr/bin/env python3
"""Bridge an existing loopback-only read-only monitor during console migration.

No SSH keys, cloud credentials, health certification or target discovery here.
The console's configured inventory remains authoritative. Run once from a timer.
"""
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request


def collect(output, network):
    output = Path(output)
    report = {"kind": "LegacyStatusObservation", "network": network,
              "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "failed": True, "nodes": []}
    try:
        old = json.loads(output.read_text())
        if old.get("network") == network:
            report["nodes"] = old.get("nodes", [])
    except (OSError, ValueError):
        pass
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:3002/api/nodes", timeout=15) as response:
            if response.geturl() != "http://127.0.0.1:3002/api/nodes":
                raise ValueError("Unexpected redirect")
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("Response too large")
        nodes = json.loads(raw)
        if not isinstance(nodes, list) or not nodes or len(nodes) > 1000:
            raise ValueError("Invalid response")
        report.update(nodes=nodes, failed=False)
    except Exception:
        pass  # Previous values stay visible, explicitly failed; no private diagnostics.
    fd, temp = tempfile.mkstemp(dir=output.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o640)
            json.dump(report, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, output)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return int(report["failed"])


if __name__ == "__main__":
    sys.exit(collect(sys.argv[1], sys.argv[2]))
