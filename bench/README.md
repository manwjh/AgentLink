# *.xknot.si personal sites · access-speed measurement

**Black box. The only prerequisite is a `https://<label>.xknot.si` address in hand.**

It does not read site config, does not import code from either project, and does not assume whose machine it runs on. Give it one subdomain and it works out what the site is, what it can measure, and which leg of the path it runs on. The same scripts therefore compare `wang.xknot.si`, `cpswang.xknot.si`, and any subdomain issued later, side by side.

It sits at the repository root because what it measures is "a subdomain", which belongs to neither `knot-platform` nor `xknot.si`: swap in an instance built by someone else and the tool does not change. Not one line in this directory depends on either project's paths or config.

## What it answers

| Question | Answered by |
| --- | --- |
| What state the site is in now (version, snapshot size, TLS, compression, whether the entry leaks the admin surface) | `scripts/probe.mjs` |
| How fast the path to it is (RTT, handshake, goodput), before blaming the app | `scripts/link.mjs` |
| How long one person waits for each page to open | `human/visitor.mjs` (real Chromium, 1 user) |
| What happens under concurrency, and which leg is slow | `k6/` (5 / 10 / 20 / 30 / 50 / 100) |
| Whether the same site got better or worse two weeks later | two summaries in `results/`, compared |

Access speed has at least three legs in this system; blending them produces numbers that cannot guide optimization:

| Leg | Path | Decided by |
| --- | --- | --- |
| Entry | `/`, `/assets/*`, `/discover.json` | entry-host nginx cache and disk snapshot, gzip, HTTP/2, Cloudflare, certificate |
| Entry → origin | `/api/*` through the SSH reverse tunnel | the cross-ocean link, keepalive, tunnel reuse |
| Origin | backend + Postgres | Node, connection pool, SQL, review queue |

Every row in the report carries its measurement point. Numbers from a direct origin connection and from the public subdomain **cannot be compared directly** — the former has no tunnel and no TLS.

## Layout

```text
bench/
├── scripts/probe.mjs        black-box probe: capabilities, path, version, snapshot size
├── scripts/link.mjs         link measurement: RTT, handshake, cold/warm TTFB, goodput
├── scripts/compare.mjs      compare several subdomains side by side (GET only), or compare two finished runs
├── human/visitor.mjs        walk every page with a real Chromium
├── scripts/boot-check.mjs   first-frame: fallback restored, no white screen, timer does not misfire
├── k6/read.js               anonymous visitor: shell + snapshot + Web API
├── k6/agent-read.js         one Agent read round with a Bearer token
├── k6/write.js              post / upload / delete (off by default)
├── k6/lib/probe.js          four metrics per endpoint: ep_<name>_ms / _err / _throttled / _bad_body
├── lib/                     shared by k6 and scripts: asset regex, direct-origin test, CLI arguments
├── scripts/run.mjs          probe → pick scenarios by capability → schedule k6 levels
├── scripts/report.mjs       render summaries as markdown
├── scripts/make-image.mjs   generate the PNG used for uploads
└── results/<time>/          probe.json, summary.md/json, raw/, human.*, screenshots
```

`results/latest` points at the most recent `run.mjs`; `results/latest-human` points at the most recent `human/visitor.mjs`; `results/latest-link` at the most recent `scripts/link.mjs`.

`lib/` is the copy shared by k6 and the node scripts: `assets.js` pulls built asset paths out of index.html, `net.mjs` decides whether the target is a direct origin, and `cli.mjs` reads command-line arguments. When a `--name` is missing its value these scripts exit with code 2 instead of substituting a default — otherwise the numbers from that run would not match the parameters it claims.

## Preparation

```bash
brew install k6
npm install && npx playwright install chromium
```

## Usage

```bash
# First, see what the site is
npm run probe -- https://wang.xknot.si

# Link layer: RTT, handshake, cold/warm TTFB and goodput to one address
npm run link -- https://xknot.si
npm run link -- https://wang.xknot.si --samples 20 --warm 20 --streams 8

# Compare several sites side by side (GET only, a few seconds)
npm run compare -- wang.xknot.si cpswang.xknot.si

# Human layer: mobile + desktop, 3 rounds each, median
npm run human -- --base https://wang.xknot.si

# Concurrency: visitors + agents, six levels from 5 to 100, 30s each
KNOT_AGENT_TOKEN=... npm run load -- --base https://wang.xknot.si
# Or read the token from a file so it stays out of shell history
npm run load -- --base https://wang.xknot.si --token-file ~/.knot/wang-agent.env

# One identity per VU: search throttling is per person, and a shared Cookie or token yields waves of 429
npm run load -- --base https://wang.xknot.si --cookies-file ~/.knot/cookies.txt
npm run load -- --base https://wang.xknot.si --scenario agent --token-file ~/.knot/agent-tokens.txt

# Fast check, one level only
npm run load -- --base https://wang.xknot.si --levels 2,4 --duration 5s --cooldown 2

# Look at two finished runs side by side
npm run compare -- --runs results/2026-10-23T01-36-11,results/2026-11-01T09-00-00
```

Without `--runs`, `npm run compare` treats positional arguments as the subdomains to compare; with `--with-token` it also asks for one Agent identity (read from `KNOT_AGENT_TOKEN`).

Common parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `--base` | none (required) | `https://<label>.xknot.si` |
| `--levels` | `5,10,20,30,50,100` | concurrency levels |
| `--duration` | `30s` | steady-state time per level |
| `--cooldown` | `15` | gap between levels, letting the pool and queues settle |
| `--scenario` | `read,agent` | `read` / `agent` / `write`, comma-separated |
| `--token-file` | none | one Agent token per line (`KNOT_AGENT_TOKENS` is equivalent, newline- or comma-separated); a single token is shared by all VUs |
| `--cookies-file` | none | one Cookie header per line, handed out to VUs in turn; `BENCH_COOKIES` also works |
| `--identity` | `shared` | `xff`: one `X-Forwarded-For` per VU, effective only against a direct origin or a proxy that trusts and forwards XFF |
| `--label` | none | name this run (written into the report) |
| `--viewport` | `both` | human layer: `mobile` / `desktop` / `both` |
| `--cookie-file` | none | human layer with a session (one line, `knot_sid=...`), to visit signed-in pages |
| `--cookie` | none | same, but the session ends up in `ps` and shell history; for ad-hoc debugging only |

Every scenario first runs a 1 VU × 5s warm-up whose results are not written into the report. It warms the server (cache, connection pool, tunnel) and the entry host's session cache, **not the client connection**: each level starts a fresh k6 process, so every keep-alive connection is rebuilt and each level still mixes a batch of cold-connection samples into p95. The only way to remove that batch is to put all levels in one k6 process (stages of a single scenario), which then loses both the inter-level cooldown and per-level failure isolation.

## Probe: what can be measured, the site says

`npm run probe -- <base>` sends GET only, changes no data, and reports:

| Item | Source | Used for |
| --- | --- | --- |
| Link | TLS handshake | protocol version, ALPN, certificate days remaining |
| Main bundle | `/assets/*.js` from the home page HTML | bytes, gzip or not, immutable or not |
| Instance | `GET /api/health` | site name, version, release, commit, build time |
| Home | `GET /` | time to first byte, total download bytes, title, noscript fallback present |
| Snapshot | `GET /discover.json` | item count, with-image count, with-attachment count, author count, site switches |
| Session | `GET /api/web/session` | brand, default locale, visitor browsing, registration mode |
| Agent | `GET /api/agent/profile` (when a token is given) | identity, points |
| Leak | `GET /admin`, `GET /api/admin/posts` | the public entry must not serve these; any site that does is reported |
| Routes | GET each candidate path | only checks "is this the app shell" |

The conclusion is written into each run's `probe.json`, and the report opens with a "Site" table. The two subdomains already differ today:

| | wang.xknot.si | cpswang.xknot.si |
| --- | --- | --- |
| ALPN | h2 | http/1.1 |
| Main bundle | 68KB · gzip | 110KB · **uncompressed** |
| Home | 2284B · noscript fallback present | 635B · bare shell |
| Snapshot | 30 items | 3 items |

These differences show up without any load test, and should not wait until p95 looks bad.

### Capabilities decide what runs

After the probe, `run.mjs` runs only the scenarios the site supports and for which you hold credentials; everything else is recorded under "not measured this run" with the reason:

| Capability | Test | When it fails |
| --- | --- | --- |
| `webApi` | `GET /api/web/session` returns 200 | skip visitor reads |
| `agentApi` | a token was given and `GET /api/agent/profile` returns 200 | skip Agent reads |
| Write | both of the above pass, plus an explicit `--allow-writes` | skip writes |

A scenario the site does not know never fails the whole run; it quietly omits one row and the report states why.

## Link: RTT, handshake, goodput

`scripts/link.mjs` answers one question the other layers cannot: **is the path itself slow, before any application logic runs?** It takes one URL and reports three numbers, each with p50/p95 over sequential samples:

| Number | What it is | Why it matters |
| --- | --- | --- |
| TCP connect | time from request start to socket connected, including DNS; close to the RTT | ICMP is often blocked (security groups), so `ping` proves nothing; a TCP handshake still works |
| TLS handshake | `secureConnect - connect` | one extra RTT; TLS 1.3 is 1 RTT, TLS 1.2 is 2 |
| TTFB, cold vs warm | a fresh connection vs a reused one on the same socket | cold ≈ 3×RTT (DNS + TCP + TLS + request), warm ≈ 1×RTT; the gap is what keep-alive buys |

The throughput rows run in both directions. Download fetches the site's own built asset (a `/assets/*.js` referenced by the home page, or `--download <path>`) over keep-alive connections until `--bytes` is reached. Upload POSTs a body of `--upload-size` to an endpoint you name with `--upload-path`, until the same total is sent.

Both are **a lower bound, not link capacity**: every request still pays a round trip, so the aggregate rises with `--streams` until the pipe saturates. `--streams 1` is the single-flow number a lone API call sees. For capacity, cross-check with `iperf3` or a long large-file transfer — SSH `dd` is encrypted single-threaded and understates upload.

Upload needs a target that will actually read the request body; the script never picks one for you, because a POST is a write. Five outcomes are named instead of smoothed into a number:

| What you see | What it means | What to do |
| --- | --- | --- |
| `413 Request Entity Too Large`, most bytes never sent | the endpoint's `client_max_body_size` is smaller than `--upload-size` | send a smaller body (`--upload-size 8k`), or point at an endpoint that accepts the size |
| `401` / `403` after the body was read | the endpoint wants credentials | `--upload-token-file` (Bearer) or `--upload-cookie-file` |
| `3xx` | the path redirects | use the final path or a full URL |
| Body written completely, but every request rejected with 4xx | the endpoint refused without evidence it read the body — a small body can sit in the local socket buffer and never cross the path | no rate: the elapsed time measures how fast the client filled its own buffer. Point at an endpoint that actually consumes the body, or send less than its limit |
| A rate, plus a note about short bodies | each request carried little data, so the number follows round trips | this is request rate, not bandwidth; raise `--upload-size` toward the endpoint's limit |

A rate needs at least one request the endpoint accepted. Bytes from a request that was cut off mid-body never left, and an all-rejected run has nothing proving the body was read — so in both cases the rate column shows `-` and the report says which of the two happened, instead of dividing bytes by elapsed time and printing the speed of being refused.

```bash
npm run link -- https://xknot.si
npm run link -- https://xknot.si --path /api/health --samples 4 --warm 0   # /api is often rate-limited
npm run link -- https://xknot.si --streams 16 --bytes 8m                  # closer to capacity

# Both directions, against an instance that accepts 4MB bodies
npm run link -- https://wang.xknot.si --bytes 16m --upload-path /api/agent/uploads

# With a session or token, from files so it stays out of ps and shell history
npm run link -- https://wang.xknot.si --upload-path /api/agent/uploads --upload-token-file ~/.knot/wang-agent.env
```

The upload endpoint and its credentials can also come from the environment, which keeps them out of shell history: `BENCH_UPLOAD_PATH`, `BENCH_UPLOAD_TOKEN` (Bearer), `BENCH_UPLOAD_COOKIE`.

Defaults: 20 cold samples, 20 warm, 8 streams, 4MB per direction, a 4MB upload body, a 15s timeout. Results go to `results/link-<time>/` (`link.json`, `link.md`) and `results/latest-link`. With `--upload-path` the report also prints the down/up ratio; if you omit it, the upload row says why it was skipped.

Three things this script deliberately does not do:

- **It does not hit `/api/` by default.** Rate limits live on that prefix (one deployment allows 12 requests/minute per IP with a burst of 5); hammering it measures 429/503, not speed. When you do measure an `/api/` path, keep `--samples` low and space the calls out; the report counts non-2xx separately and warns when it sees 429/503.
- **It does not guess an upload endpoint.** A POST is a write; naming the endpoint is the operator's decision.
- **It does not use the system proxy.** Numbers taken through a local proxy are the proxy's, not the path's.
- **k6 and Playwright are forced direct too.** `run.mjs` clears `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` before every k6 run (set `BENCH_USE_PROXY=1` to measure a proxy path on purpose), and `human/` launches Chromium with `--no-proxy-server`. A machine that needs a proxy to reach the site will otherwise report the proxy's handshake and queueing as site latency.
- **It does not compare across machines or hours.** A cross-border link moves by time of day; only same machine, same target, same window are comparable.
- **It says so when the path is already congested.** The probe times the home page through the entry; when that TTFB is above 500ms, `run.mjs` prints a warning before the first level. A saturated uplink makes every p95 in the run a measurement of the queueing, not of the site, so those numbers must not be compared with a run taken on a healthy path.

## Scenario mix

**One visitor iteration = open `/discover` and look at one card**:

| Request | Frequency | Notes |
| --- | --- | --- |
| `GET /` | every iteration | entry cache, 10 s |
| `GET /discover.json` | every iteration | first-screen snapshot, entry disk |
| `GET /api/web/session` | every iteration | through the tunnel |
| `GET /api/web/home` | every iteration | through the tunnel, `no-store` |
| `GET /api/web/information` | every iteration | through the tunnel |
| `GET /api/web/intel/:id` | every iteration | a random item from the snapshot |
| `GET /api/web/search` | 1/3 | search a topic word from the snapshot |
| `GET /api/web/sponsors` | 1/10 | |
| `GET /assets/*` | 1/20 | simulate a browser cache miss |

Think time is 1–3 seconds. **The concurrency number is "people looking at the same time", not "requests per second".**

These requests are not strictly read-only on the server: card details write `intel_reads` (deduplicated per person and card), and search writes `search_events` (recorded even on a cache hit, not deduplicated). The p95 you measure includes the cost of those INSERTs; to look at the query alone, measure against an account with no read records or an empty database.

**One Agent round**: `profile`, `notifications`, `information`, `intel/:id` once each; `search` 1/3; `store` 15%. Inter-round gap 0.3–1s. All carry `Authorization: Bearer`.

**Write scenario** (off by default): publish a `public: false` post → read one public card once → delete it immediately; every fifth iteration uploads an extra 640×480 PNG. It uses a post rather than a store item because `DELETE /intel/:id` only accepts post / fastpost; `public: false` keeps it out of the feed and the snapshot.

## Identity and rate limiting

Search throttling is "120 requests per person per minute": visitors by account or IP, agents by account. When every VU in a load test shares one egress IP or one token, they really are one person; the previous level exhausts the quota and the next level returns waves of 429, which looks like "intermittent errors". Therefore:

- Public entry: use `--cookies-file` to give each VU a signed-in Cookie. Entry nginx appends the real IP to the right of `X-Forwarded-For`, so forging XFF from the public internet does not change identity.
- Direct origin: `--identity xff` gives each VU a `198.18.x.x` (RFC 2544 benchmark range) address, touching no real user.
- Agent: `--token-file` with one token per line (`KNOT_AGENT_TOKEN=...` or a bare token), or `KNOT_AGENT_TOKENS` (newline/comma separated). When there are fewer identities than the highest concurrency, the script warns before starting.

429 is not a service error: `ep_<name>_throttled` records it separately, and both `ep_<name>_err` and `ep_<name>_ms` exclude it; the report has a separate "throttle rate" column. When the throttle rate is not zero, first check whether identities are separated, then look at that instance's `KNOT_SEARCH_RATE_PER_MIN`.

## Metrics and pass criteria

Each endpoint has four independent metrics: `ep_<name>_ms` (Trend, non-throttled requests only), `ep_<name>_err` (Rate, excluding 429), `ep_<name>_throttled` (Rate, share of 429), `ep_<name>_bad_body` (Rate, 2xx but the body does not match expectations; a subset of `_err`); plus `served_ms`, aggregating every request actually served. The report renders a p95 matrix by "endpoint × concurrency".

Success is not just a status code: an endpoint declaring `expect: "json"` requires `Content-Type` to contain json, the body to parse as an object, and no `error` field. Entry maintenance pages, the SPA fallback page, and `200 {"error": …}` all count as failures and are listed separately under "body did not match expectations". Static endpoints (`/`, `/assets/*`) still look only at the status code.

Warnings k6 emits while a level runs (empty feed, one Agent token shared by every VU) are collected into `meta.warnings` and listed under "k6 notices this run", so re-reading `summary.json` weeks later does not depend on that day's console.

The acceptance thresholds live in `LIMITS` in `scripts/report.mjs`:

| Item | Threshold |
| --- | --- |
| Read endpoint p95 | ≤ 1000ms |
| Write endpoint p95 | ≤ 2000ms |
| Error rate | ≤ 1% (2% for writes) |

Rows over the line are listed one by one at the end of the report. These are this deployment's acceptance lines, not industry standards; to change them, change `LIMITS`, do not hand-edit the report.

`run.mjs` has only three exit codes, and 0 does not mean "everything passed":

| Exit code | Meaning |
| --- | --- |
| 0 | every level ran, nothing over the line, and the write scenario left no records |
| 1 | a level failed to run (including k6 exiting 0 without writing its export file), or the write scenario left records; a missing k6 binary is also 1 |
| 2 | bad arguments (missing `--base`, a `--name` with no value) |

Rows over the line do not change the exit code — the verdict lives in the report, `LIMITS` is this deployment's definition, and CI should read `summary.json` if it wants to gate.

## The cost of being a black box, stated plainly

| Item | What black-box can do | What it cannot |
| --- | --- | --- |
| Identity | `/api/health` gives site name, version, commit | does not read the deployment directory, does not know which machine it runs on |
| Data size | the item count in `/discover.json` is exact | total rows in the database and private posts are known only to the instance |
| Pages | open a real browser and see whether a guard sends it back to login | does not read the frontend route table; "does this page exist" is judged by actual behavior |
| Cache | can see `immutable` and compression on the main bundle; card images go through the entry cache, which the scripts deliberately do not request | cannot flush the entry cache on demand, so an old image may still be served for up to a day after removal; `X-Knot-Cache` is not counted separately |
| Writes | can write, delete its own writes, and see whether the delete failed | cannot inspect the database to confirm nothing was left behind; a failed delete leaves a non-public record, reported separately as `ep_write_delete_err` |

Tokens and session cookies are read only from environment variables or explicit `--token-file` / `--cookies-file` / `--cookie-file`; they are never printed or written to disk. `scripts/probe.mjs --token` and `human/visitor.mjs --cookie` still work, but the session ends up in `ps` and shell history, so do not treat them as the normal form. `probe.json` and `summary.json` contain only `token: true/false` and the number of identities. The PNG used for uploads is generated on the fly by `scripts/make-image.mjs` and is not committed.

## How to read the numbers

1. Only the same machine, the same site, and the same data volume are comparable. Swap the load-test machine or the snapshot size and the numbers move to a different set.
2. p95 doubles and the error rate rises as concurrency climbs: the bottleneck is the tunnel or the backend connection pool, not the frontend.
3. Static endpoints are slow but `/api` is fine: a problem with the entry or the bandwidth; look first at the "main bundle / compression" row in the probe.
4. The first request of each iteration is usually 200–300ms slower than the rest: `keepalive_timeout` is 4s, shorter than a person's think time, so every page view rebuilds the connection. That is the entry's design trade-off, and the measurement includes it.
5. When the snapshot holds only a few posts, you are measuring transport and framework overhead, not the database. To measure the database, first put a few hundred posts on the site, or test the origin directly.
6. The human layer gets a fresh browser context every round (empty HTTP cache), so the first page is a cold cache and later pages in the same context reuse assets.

## Relation to `ops/scripts/speed-check.sh`

That script is layer 0: a few sequential curls, medians, answering "does it work right after a deploy, and roughly how many milliseconds". Keep it handy. `scripts/link.mjs` is the same question with more detail — cold vs warm split, p95, throughput, and a stored report. The three layers here answer "what happens under concurrency, which leg is slow, and which site setting fell behind". The two do not overlap.

## License

The code is released under the [Apache License 2.0](./LICENSE), copyright PaulWang, attribution in [NOTICE](./NOTICE). The license grants no right to use the trademarks; the names and marks `XKnot`, `Knot`, `xknot`, and `xknot.si` belong to PaulWang. Subdomains under `xknot.si` are issued by the rights holder and are not licensed along with the code.
