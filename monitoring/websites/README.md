# Website performance and page checks

The public `/websites` tab and `/api/websites` expose synthetic HTTPS homepage
checks of **dash.dev** and **dash.org**, collected on the existing AWS status host
(us-west-2). No browser visitor, AI job, or API request triggers a probe.
The same collector checks that the pages of dash.org are still what they should
be ("Page checks" below); a page that is not becomes a fault in monitoring.

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

## Page checks

The same run then reads a list of pages of **dash.org** (`SHAPE_PAGES` in
`probe.py`: the homepage, downloads, DashPay, buy, masternodes, developers,
Evolution, community, blog and the forum) and says for each whether it still is
the page it should be. dash.dev is not checked. One request per page and run,
after the timing probes so that they are not in the measurements.

A page is in order when all of this holds:

| Check | Reported as |
|---|---|
| It answers, with HTTP 2xx, inside the site | `unreachable`, `status` |
| The answer is HTML | `not_html` |
| It ends at its own address. dash.org answers a page that does not exist with a redirect to the homepage, so HTTP 200 alone proves nothing | `moved` |
| At least 1,000 characters of visible text | `short` |
| Its title and a phrase or two of its own text are there (not the menu, which every page carries) | `title`, `phrase` |
| No defacement marker (`hacked by`, `defaced`, `pwned`, `h4ck…`). Not searched on the forum, where visitors write the text | `defaced` |
| Downloads page only: every link to an installer or archive is plain HTTPS below `github.com/dashpay/`, and there is at least one | `download_link`, `no_downloads` |
| Its words are at least 60% those of its last good reading. Two different pages of the site share up to 50% | `changed` |

- **The baseline moves by itself.** Every reading that is in order becomes what
  the next one is compared with, so edits never add up to a change. A page that
  changed by more than 40% at once is reported for 24 hours and then taken as
  it is, unless something else is wrong with it too. Nobody resets anything.
- **Nothing the page says is reported.** A problem is a code from the list
  above with a detail in our words: the phrase that is missing, a number, the
  host a download link points to. A defaced page cannot put its text in front
  of whoever reads the fault, person or agent.
- **One failed reading is not a fault.** The collector counts failures in a
  row (`failures`, `since`); monitoring files a fault from the second, and
  triage counts it three minutes later (`deploy/INCIDENTS.md`, `deploy/TRIAGE.md`).
  So a page that is wrong is somebody's news within about a quarter of an hour,
  and a single timeout is nobody's.
- The latest result of each page is `shape` in `report.json`. The baselines and
  counters are in `shape-state.json` beside it (mode 0600: word lists of public
  pages, read by the collector only). Deleting that file starts every baseline
  again from the next good reading.
- `/api/websites` gives everyone the pages, whether each is in order and the
  codes; the details are in the fault, for administrators.
- **When a page's text is changed on purpose** and a phrase is gone, the fault
  says which. Change the phrase in `SHAPE_PAGES` (a pull request; the collector
  follows the deployed revision, below). Until then the fault can be filed as
  known on the Remediation page.

## Status-host installation

Requires Python 3, curl with `%{json}` and systemd. Keep this separate from the
public web process and privileged network agents. The shipped service runs as
the existing status-data owner (`ubuntu`) with no capabilities, read-only system/home protection, resource limits,
and only the report directory writable. Use CPU weight, not a hard CPU quota:
quota throttling can inflate TLS and first-byte timings. Web reads it using its existing `/data`
mount; no cloud credentials or additional container privileges are needed.

1. Make `/opt/dash-status/websites` a symlink to `monitoring/websites` in the
   checkout that `deploy/deploy.sh` keeps at the deployed revision
   (`/opt/dash-status/src`), so the collector and the console that reads its
   report are always of one revision. Create `/srv/dash-status/data/websites`, owner `ubuntu:ubuntu`, explicitly chmod 0755 (do not rely on umask).
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
node --test server/websites.test.js server/website-issues.test.js server/web.test.js server/ci.test.js server/ci-queue.test.js
npm run build
```

Browser QA must cover actual graph windows, metric selection, hover/keyboard/touch
inspection, mobile layout, navigation and live measurements. Use test fixtures only
in local tests, never publish artificial history to the production collector.
