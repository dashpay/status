# Website performance

The public `/websites` tab and `/api/websites` expose synthetic HTTPS homepage
checks of **dash.dev** and **dash.org**, collected on the existing AWS status host
(us-west-2). No browser visitor, AI job, or API request triggers a probe.

## Measurements and history

- The systemd timer runs once every five minutes; one request per site plus up to
  four HTTPS redirects restricted to the site's apex or www hostname. No auth,
  cookies, persisted sessions, or third-party asset requests. IPv4 and normal TLS
  validation; curl negotiates HTTP/2 and compression when supported.
- Fresh connections each hop. TTFB = completed redirect duration plus final-hop
  first byte. Total response = all hop durations through final HTML download.
  DNS/TCP/TLS/wait/download phases are summed over hops; server wait includes RTT.
  Tiny request/protocol setup time may not appear in the phase totals.
- Seven days of timestamped samples persist atomically in
  `/srv/dash-status/data/websites/report.json`, bounded to 2,200 samples per site.
  Errors are samples, never zero-latency successes. Missed intervals are not
  backfilled. Graph lines break at failed checks or gaps over ten minutes.
- Median/p95 are nearest-rank over successful checks in the last 24 hours. Check
  success is successes/attempts, **not uptime**. Missing intervals do not count as
  successful or failed requests. Fewer samples mean less representative stats.
- Data older than twelve minutes (or over one minute in the future) is marked
  stale. The last report remains available across failed collections/restarts.
- Recommendations derive from measured timing, redirect, compression, cache and
  HTML tag evidence. These are not browser render metrics or Core Web Vitals.

## Status-host installation

Requires Python 3, curl with `%{json}` and systemd. Keep this separate from the
public web process and privileged network agents. The shipped service runs as
the existing status-data owner (`ubuntu`) with no capabilities, read-only system/home protection, resource limits,
and only the report directory writable. Use CPU weight, not a hard CPU quota:
quota throttling can inflate TLS and first-byte timings. Web reads it using its existing `/data`
mount; no cloud credentials or additional container privileges are needed.

1. Install this directory at `/opt/dash-status/websites` (or symlink an immutable
   release). Create `/srv/dash-status/data/websites`, owner `ubuntu:ubuntu`, explicitly chmod 0755 (do not rely on umask).
2. Install the service/timer files in `/etc/systemd/system/`, verify them, then
   `systemctl daemon-reload` and `systemctl start dash-status-websites.service`.
3. Verify successful real reports and the public API, then enable/start the timer.
4. Check `systemctl status dash-status-websites.timer` and subsequent sample times.
   The report retains no raw HTML, cookies, credentials or server IP addresses.

Before editing a running collector, stop its timer and wait for the oneshot to
finish. Stage/validate immutable replacement source before repointing the link.
For rollback disable the new timer and restore the prior web image, retaining
collected history. Do not restore unrelated network/CI state.

## Focused validation

```
python3 -m unittest discover -s monitoring/websites -p 'test_*.py'
node --test server/websites.test.js server/web.test.js server/ci.test.js server/ci-queue.test.js
npm run build
```

Browser QA must cover actual graph windows, metric selection, hover/keyboard/touch
inspection, mobile layout, navigation and live measurements. Use test fixtures only
in local tests, never publish artificial history to the production collector.
