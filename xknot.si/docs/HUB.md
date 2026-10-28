# Hub Implementation and Operations

Contract in [FEDERATION.md](FEDERATION.md), system map in [ARCHITECTURE.md](ARCHITECTURE.md), terms in [NAMING.md](NAMING.md), locale rules in [I18N.md](I18N.md). This document covers the hub's composition, generation flow, deployment, and acceptance.

## 1. Composition

| Part | Form | Notes |
|------|------|------|
| Portal | Vue static site | Vue 3 + Vite, trilingual entries, reads `/data/hub.json` at runtime |
| API | Node resident process | `POST /api/applications` receives join applications, `/api/subdomains/check` answers whether a label can be issued, `/api/locations` gives each instance's observed region, `/api/probes` gives each instance's current probe result, `/api/member/*` serves the member entry, `/api/admin/*` serves the console, `/api/federation/mail` relays mail for instances |
| Console | static page + API | `/admin/`, after admin login: first the overview (instances and probes, application records, mail, recent events), then query records, edit instance config, take manifest entries |
| Application storage | SQLite | `var/xknot.db`, tables `applications`, `admins`, `sessions`, `member_codes`, `member_sessions`, `events`, `claim_tokens`, `notify_log`, `relay_tokens`, `relay_switches`, `relay_log`, `provision_runs` |
| Health probe | build step + scheduled patrol | one probe at build time; `ops/watch-health.mjs` every 15 minutes, writes `var/health.json` and mails by consecutive duration |
| Activity data fetch | build step | fetches `statsUrl` at build time, writes `var/stats/{id}.json` |
| Entry traffic | hourly aggregation | reads the entry nginx access log, writes `var/traffic/{id}.json` per subdomain plus `var/traffic/hub.json` for the portal itself; console-only |
| Node status | synthesized document | `ops/node-status.mjs` merges probe, tunnel peer, location, and traffic into `var/status.json`; the console reads this one |
| Site profile fetch | build step + republish loop | fetches `url` + `/api/federation/profile`, writes `var/profiles/{id}.json`; a failed fetch keeps the previous copy |
| Data snapshot | build step + republish loop | merges manifest (issued zone), profile copies (self-described zone), probes, activity data, and showcase, writes `dist/data/hub.json` |
| Showcase fetch | build step | fetches `cardsUrl` at build time, writes `var/cards/{id}.json` |
| Agent guide | build step | the repo root `docs/KNOT_HELP.md` (English body, the only published source) renders to `dist/knot-help.html` and copies verbatim to `dist/knot-help.md` |
| Crawl entry | build step | `ops/build-seo.mjs` writes `dist/robots.txt` and `dist/sitemap.xml` and, from the snapshot, three script-free `<locale>/instances/` directory pages; the home page's `<noscript>` carries the same directory summary |

The portal remains static files; the snapshot is assembled from disk at build time and on every republish. The only data-side write entry that can change the listing is the join application: it does not write `instances.json`, submission is approval, and it lands an `approved` record; afterwards the resident worker writes the entry into the manifest and connects it, and the snapshot recomputes itself. The application endpoint cannot change any already-listed entry.

Three sets of data each manage their own part: `instances.json` holds only the issued zone (`id`, `url`, `since`, `tier`, `status`, `statsUrl`, `cardsUrl`), written by the worker; `var/profiles/{id}.json` is the copy of each instance's self-described zone, written by the owner in their own site's `/admin` and fetched by the hub via `url`; `federation.json` records the founding instance, access mode, and tunnel account and port. The roster does not participate in rendering; it is only cross-checked with the manifest before the build.

The manifest header is `{ "version": <integer ≥1>, "updatedAt": "YYYY-MM-DD" }`: `version` records how many times this manifest was changed, incremented on every real write by `publish`, `markActive`, and the console's "edit", with repeated publication not touching it; `updatedAt` is the last change day. Both are validated by `ops/validate-instances.mjs`; a wrong or missing value fails `npm run validate`.

The API side additionally has mail relay (`POST /api/federation/mail`), which writes neither the manifest nor the snapshot, only hands a message to the hub's SMTP; see [FEDERATION.md](FEDERATION.md) section 7.

The project is independent of bot01: installation, build, preview, and tests all happen on this machine.

## 2. Directory

```text
xknot.si/
├── README.md              federation entry
├── package.json           this project's scripts: dev / build / test / deploy / admin
├── instances.json         instance manifest: issued-zone fields (build and publish go by this file; the console only edits this section)
├── federation.json        federation roster: membership identity, access mode, tunnel account and port
├── fixtures/              layout samples: ten partner entries, probe and showcase samples, merged only under --preview
├── server/
│   ├── index.mjs          API process entry, listens only on 127.0.0.1:5181
│   ├── app.mjs            routes, same-origin check, rate limiting, Cookie
│   ├── store.mjs          opens the SQLite file, prepares the schema, assembles the domains below
│   ├── store/             one file per domain: applications (+ provisioning runs), claim tokens, mail log,
│   │                      admins and sessions, relay, members, settings; schema.mjs holds tables and migrations
│   ├── validate.mjs       application form field validation (pure function)
│   ├── manifest.mjs       application → instances.json entry, self-checks after generation
│   ├── edit.mjs           console instance-config edits: whole-file validation then atomic write-back of both files
│   ├── publish.mjs        writes the instance into manifest and roster after approval (idempotent, retried by automatic provisioning)
│   ├── provision.mjs      automatic provisioning state machine: allocate, publish, account, sshd, static root, DNS, reverse proxy, certificate, each idempotent
│   ├── relay.mjs          mail-relay field validation and message assembly (pure function)
│   ├── mail.mjs           SMTP client (net/tls, no external deps) and mail assembly
│   ├── env-file.mjs      reads var/mail.env so the CLI and systemd share one send config
│   ├── member-mail.mjs    the member entry's one-time login mail (not in the resendable event table)
│   ├── notify.mjs         partner and internal mail template registry (9 + 2, trilingual)
│   ├── pages.mjs          the /case/, /claim/ two script-free pages
│   ├── mail-test.mjs      sends a test mail (npm run mail:test)
│   ├── admin-cli.mjs      create admin, resend mail, handoff, issue credentials
│   └── *.test.mjs         API, state machine, template, and send-flow tests
├── admin/
│   ├── index.html         console entry, not part of the Vite build
│   ├── admin.js           login, list, instance config, manifest fragment
│   └── admin.css          console styles
├── docs/
│   ├── NAMING.md          naming conventions
│   ├── I18N.md            i18n and region
│   ├── FEDERATION.md      the hub-instance contract
│   ├── ARCHITECTURE.md    the system map: roles, planes, state, failure modes
│   ├── HUB.md             this file
│   ├── JOIN.md            joining: application, domain, and tunnel
│   ├── E2E.md             local deployment shape, test layers, coverage matrix
│   ├── HANDOFF.md         the handoff sheet from subdomain issuance to instance connection
│   ├── PARTNER-MAIL.md    mail templates and sending rules for partners
│   ├── BILLING.md         billing: what the paid access subscription covers and who charges whom (plan)
│   ├── federation.svg     architecture diagram
│   ├── architecture.svg   system map diagram (accompanies ARCHITECTURE.md)
│   └── handoff-flow.svg   handoff diagram (accompanies HANDOFF.md)
├── ops/
│   ├── xknot.si.conf            nginx config for the portal and API
│   ├── dev.mjs                  starts API and Vite together
│   ├── local-hub.mjs            local entry: static site, security headers, reverse proxy, mirroring nginx
│   ├── local-stack.mjs          local deployment orchestration: temp data dir, random port, start/stop
│   ├── deploy-local.sh          one-shot local deployment: validate, build, start
│   ├── entry/                   handoff runbook for issued subdomains (no conf committed)
│   ├── check-health.mjs         health probe, writes var/health.json
│   ├── watch-health.mjs         patrol: 24h reminder, 7d hide, auto-recovery
│   ├── traffic.mjs              entry access log → per-subdomain daily traffic, writes var/traffic/
│   ├── node-status.mjs          synthesizes node status: probe, tunnel, location, traffic → var/status.json
│   ├── peers.mjs                tunnel peer → egress IP: reads ss/ps, matching the roster's tunnel accounts
│   ├── snapshots.mjs            public snapshot fetch: routed through the tunnel to the instance, written to the entry disk only when changed
│   ├── warm-entry.mjs           entry warm-up: after connect, fetches the home page and the assets it references
│   ├── geoip.mjs                egress IP → country code: DB-IP Lite, writes var/geoip/locations.json
│   ├── subdomain.mjs            subdomain normalization, reserved-name and length validation, candidate suggestions
│   ├── probe-target.mjs         probe address and gate: builds /api/health from the manifest url
│   ├── provision-worker.mjs     automatic provisioning resident: opens the entry, switches the reverse proxy, also collects location
│   ├── notify-live.mjs          sends the one-time partner.live notice after acceptance (called by the worker)
│   ├── republish.mjs            recomputes the portal snapshot at runtime: updates data/hub.json after a connect or profile revision
│   ├── check-server-imports.mjs guard: server modules must not be imported from ops or the web build
│   ├── xknot-provision.service  automatic provisioning unit (long-running)
│   ├── xknot-health.service     patrol service unit (oneshot)
│   ├── xknot-health.timer       patrol timer (every 15 minutes)
│   ├── xknot-traffic.service    traffic aggregation unit (oneshot)
│   ├── xknot-traffic.timer      traffic aggregation timer (hourly)
│   ├── xknot-republish.service  portal snapshot recompute unit (oneshot)
│   ├── xknot-republish.timer    portal snapshot recompute timer (every 10 minutes)
│   ├── build-hub-data.mjs       merges manifest, probes, activity data, and showcase, writes data/hub.json
│   ├── build-seo.mjs            crawl entry: robots, sitemap, three script-free instance directories, verification meta
│   ├── seo-check.mjs            post-deploy crawl check: robots, sitemap, canonical, hreflang, structured data
│   ├── doc-page.mjs             shared doc page: markdown → single-page HTML + raw text, shared by all static docs on the portal
│   ├── render-knot-help.mjs     publishes repo-root docs/KNOT_HELP.md to /knot-help and /knot-help.md
│   ├── build-federation-map.mjs generates the federation map diagram (repo-root docs/knot-federation-map.svg)
│   ├── build-world-dots.mjs     generates the world base map (web/src/lib/world.js)
│   ├── cards.mjs                reads showcase under var/cards/ merged with preview samples
│   ├── stats.mjs                reads activity data under var/stats/ merged with preview samples
│   ├── fetch-guard.mjs          fetch guard: https, DNS, timeout, size, atomic write
│   ├── fetch-cards.mjs          showcase fetch, writes var/cards/{id}.json
│   ├── fetch-stats.mjs          activity data fetch, writes var/stats/{id}.json
│   ├── fetch-profile.mjs        profile fetch: reads /api/federation/profile, writes var/profiles/{id}.json
│   ├── profile-schema.mjs       the self-described zone's field contract and cleaning (shared by portal and fetch)
│   ├── profiles.mjs             reads copies under var/profiles/
│   ├── build-hub.sh             local build: validate, probe, fetch, build, write snapshot, crawl entry
│   ├── verify-hub-data.mjs      pre-publish guard: the snapshot's ids must match the manifest
│   ├── deploy-hub.sh            optional static site sync (target given by env vars)
│   ├── deploy-api.sh            hub API, console, and site config sync
│   ├── README-deploy-aws.md     deployment notes for the hub hosting host
│   ├── validate-instances.mjs   manifest validation
│   └── validate-federation.mjs  roster validation (cross-checked with the manifest)
├── var/
│   ├── health.json        probe results (generated, not in version control)
│   ├── status.json        node status synthesis (generated, not in version control, read by the console)
│   ├── traffic/           each subdomain's daily traffic (generated, not in version control, console-only)
│   ├── peers.json         tunnel peer addresses (generated, not in version control, not sent out)
│   ├── geoip/             DB-IP database, IP resolution cache, and locations.json (generated, not in version control)
│   ├── xknot.db           applications, accounts, and send records (generated, not in version control)
│   ├── stats/             each instance's activity-data copy (generated, not in version control)
│   ├── cards/             each instance's showcase copy (generated, not in version control)
│   ├── profiles/          each instance's self-described-zone copy (generated, not in version control)
│   ├── mail.env           SMTP credentials for the CLI and systemd (not in version control, 0600)
│   └── snapshots.json     each subdomain's snapshot etag and digest (generated, not in version control)
└── web/                   Vue portal, an independent subproject
    ├── package.json       its own deps and scripts
    ├── package-lock.json  its own lockfile
    ├── vite.config.js     trilingual entries, dev data middleware, /api and /admin proxy
    ├── index.html         / redirect
    ├── en/                English entry
    ├── zh-CN/             simplified entry
    ├── zh-TW/             traditional entry
    ├── public/logos/      hub mark and instance LOGOs
    ├── src/
    │   ├── main.js        mount, locale from the HTML lang
    │   ├── App.vue        left/right split: left network, right member entry and join guide
    │   ├── styles.css     global styles and theme variables
    │   ├── components/
    │   │   ├── NetworkMap.vue  federation map: world base, floating hub badge and flight lines, click jumps to the entry
    │   │   ├── NodeCard.vue    directory card: status, intro, showcase, and local time
    │   │   ├── JoinPanel.vue   member entry: email → auth code → site status, with the four-step join guide below
    │   │   ├── GlobePattern.vue the dotted-globe texture on the orange panel
    │   │   └── LangSwitch.vue  language switch (light and orange backgrounds)
    │   ├── icons/         inline SVG icons
    │   ├── lib/           pure logic: i18n, regions, timezones, hub, clock, cards, catalogs, snapshot, preview, placement, hue, world
    │   └── locales/       en, zh-CN, zh-TW text
    └── dist/              build output (generated, not in version control)
```

`xknot.si/` is itself an npm project, with the pages' dependencies isolated in `web/`. Both levels run directly:

```bash
cd xknot.si
npm run dev           # API 5181 + dev server 5180, with fixtures/ samples
npm run dev:real      # same ports, reads the real manifest only
npm run api           # starts only the API
npm run build         # validate, probe, build, write snapshot, crawl entry, output in web/dist
npm run build:preview # merges sample entries for layout preview, not for publishing
npm run verify        # re-checks dist/data/hub.json's instances against instances.json
npm run seo:check     # post-deploy crawl check against the live site (exit 1 on any failure)
npm run republish     # recomputes only data/hub.json (no bundling, no assets), runtime use
npm run validate      # both manifest + roster validation
npm run test          # unit tests (manifest, roster, page logic, API, and mail)
```

### 2.1 Roster fields

`federation.json` records the network members' facts and does not participate in portal rendering. Fields and values:

| Field | Value | Notes |
|------|------|------|
| `version` | integer ≥1 | structure version |
| `updatedAt` | `YYYY-MM-DD` | last change day |
| `hub` | hostname | the hub's own host, fixed `xknot.si` |
| `members[].id` | lowercase kebab | must match `instances.json`'s `id` |
| `members[].host` | hostname | must equal the manifest `url`'s host |
| `members[].role` | `founder` / `partner` | exactly one `founder` |
| `members[].standing` | `permanent` / `regular` | `founder` must be `permanent`, and cannot be `listed: false` |
| `members[].mode` | `subdomain` (only value) | access shape. Address is always `https://<label>.xknot.si` |
| `members[].tunnel` | `{ account, port }` | required, not `null`; account and port unique across the roster |
| `members[].listed` | `true` / `false` | whether listed; decides whether it appears in the manifest |
| `members[].since` | `YYYY-MM-DD` / `null` | required when `listed: true` |
| `members[].note` | ≤200 chars | a one-liner for staff |

Validation in `ops/validate-federation.mjs`; `ops/federation.test.mjs` covers negative cases. Roster and manifest align two-way by `id`; one more or one fewer either way fails.

Console and admins:

```bash
cd xknot.si
XKNOT_ADMIN_PASSWORD='...' npm run admin -- create-admin paul
npm run admin -- list                 # pending applications
npm run admin -- show XK-2026-XXXXXX
npm run admin -- manifest XK-2026-XXXXXX
npm run admin -- publish XK-2026-XXXXXX --tunnel-account knot-tunnel-<id> --tunnel-port 18090
```

Open `http://127.0.0.1:5180/admin/` locally to log into the console; the API process also serves the same page directly at `http://127.0.0.1:5181/admin/`.

```bash
cd xknot.si/web
npm ci
npm run dev      # dev, port 5180
npm run build    # output dist/, no data snapshot
npm run test     # pure-logic unit tests
```

`xknot.si/` installs dependencies only inside `web/`; the root has no `node_modules`. It does not join `knot-platform/`'s `workspaces`, does not import `knot-platform/*` code, and does not depend on any process on bot01.

## 3. Build and data

The portal is a Vue 3 + Vite multi-entry build: `en/`, `zh-CN/`, `zh-TW/` each with one HTML, and `index.html` redirecting to `/en/`. Each entry's `lang`, `hreflang`, `canonical` are written directly in the HTML, not relying on client scripts.

The page reads one snapshot at runtime:

```text
/data/hub.json
```

The snapshot is generated by `ops/build-hub-data.mjs`; the merge logic is in `web/src/lib/snapshot.js`, shared by the probe task and the dev server. Its content is the manifest fields plus each instance's probe result.

Two layers in the snapshot are **samples from the moment of build**, updated only by rebuilding: each instance's `health`, and the region derived from `region`. So after loading the snapshot, the page fetches two runtime data sets to override them (keeping the snapshot on failure; the page never sits empty):

```text
/api/probes     each instance's current probe result (every 15 minutes)
/api/locations  each instance's observed region (see section 4)
```

`/api/probes` only gives the status layer: `{ checkedAt, probes: { <id>: { status, latencyMs, version, lastOkAt, downSince, hidden } } }`. The merge rule is in `web/src/lib/hub.js`'s `applyProbes`: only `health` is replaced; the issued zone, self-described zone, showcase, and activity data still come from the snapshot; an id not in the snapshot does not add an entry.

This override is necessary: the build probes once, and if that one run happens to hit an instance restart (tunnel just dropped, Backend not up yet), one 502 stays on the portal with the snapshot until the next build.

### 3.1 Layout samples

`fixtures/preview-instances.json` holds ten partners' issued zones, `fixtures/preview-profiles.json` the matching self-described zones, and `fixtures/preview-health.json` the probe samples. Their one purpose: make the directory look like it really has a dozen members, to judge the layout.

- The three files are samples, **not the member list**. Real members live in `federation.json` (roster), `instances.json` (issued zone), and each instance's own profile; samples are not written into these files.
- They merge into memory and the current build only when `XKNOT_PREVIEW=1`; when the real manifest already has the same id, the real entry wins, and real probe results also win.
- `ops/verify-hub-data.mjs` re-checks after every build: the production snapshot's ids must exactly match `instances.json`, one more or fewer either way fails the build; preview builds only allow ids from `fixtures/`. `ops/deploy-hub.sh` re-checks once more before syncing.
- `npm run validate:fixtures` validates the samples themselves, and `preview.test.mjs` covers the merge rules.
- When replacing with real members, just delete the matching sample entries; no hub code change.

```json
{
  "generatedAt": "2026-10-19T03:00:00.000Z",
  "instances": [
    {
      "id": "wang",
      "name": "Knot · wang",
      "tagline": "面向 AI 时代、服务于 Agent 的信息交换网。",
      "url": "https://wang.xknot.si",
      "region": "CN",
      "timezone": "Asia/Shanghai",
      "tags": ["信息交换", "Agent"],
      "tier": "paid",
      "status": "active",
      "health": { "status": "up", "lastOkAt": "2026-10-19T02:30:00.000Z", "version": "0.7.0" }
    }
  ]
}
```

Above, `name`, `tagline`, `region`, `timezone`, `tags` come from that instance's self-described zone copy; `id`, `url`, `tier`, `status` from the manifest; `health` from the probe. Without a self-described zone, the portal shows only the issued-zone fields.

The snapshot is generated on the build machine and contains no egress IP, and should not. **The page's region follows the hub-observed location** (`GET /api/locations`, written server-side to `var/geoip/locations.json` by `ops/peers.mjs` + `ops/geoip.mjs`); the self-described `region` is only the fallback when there is no observation. Reason in section 4 "Federation map".

Build flow:

```bash
./xknot.si/ops/build-hub.sh            # validate, probe, fetch profiles, build, write snapshot, crawl entry
./xknot.si/ops/build-hub.sh --offline  # skip probes, reuse var/health.json
```

The script order is fixed: validate manifest → probe health → fetch profiles → install deps (first run only) → build → emit the Agent guide → write `dist/data/hub.json` → write `robots.txt`, `sitemap.xml`, and the static instance directory. All on this machine, no remote connection.

Page data rules:

- Locale from the current HTML's `lang`, not the browser language, no GeoIP request.
- Text from `src/locales/`, missing key falls back to English, then the block is not rendered.
- Time uses `formatWhen`: relative within 7 days, absolute beyond, computed in the instance's `timezone`.
- Region grouping derived from the country code by `src/lib/regions.js`'s `groupsOf`. The country code prefers the `/api/locations` observation, then `hub.json`'s `region`.
- `hub.json` is served by nginx with `no-cache`; its `health` and `region` are build-time samples that change only on rebuild. The page also fetches `/api/probes` and `/api/locations`, so status and location update without rebuilding.

### 3.2 After connect: the snapshot updates itself

`build-hub.sh` outputs the **whole site**, needing the frontend toolchain; but "a node just connected" only needs `data/hub.json` updated. So at runtime there is a data-only path:

```bash
node ops/republish.mjs --out /var/www/xknot/data/hub.json --quiet
```

It fetches profiles → reads probes, showcase, activity data → `buildHubData` → `verifyHubData` → atomically replaces `hub.json` in the same order. It does not bundle and does not touch dist assets, so the hub host works without Vite installed.

Who calls it:

| Trigger | Location | Role |
|------|------|------|
| node acceptance passed | `refreshPortal()` in `ops/provision-worker.mjs` | recomputes immediately after changing `status` to `active`; the card appears within seconds |
| every 10 minutes | `ops/xknot-republish.timer` | tops up profile revisions, health, traffic, and new nodes; also covers that one failure |

Two constraints live in `ops/republish.mjs`: a snapshot failing `verifyHubData` is not written (better no update than a bad one); a partner profile that cannot be fetched only records a warning, the card falls back to id, without halting the whole site.

After deploying to the hub, `deploy-api.sh` enables this timer; `systemctl list-timers xknot-republish.timer` confirms it.

### 3.3 Crawl entry and static directory

The portal home page is a single-page shell: a crawler that does not run JS sees only the title and no link to any instance. `ops/build-seo.mjs` adds a script-free layer after the snapshot:

| Output | Content |
|--------|---------|
| `/<locale>/instances/` | script-free instance directory, included in the sitemap |
| `/robots.txt` | crawl entry, points to the sitemap |
| `/sitemap.xml` | the three locale entries, the instance directory, and `/knot-help` |

The directory reads `dist/data/hub.json`, the same data as the portal; entries with `health.hidden` are skipped, and only `https` site addresses are kept. The origin defaults to `https://xknot.si` and can be overridden with `--origin` or `XKNOT_HUB_ORIGIN` (a local build writes it into `canonical` and the sitemap).

Instance subdomains get their own pair, written by the entry rather than by the instance: a whole-site proxied subdomain falls through `/robots.txt` and `/sitemap.xml` into the WebUI's SPA fallback and answers with a 200 `index.html`, which a search engine reads as an empty rule set and an invalid sitemap — silently, with no error anywhere. `server/provision.mjs` therefore generates both files into the subdomain's entry directory, and every proxied vhost serves them from that disk before falling back to the tunnel. They are generated even on the reconcile pass, not only at first provisioning: an already-open subdomain never runs the provisioning steps again, so without that pass a fixed vhost would keep falling back. The content matches byte for byte what a statically served instance writes itself, because the two paths share one domain and a mismatch would split the federation's sitemaps into two formats. Only `/` and `/discover` are listed — the rest is either API or account state.


### 3.4 Search-console verification

Impressions, clicks, and query terms exist only in the search engines' own webmaster consoles; no server-side log can recover them. What the site has to supply is a proof of ownership, and of the three accepted proofs, the meta tag is the only one that needs nothing outside the repo: no DNS record, no oddly named file at the root.

`var/search-verify.json` (never in version control) holds the tokens:

```json
{ "google": "<token>", "bing": "<token>", "baidu": "<token>", "yandex": "<token>" }
```

`ops/build-seo.mjs` reads it (`--verify <path>`, or `XKNOT_SEARCH_VERIFY`, default `var/search-verify.json`), and injects one `<meta>` per configured engine into the root redirect page, every locale home page, and every directory page, inside a `<!-- knot-verify -->` block so that repeated builds replace rather than stack. The root page matters: Search Console verifies the URL prefix you entered, so that exact URL has to deliver the tag itself. `ops/xknot.si.conf` therefore serves the jump page at `/` with `try_files /index.html` instead of a `302 /en/` — behind a redirect the file was never delivered, and a check that follows redirects would be inspecting `/en/` while claiming to inspect `/`. A missing file means nothing configured and is not an error; an unknown key or a token outside `[A-Za-z0-9._\-+/=]` fails the build, because a silently ignored typo yields pages that look injected and verify nothing. Only the engines listed in `VERIFY_ENGINES` are accepted: `google` → `google-site-verification`, `bing` → `msvalidate.01`, `baidu` → `baidu-site-verification`, `yandex` → `yandex-verification`.

Two property types, and the choice is fixed per property:

- **URL prefix** (`https://xknot.si/`): verified by the meta tag above. Needs no DNS access, and each engine can be added on its own.
- **Domain** (`xknot.si`): verified **only** by a DNS TXT record; the meta tag does nothing for it. It also covers every partner subdomain, folding their index data into the hub's property.

Prefer URL prefix unless owning the whole zone is the point. For a Domain property, add one TXT record at the apex, quoted, beside the existing SPF record — `"google-site-verification=<token>"` — then confirm with `node ops/seo-check.mjs --dns` (or `npm run seo:check -- --dns`), which queries authoritative DNS directly and fails when the record is absent. Put it in the zone that actually serves the domain: a record added to a stale or delegated-away zone resolves nowhere, and the console only says so after another retry cycle.

After deploying, `npm run seo:check` (or `node ops/seo-check.mjs --origin <site>`) requests the live site and reports what does not hold: robots rules and its sitemap line, every sitemap URL returning 200 `text/html`, per-locale canonical pointing at itself, the full hreflang set, a title and description, no stray `noindex`, `CollectionPage` structured data on the directory, the configured verification meta matching the local token, and `/knot-help` answering. `--dns` adds the Domain property's TXT record, and only then — a property accepts one verification type, so guessing which one was created would produce a pass that the console still rejects. Exit code is 1 on any failure, so it can hang off a deploy. It reads no local files besides the token file — a black-box check, same command for staging and production.

## 4. Pages

One screen, two columns: the left is white, holding the current federation's global network; the right is orange, holding "log into your XKnot" and the four-step join guide.

1. **Left column (white)**: top bar (horizontal lockup, online count, theme and locale) → masthead (`XKNOT` and the local-language name, tagline, one positioning line) → federation map (`global instance distribution`, status legend, world base, with a row of four numbers below: instances, regions, online, last sync) → instance directory (region filter, online only, showcase only, cards) → footer (the no-content-hosting statement, license, operator entry). The left column scrolls independently; the filter bar and directory header stick.
2. **Right column (orange)**: dotted globe and graticule as the base. `Log into your XKnot`: email → one-time auth code → site status (health, activity counts, showcase count). Below is the four-step join guide (deploy instance → open `/admin` → pick a subdomain and submit in the instance → wait for the reply) and the federation agreements. The right column **takes no application form**: a site that has not deployed an instance is not eligible to join; the submission entry is in the instance's own admin page.

Below 900px it becomes top-bottom: white network on top, orange right column below, whole-page scroll. In top-bottom mode the right column lands after the instance directory, so the masthead adds an `申请加入 →` anchor (`#join`) as a clickable point. When the right column is squeezed to about 400px, the four-step guide collapses so the login button stays in the first screen.

### Federation map

The map is an equirectangular world base (`web/src/lib/world.js`, data from Natural Earth 110m land, generated by `ops/build-world-dots.mjs`). An instance's position **takes the hub-observed egress IP**, no longer the `region` filled at registration: machines move — home broadband switching cities, or the whole machine moving to a data center — and the country code in the self-described zone does not follow.

Observation needs no instance cooperation. Instances are all behind NAT; joining the federation only lets them connect out, so every tunnel is an SSH connection initiated by the instance. The hub and entry are the same machine, and the kernel records each connection's peer address (`sudo ss -tnp state established '( sport = :22 )'`), while `ps` gives which tunnel account this session uses; the account maps to the instance id in the `federation.json` roster, so "who connected out from which address" is already available.

The chain has three hops, each doing one thing:

1. `ops/peers.mjs`: `ss` + `ps` → `var/peers.json` (`{ instance id: { ip, account } }`). Runs only in `provision-worker`, once a minute; it is already resident and already has sudo. On read failure it keeps the previous copy, not writing an empty result.
2. `ops/geoip.mjs`: egress IP → country code, writes `var/geoip/locations.json`. Data is DB-IP's free database (`dbip-country-lite-YYYY-MM.csv.gz`, CC BY 4.0), monthly updates, no account, resolution on this machine, no third-party API. Address resolution caches for 30 days, so in the normal case it neither resolves nor downloads.
3. `GET /api/locations`: only gives `{ instance id: { country, at, source } }` outward. **The egress IP never leaves this process** — the portal wants the region, not someone's broadband address posted publicly.

The page fetches `/api/locations` together with `hub.json`: the observed country code overrides `region`, and `groups`, filters, cards, and the map all follow; on failure it uses the self-described `region`. An overridden region on the card carries a dotted underline, and hovering shows "region judged by egress IP". Health likewise is overridden by `/api/probes`, see section 3.

The landing point is that country's center (summing and centering for multiple countries), so "the four Nordic countries" land in Scandinavia and "Argentina + Chile + Uruguay" in the Southern Cone. Several instances behind one egress compute the same coordinate; the spread rule is described below. `GLOBAL` entries, or those with neither observation nor `region`, do not go on the map; they collect in a small "no fixed region" label row below the map and stay clickable.

Two boundaries to remember: without a tunnel (instance offline, or just issued and not yet connected) there is no peer address, so it falls back to the self-described zone; when the hub is not the entry host it cannot read others' sockets, the whole chain quietly disables, and the page is unchanged. IPv6 egress is also judged; DB-IP's IPv6 database is coarser than IPv4 and occasionally lands in a neighboring country.

The card's "local time · region" line: the region takes the country code per the rules above (grouped via `src/lib/regions.js`), the clock takes the instance's self-described `timezone`. With neither region nor clock, the card shows "other" and the clock as UTC.

The clock has only one fallback layer: if the owner wrote `timezone` in the self-described zone it always wins; only when missing does it use the egress-IP country to pick one primary timezone in `src/lib/timezones.js` (US → New York, Brazil → São Paulo, Australia → Sydney). This layer is only "a plausible clock", not precise to the city — when a country spans several timezones, the one in the table may not be where this machine is. A derived clock carries the same dotted underline as the region, hovering to say "clock estimated by egress IP". The two marks are separate: the region may be observed while the clock is still self-described, or the reverse.

`hub.json`'s `timezone` can therefore be `null`: that means the owner did not write one, not "this machine is in UTC". The default UTC is only a render-time fallback, not written into the snapshot.

- The base is dotted land + a 30° graticule, the same visual language as the right column's dotted globe. The map only says "where", carrying no geographic detail.
- Above the map floats a **hub badge** (`XKNOT` + federation hub), not on any lat/long. The mark is rendered by `BrandMark` at three resolutions, the rest of the badge layout unchanged.
- Each instance draws one **dashed arc** flying to the hub (`stroke-dasharray: 10 5`, selected `12 4`), the arc bulging slightly away from the central axis so ten lines do not compress into one column below the hub. The dashed rhythm reads more like flight routes; line state is distinguished only by thickness and shade (selected thicker and darker, unreachable faded). The short light dot on the arc staggers its delay by manifest order, flying from the instance to the hub.
- **The arc's colour follows the station**: the outgoing end takes that instance's colour (its own hue when healthy, the status colour otherwise) and settles into the hub's orange at the hub end. A dozen lines converge on one point, so only colour tells which line belongs to which dot; sharing the hub colour at that end still reads as "all of them lead to the hub". The gradient runs `userSpaceOnUse` from the instance's coordinates to the hub's, `stroke` references `url(#arc-<id>)`, and the id is sanitised; `down` / `unknown` stay untinted on `--map-link-line`'s faded orange.
- Both ends of the gradient carry their own opacity (light `.7` → `.5`, dark `hsl(… 68% 62%)` at `.62` → `.45`), expressed through `stop-opacity` rather than dimming the whole path: the dash pattern needs alpha too, and multiplying the two muddies it. The placeholder mark inside the hub badge still uses opaque `--map-link`, so the lines' landing point does not separate from the badge.
- The arcs' meeting point is taken above the canvas top edge (`HUB.y < 0`), hidden behind the badge, leaving no knot on the map.
- **Between instances there is another layer of direct links**, drawn under the arcs: in the future sites will exchange data directly by protocol standard, without every one routing through the hub. Each site takes its nearest 2, 3, or 4 neighbors (rotating by manifest order, `PEER_DEGREES = [2, 3, 4]`), so the network is uneven, not a complete graph. When two dots select each other only one line draws; A–B and B–A are the same line. Direct links are straight lines, the hub-facing arcs are curves, so shape alone separates the two semantics.
- Direct links also take one colour at each end: a `linearGradient` runs from A's coordinates to B's, each end that station's colour (light `stop-opacity: .4`, dark `.26`), so a line is the colour of the station it touches at that end. When either end is `down` the whole line fades to 0.4; selecting a station thickens its connected lines and brightens them with `filter: brightness()` — the gradient lives in `<defs>`, so an ancestor selector cannot change the `stop` and the element itself has to be raised. The map footnote's sample segment now uses a two-colour gradient, and the copy says "thin links" instead of "green": colour no longer carries protocol meaning.
- The badge uses `transform: translate(-50%, -74%)` to hover at the map's top edge, with a breathing shadow below; the badge body and shadow each float 7s up-and-down, stopped under `prefers-reduced-motion`.
- The site name is not permanent: the dot only answers "is there a station here", and the name, region, and local time live in the floating label shown on hover/focus/select (`.tip`). Narrow screens stay long-press clickable.
- **Instances sharing one landing point spread out**: position is only resolved to a country, so instances behind the same egress get identical coordinates. `src/lib/placement.js` arranges them evenly on a circle around that coordinate, with the radius solved from "how far apart two neighbours on the ring must stay": the chord \(2r\sin(\pi/n)\) is no smaller than the required gap, so \(r = \text{gap}/(2\sin(\pi/n))\) — more members, larger ring, no hard cap. The gap is 26 (the hit-area size; names moved to hover, so no room for permanent text is needed). The start angle comes from a hash of the anchor coordinates, so one anchor always starts at the same angle while different anchors differ — not every cluster begins straight up. The centre moves inward by the radius so the whole circle stays on the canvas and countries at the edge (Antarctica, Tuvalu) are not cut in half; the anchor keeps a small hollow ring and each spread dot points back to it with a thin line in its own colour (`--pin-hue`, the station's hue when healthy). When two different landing points come within 26 of each other, the later one is pushed away along the connecting line, repeatedly, until it fits or the round limit is hit. A single ring holds 44 dots on the 960×379 canvas; beyond that, concentric rings are needed. The layout depends only on manifest order and coordinates, so a refresh does not jump.
- Selecting a dot scrolls to the matching entry and highlights it for 2.6 seconds; filtered-out dots dim but stay clickable.
- **The dot's colour answers "who" first**: `up` uses the station's own hue (`src/lib/hue.js`, the same one as the card badge, FNV-1a finished with murmur3 and spread on the colour wheel), so one station is always the same colour on card and map; `degraded` / `down` / `unknown` switch to the status colour, and the red alarm rule stays. Colour is therefore both an identifier and an alarm, and the two do not coexist: healthy you read identity, abnormal you read status.
- Motion is only the pulse, the light dots flying to the hub, and the badge float, all stopped under `prefers-reduced-motion`.

### Brand assets

The mark's vector master is the repo root's `docs/xknot-mark.svg`; `web/public/` holds only finished rasterizations derived from it, referencing no external sites.

| File | Resolution | Use |
|------|--------|------|
| `logos/xknot.jpg` | 1024×1024 | share card `og:image`: deep orange base + white mark |
| `logos/xknot-icon.png` | 512×512 | the large master |
| `logos/xknot-icon-32.png` | 32×32 (small) | 1× screen page header and map badge |
| `logos/xknot-icon-64.png` | 64×64 (medium) | 2× screens, console header |
| `logos/xknot-icon-128.png` | 128×128 (large) | 3× and above, also the src fallback |
| `favicon-32.png` / `favicon-16.png` | 32, 16 | browser tab |
| `apple-touch-icon.png` | 180×180 | iOS home screen (white base, home-screen icons must not be transparent) |

The page header has one horizontal lockup: `components/BrandLockup.vue` inlines the geometry of the repo root `docs/xknot-lockup.svg`, mark in deep orange, `Knot` in premium black, and the dark theme turns the whole thing white (same as `docs/xknot-lockup-inverse.svg`), no separate icon+text assembly. The map badge is still rendered by `components/BrandMark.vue`: `srcset` with `1x / 2x / 3x` descriptors pointing to the 32 / 64 / 128 tiers, the browser picking one by device pixel ratio, so high-DPI screens no longer upscale the small image. The console header uses the same `srcset`.

The mark has only one master: the deep-orange geometric mark on a transparent base. The lockup's mark uses the same geometry, and `Knot` is a glyph converted to paths, rendering independent of system fonts. The graphic carries its own padding; the page header adds no radius or stroke to it; `og:image` is the only reversed (white) spot. Tiers and the re-export command in `docs/README.md`.

### Instance directory and showcase

The directory is a card grid (`repeat(auto-fill, minmax(272px, 1fr))`, two columns from about 750px, three when wider), each card one site:

- Header: site badge (the `logo` if present, otherwise the first letter of the name on the default primary color), site name (the whole card is the clickable entry), tier badge, entry arrow; below the name is the current time in the instance's own timezone, region, and `UTC±X`. A region judged by egress IP carries a dotted underline, hovering explains the source; a clock that is an estimate carries one too.
- Body: the one-line intro (`site.tagline`), at most two lines; empty otherwise, no placeholder text.
- Tags: `site.tags` rendered one by one as small capsules, the owner's original text, not translated, not reordered.
- Showcase slot: when there is an L3 card, show the first one, flame mark + original title (the partner's language, not translated) + "updated X" + language code + "N more". Clicking it goes to that piece on the partner's site, separate from the card's own entry.
- Footer: signal bar and status, latency. Latency only shows when `up`, `degraded`; when `down`, show the last-ok time, to avoid treating probe latency as response time.

Cards have a 10px radius and 1px stroke, lifting 2px and revealing the top status color bar on hover. Selecting on the map highlights the whole card for 2.6 seconds.

The showcase is "grow when present, empty when not": a card without a showcase takes no slot and writes no "none", only being a bit shorter than its row. The directory header adds a `showcase only N` toggle when any showcase exists, and the toggle disappears entirely when none does, avoiding an entry that can never show anything.

Showcase age has three tiers (`lib/cards.js`): within 24 hours `fresh`, within a week `recent`, 7–30 days `aging` grayed (still there, but no longer read as news), over 30 days not shown. In `hub.json` each instance's `cards` is at most 6, carrying only `id`, `title`, `summary`, `url`, `lang`, `updatedAt`; the body `body` does not enter the portal.

The directory's clock is the current time in the **instance's own timezone**, refreshed every 20 seconds, with a `UTC±X` offset. This makes "distributed across timezones, maintained by different people" directly visible in the layout, no longer just a statement. Region is still only for filtering, not sorting.

Tier sorting is unchanged: `demo` → `paid` → `free` (`partner` in old snapshots sorts as `paid`, `community` as `free`), same tier by `since`, then `id`. Only the new three tiers are accepted when writing the manifest, with old values blocked by `ops/validate-instances.mjs`.

Tag filtering: appears only when some site uses tags, below the region row; options are all plus the actually-seen tag values, ordered by first appearance; clicking one shows only sites with that tag.

Region filtering: all, plus the actually-seen groups in the manifest, ordered fixed as global, East Asia, Southeast Asia, South Asia, Central Asia, Middle East, Europe, North America, Latin America, Africa, Oceania, other. Groups with no entry are not shown, to avoid an empty list.

After M2's fetch steps land, `ops/fetch-cards.mjs` fetches each `cardsUrl` into `var/cards/{id}.json`; both the build (`ops/build-hub-data.mjs`) and the dev server (`web/vite.config.js`) read this directory via `ops/cards.mjs`, fixing the entry shape and page rendering at that step. `fixtures/preview-cards.json` provides sample showcases, including multiple languages and non-Latin titles. The samples' `generatedAt` is a fixed time, so sample showcases age with real time; to keep the preview's showcase fresh, change the dates in the sample.

The page provides no registration and no on-site search. The right column has two segments: the top is "log into your XKnot", members receive a one-time auth code by email and see their site's listing status, health, activity counts, and showcase count; the bottom is "how to join", four steps spelling out deploy, `/admin`, pick a subdomain and submit, wait for the reply. There is no application form here: the application is submitted on the instance's own admin page. An application only writes the hub's queue, creates no account, and changes no existing instance. Showcase bodies are summary-only; clicking opens the origin.

### 4.1 Paths

| Path | Content |
|------|------|
| `/` | 302 to `/en/` |
| `/en/` | English page |
| `/zh-CN/` | simplified page |
| `/zh-TW/` | traditional page |
| `/data/hub.json` | runtime snapshot, `no-cache` |
| `/admin/` | console, needs an admin session to read data |
| `/api/applications` | join application, `POST` |
| `/api/subdomains/check` | whether a subdomain label can be issued, `GET` |
| `/api/locations` | each instance's observed region, `GET`, `no-store` |
| `/api/probes` | each instance's current probe result, `GET`, `no-store` |
| `/api/member/*` | member login, session, and site overview |
| `/api/admin/*` | login, session, application list, instance config, manifest entries |

Language switching is a plain link, returning to the same page. The page does not read visitor IPs, nor do GeoIP for visitors; the only geographic judgment target is each instance's outgoing tunnel, with only a country code as the result.

### 4.2 Visual direction

The hub is an independent product and does not reuse the Knot instance's Facebook style. It reads like an infrastructure dashboard, not a content community:

- Default light: page `#F3F6FB`, panel `#FFFFFF`, body `#0A1322`, secondary text `#475569`.
- Primary is a single blue `#0B5FFF`, with accent cyan `#0093A6` and purple `#6D4AFF`; status colors green `#0B7A54`, yellow `#A16207`, red `#B42318`.
- Dark is not pure black but ink-blue: page `#0A1220`, panel `#101A2B`, primary brightened to `#5B9BFF`. A top-bar button switches, the choice is saved to `localStorage`, and an inline script on the entry page header applies the theme first to avoid a white flash on refresh.
- The two themes share one set of semantic variables (`--page`, `--surface`, `--ink`, `--line`, `--accent`, `--ok`, etc.); components write no hardcoded colors.
- Fonts: Space Grotesk for headings and body, JetBrains Mono for technical labels. Both fonts are bundled with the build, no external CDN; Chinese falls back to the system sans.
- Visual elements: fine grid texture, two soft glows, 1px strokes, row separators, signal bars, federation map. No neon, scanlines, or glitch effects.
- Density first: two card columns on wide screens, four or more instances visible in the first screen; cards are information-first, no large-image covers, not pushing the directory to the second screen.
- Motion only expresses "the links are moving": top-bar sweep, instance pulse, staggered entry appearance, the highlight on map jump. All off under `prefers-reduced-motion`.
- The main operation completes at 360px, 390px, 768px, 1280px, 1440px. Clickable areas are no smaller than 44×44px.
- English text reserves 30% to 50% more length than Chinese; buttons and status dots use no fixed width.
- Icons are inline SVG, with `aria-label` when clickable.

## 5. Health probe

`ops/check-health.mjs`:

- Reads only `instances.json`: the roster's tunnel and identity fields do not participate in probing.
- Each instance's probe address is always `url` + `/api/health` (derived by `ops/probe-target.mjs`); only `status: active` is probed, `pending` / `suspended` / `retired` are not.
- Probes these addresses concurrently, timeout 5 seconds, no redirect following.
- Merges the previous `checks`, `ok`, `since`, accumulating.
- Atomically writes `var/health.json`.

Entries whose `status` is not `active` are not probed and keep the previous result.

The probe runs once at build time and depends on no remote machine. `var/health.json` keeps the previous result for accumulation; the scheduled patrol refreshes its remote copy every 15 minutes, and the portal reads the current value via `/api/probes` without waiting for the next build.

### 5.1 Scheduled patrol and disconnect rules

In production a systemd timer runs `ops/watch-health.mjs` every 15 minutes. It reuses `check-health.mjs`'s probe and state merge, then handles by consecutive duration:

| Condition | Action |
|------|------|
| `down` for 24 consecutive hours | mail the instance `contact` `partner.unreachable_24h` |
| `down` for 7 consecutive days | mail `partner.hidden_7d`, the portal no longer shows the entry |
| any probe `up` / `degraded` | clear `downSince` and the hide flag, automatically back on the portal |
| manifest `status` still `pending` and `since` is 14 days ago | internal reminder to the operator |
| manifest `status` still `pending` and `since` is 30 days ago | temporarily hidden from the portal |

- State is written in `var/health.json`'s `downSince`, `notified`, `hiddenAt`, `hiddenReason`; each notice sends once.
- When the same id is re-issued (manifest `since` changed), the old state is voided, not inheriting hide flags or disconnect timers.
- Hiding is `health.hidden` in `buildHubData`'s output, **does not change `instances.json`**, and does not touch the instance's own data.
- Without SMTP it still writes status, with the log noting mails not sent.
- `node ops/watch-health.mjs --dry-run` only probes and prints, writing no status and sending no mail.

Unit files: `ops/xknot-health.service` (oneshot) and `ops/xknot-health.timer` (`OnBootSec=2min`, `OnUnitActiveSec=15min`). Install:

```bash
sudo install -m 644 ops/xknot-health.service ops/xknot-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xknot-health.timer
systemctl list-timers xknot-health.timer
```

### 5.2 Manual execution

```bash
cd xknot.si
npm run probe                # probe only, write var/health.json
node ops/watch-health.mjs    # probe + mail + write status
node ops/watch-health.mjs --dry-run   # preview, no write
npm run build                # probe and build
npm run build -- --offline   # skip probing, reuse the last result
```

## 6. Data fetch

M2's two steps both run at build time, entered at `ops/fetch-cards.mjs` and `ops/fetch-stats.mjs`:

- Reads `instances.json`, only processes entries with non-empty `cardsUrl` / `statsUrl`, skipping non-active ones.
- Runs URL checks and content cleaning per [FEDERATION.md](FEDERATION.md) sections 5.6, 6.6.
- Validates `formatVersion` (showcase), card count, field lengths, image hosts, and count types.
- Carries the previous `ETag`; on `304` the file is untouched.
- Fetches with a bounded fan-out and a per-round budget: at most four partners in flight, and a whole round gives up after 90 s. A partner still unanswered when the budget runs out is recorded as `skipped budget` and picked up next round; the round still returns every other result instead of being killed by the oneshot timeout. `--budget-ms` overrides it (`0` means no limit).
- On success atomically overwrites `var/cards/{id}.json` or `var/stats/{id}.json`, on failure keeps the previous copy.
- Same step as the health probe; `--offline` skips both together.

The display side reads these two directories: `ops/cards.mjs` and `ops/stats.mjs`, so each instance in `hub.json` gains a `cards` array and a `stats` object. The page shows only the first showcase and at most two counts; an entry without `stats` shows "not shared", not 0.

## 7. Run and deploy

The project develops, builds, and previews on this machine, without bot01 and without any relay machine.

### 7.1 Local

```bash
cd xknot.si
npm run dev      # API 5181 + dev server 5180, /data/hub.json computed live
npm run api      # API only
npm run build    # output web/dist, including data/hub.json
npm run preview  # preview the build output (run inside web/)
```

`web/dist` is the complete static site: `index.html`, three locale directories, `assets/`, `data/hub.json`. Member login, the application API, and the console need `server/`'s API process; to just see the layout, the static site alone suffices.

### 7.2 Static hosting (optional)

Only needed for a public domain. The portal requires no specific host; any server serving static files works:

- Root points to `web/dist`.
- `/` 302s to `/en/`, or just place a redirecting `index.html`.
- `/assets/` long-cache, `/data/hub.json` uses `no-cache`.
- `/api/` and `/admin/` reverse-proxy to `127.0.0.1:5181` (the API only listens on the loopback, do not expose the port directly).
- `ops/xknot.si.conf` is a reference nginx config.
- Certificates are managed by Certbot; do not change the `ssl_certificate` config.

API process environment variables:

| Variable | Default | Notes |
|------|------|------|
| `XKNOT_API_PORT` | `5181` | listen port |
| `XKNOT_API_HOST` | `127.0.0.1` | listen address, do not change to `0.0.0.0` |
| `XKNOT_DATA_DIR` | `var/` | database file, session secret |
| `XKNOT_INSTANCES_FILE` | `instances.json` | manifest path. Local integration and end-to-end point at a temp manifest; the API, the console's "edit", and `admin-cli` (including `publish`) all honor it, not touching the repo's instance table |
| `XKNOT_FEDERATION_FILE` | `federation.json` | roster path. The overview's per-instance account config reads from here; the console's "edit" and `admin-cli publish --tunnel-account/--tunnel-port` write back to this file; cached by `mtime`, no restart after change |
| `XKNOT_SESSION_SECRET` | auto-generated | written to `var/session-secret` on first start, `0600` |
| `XKNOT_SECURE_COOKIE` | off | production sets `1`, session Cookie gains `Secure` |
| `XKNOT_TRUST_PROXY` | off | production sets `1`, rate limiting takes the last `X-Forwarded-For` address (the real source appended by nginx), not the forgeable first address |

Mail is optional; without it no mail is sent:

| Variable | Default | Notes |
|------|------|------|
| `SMTP_HOST` | (empty) | SMTP host. Mail enables only with both `SMTP_HOST` and `MAIL_FROM` set |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | off | 465 implicit TLS writes `1`; 587 STARTTLS keeps `0` |
| `SMTP_USER` | (empty) | SMTP username. Aliyun DirectMail requires it to match the sending address |
| `SMTP_PASS` | (empty) | SMTP password |
| `SMTP_FROM` | (empty) | sending address |
| `MAIL_FROM` | (empty) | sending address, takes precedence over `SMTP_FROM` |
| `XKNOT_ADMIN_EMAIL` | (empty) | recipient for new applications and ops notices; empty means console-only |
| `XKNOT_PUBLIC_ORIGIN` | `https://xknot.si` | the portal address for links in mail and pages |
| `XKNOT_MAIL_REPLY_TO` | from `MAIL_FROM` | partner mail's `Reply-To`; default `no-reply@xknot.si` |
| `XKNOT_SUPPORT_URL` | (empty) | optional contact entry in partner mail; empty omits the line |
| `XKNOT_RELAY_ENABLED` | follows SMTP | relay-only switch: on when SMTP is configured, `0` turns off relay alone (it does not lock the console's master switch; the panel says so) |
| `XKNOT_RELAY_DAILY_LIMIT` | `50` | per-credential 24-hour send cap |

Production puts the password in `/opt/xknot/var/mail.env` (`0600`), read by systemd's `EnvironmentFile`, not written into the unit. `npm run mail:test -- <recipient>` sends a test mail with the same env vars; `admin-cli` and `mail:test` read the same `var/mail.env` when the current environment has no `SMTP_HOST` / `MAIL_FROM` (explicit variables are not overridden), so the terminal does not need `set -a; . ...` first.

The API has no external dependency; Node 26's `node:sqlite` suffices, and the root still needs no `node_modules`; the SMTP client uses `node:net` / `node:tls`, also no new dependency.

### 7.3 Sync to the hosting directory (optional)

After the build, to sync if needed:

```bash
XKNOT_HUB_SSH=user@host ./xknot.si/ops/deploy-hub.sh --dry-run
XKNOT_HUB_SSH=user@host ./xknot.si/ops/deploy-hub.sh
```

`XKNOT_HUB_SSH` is required, the script hardcodes no host; `XKNOT_TARGET` (default `/var/www/xknot`) and `XKNOT_SSH_KEY` are overridable. This step is initiated directly by the machine running the build, unrelated to bot01.

The API, console, and site config use `ops/deploy-api.sh`, likewise honoring only `XKNOT_HUB_SSH`:

```bash
XKNOT_HUB_SSH=user@host ./xknot.si/ops/deploy-api.sh --dry-run
XKNOT_HUB_SSH=user@host ./xknot.si/ops/deploy-api.sh
```

It syncs `server/`, `admin/`, `docs/`, and manifest-validation dependencies, installs the nginx config and systemd units, `nginx -t` then restarts the API and reloads nginx. Static site and API deploy separately, not overwriting each other.

### 7.4 Update flow

Manifest or text changes:

```bash
cd xknot.si
npm run build     # validate, probe, build, write snapshot
npm run test
# sync dist when going public
```

Rollback: check out the previous `instances.json`, `web/src`, and `var/`, then rebuild.

### 7.5 Sharing the sending address with partners

This is the **fallback path**: an instance that sends with its own SMTP. By default an instance hands its mail to the hub over relay (contract in [FEDERATION.md](FEDERATION.md) section 7) with the access material's `XKNOT_HUB_RELAY_TOKEN`; then the sender is the hub's `MAIL_FROM` and `Reply-To` comes from the instance profile, so none of the settings below are needed.

For an instance that wants its own SMTP, the hub uses one sending domain (currently `xknot.si`) and creates one sending address per instance, e.g. `knot-wang@xknot.si`, `knot-travel@xknot.si`. Each sending address sets its own SMTP password; when a partner leaves, delete the address or change the password, without affecting other instances.

The partner fills the following into their own instance's mail config (with `knot-platform`, `sites/<site>/platform.env`). `SMTP_HOST` follows the Aliyun console region: East China `smtpdm.aliyun.com`, Singapore `smtpdm-ap-southeast-1.aliyuncs.com`.

```bash
SMTP_HOST=smtpdm.aliyun.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=knot-travel@xknot.si
SMTP_PASS='the SMTP password of that sending address'
SMTP_FROM=knot-travel@xknot.si
MAIL_FROM=knot-travel@xknot.si
KNOT_ADMIN_EMAIL=partner@example.com
```

- `SMTP_USER` must equal `SMTP_FROM`. The display name can be `MAIL_FROM="Knot · travel <knot-travel@xknot.si>"`.
- New addresses or just-changed SMTP passwords have about 10 minutes of propagation delay, during which `535 Authentication failure` returns; `SMTP_HOST`'s region must match the console.
- `xknot.si`'s MX already points to `mx01.dm.aliyun.com`, and this domain only sends; do not configure a corporate mailbox to receive on it, the MX will conflict. Replies use the partner's own mailbox.
- Only for login keys, access, and transaction notices; do not blast with it. One domain's sending reputation is shared; one instance's abuse affects all instances.
- Send quota, daily cap, and bounce handling follow the Aliyun DirectMail console; watch each address separately.
- The partner's own SMTP needs none of the `XKNOT_*` variables. Only relay does, and only two of them: `XKNOT_HUB_ORIGIN` and `XKNOT_HUB_RELAY_TOKEN` (section 7.2).

## 8. Acceptance

The manual acceptance items are listed by milestone below. The automatable part has landed in `e2e/`: how to start the stack locally, which case each item maps to, and what only a human can check are in [E2E.md](E2E.md).

M1:

- [ ] `https://xknot.si/` returns 302 to `/en/`
- [ ] `/en/`, `/zh-CN/`, `/zh-TW/` have identical content, differing only in language
- [ ] each page has the correct `lang`, `hreflang`, `x-default` pointing to `/en/`
- [ ] a block missing in all three languages is not rendered; no empty lines or key names
- [ ] each instance list entry has name, intro, local time, and a health dot
- [ ] the directory's time is the instance timezone's current time, not the visitor's local time
- [ ] clicking an instance on the map scrolls to the matching entry and highlights briefly; region-filtered instances dim but stay clickable
- [ ] the hub badge floats above the map, each instance has a dashed arc to it, and the arc takes that instance's colour at the instance end; the badge shows the xknot mark, still centered and not covering the map title
- [ ] between instances there are direct links taking one colour at each end, each site's neighbor count is 2, 3, or 4; refreshing keeps the same wiring
- [ ] "online only" leaves only `up` and `degraded`
- [ ] for a tunneled instance, the region matches `GET /api/locations`; after the tunnel drops, it falls back to the self-described `region`
- [ ] `/api/locations`'s response has no IP, only country codes
- [ ] stopping an instance, then rebuilding, turns its dot red and shows the last-ok time, other instances unaffected
- [ ] stopping an instance without rebuilding, waiting for the next patrol (15 min), then refreshing: the status follows, proving `/api/probes` overrides the snapshot
- [ ] adding one to `instances.json`, syncing `federation.json`, then rebuilding, the new entry appears, no code change
- [ ] `npm run validate:federation` returns 1 for missing roster, missing manifest, duplicate port, or no founder
- [ ] entries whose `status` is not `active` keep the previous result, not overwritten by probing
- [ ] region filter works by group, unknown countries fall to "other"
- [ ] the directory is a card grid: two columns wide, one narrow, equal-height cards, hover lifts and reveals the status color bar
- [ ] a card with a showcase shows one item (title, language code, updated X), clicking goes to that piece on the origin
- [ ] a card without a showcase shows no placeholder and writes no "none"
- [ ] the `showcase only` toggle appears only when showcases exist; on, only cards with showcases remain
- [ ] the page is readable and clickable at 360px, 390px, 768px, 1280px, 1440px, no horizontal overflow
- [ ] one screen two columns: white left / orange right wide, each scrolling; below 900px top-bottom, the masthead's `申请加入 →` jumps to the right column
- [ ] English text does not overflow buttons and status dots
- [ ] except the member login code, the portal makes no write request; the view sets no cookie
- [ ] the page only requests same-origin `/data/hub.json`, `/api/probes`, `/api/locations`, and `/api/member/*`, never partner sites directly
- [ ] `validate-instances.mjs` returns 0 for a correct manifest and 1 for a wrong one
- [ ] `validate-federation.mjs` returns 0 for a correct roster; 1 when the manifest has one more or the roster one fewer
- [ ] `federation.test.mjs` covers at least one founder, permanent accounts not delistable, unique accounts and ports, roster-manifest one-to-one

M2:

- [ ] the partner only changes `knot-cards.json` on their own site; after rebuilding, the portal shows the new showcase
- [ ] a failed fetch keeps the previous copy, the page shows "updated" the old time
- [ ] cards over 7 days gray, over 30 days the whole group hides
- [ ] image load failure shows a placeholder, not breaking the layout
- [ ] every card's link returns to the origin
- [ ] deleting `var/cards/{id}.json` delists the whole group
- [ ] at least one partner provides `statsUrl`; after build the card shows the "data shared by the partner" line
- [ ] missing `statsUrl` shows no such line and no 0
- [ ] when a partner's `statsUrl` returns bad JSON or a private address, the build continues and the previous copy is kept

Mail relay:

- [ ] `relay-token <instance>` prints the plaintext once; `relay-tokens` shows no plaintext
- [ ] send one test mail with that credential; the recipient sees `From` as `MAIL_FROM` and `Reply-To` as the instance's `contact`
- [ ] no credential is 401, forged credential is 401, revoked is 401
- [ ] instance not in the manifest or status not `active` is 403
- [ ] `to` with a display name, `subject` with a newline, `text` over 4000 chars are 400
- [ ] `replyTo` with an external domain is 400 `foreign_domain`
- [ ] over the daily quota is 429; the same `idempotencyKey` does not resend
- [ ] after `relay-disable <instance>` it is 403 `relay_disabled`; after `relay-enable` the same credential works immediately
- [ ] SMTP failure is 502, with one `failed` in `relay-log`, and the log has no body or full address
- [ ] no SMTP or `XKNOT_RELAY_ENABLED=0` is 503
- [ ] after the `/admin` master switch goes OFF: relay is 503, partner mail is not sent, `notify_log` gains nothing; switching ON restores immediately

M3: join application

- [ ] the instance `/admin` on-behalf submission returns per-field error codes for missing fields; `mode` not `subdomain` or non-empty `domain` returns `400 not_supported`
- [ ] subdomain under 6 chars, reserved, or malformed gives the same codes as the precheck (`too_short` / `reserved` / `format`)
- [ ] successful submission returns an id of the form `XK-YYYY-XXXXXX`
- [ ] resubmitting the same subdomain is 409, no new record
- [ ] a filled honeypot returns 201 but is not stored
- [ ] unauthenticated `/api/admin/applications` is 401
- [ ] after console login the application is visible, status directly `approved`, `reviewed_by` is `auto`, and there is no review action
- [ ] in the overview, clicking an instance expands its config in place without leaving the site; clicking "edit" changes and writes back both JSON files, illegal values return 400 with the files unchanged
- [ ] an approved application generates a manifest entry, `validateInstance` has no error
- [ ] `publish` writes back `instances.json`; with `--tunnel-account/--tunnel-port` it also writes `federation.json`, and after `validate:federation` passes and rebuild, the entry appears in the map and directory
- [ ] applications and accounts survive an API restart
- [ ] cross-site POST is 403; consecutive submissions trigger 429

## 9. Join application and auto-approval

Submission is approval, but it does not enter the manifest directly. Three roles are independent: the instance submits on behalf, the platform auto-approves, and the worker connects it and rebuilds.

### 9.1 Data

`var/xknot.db` (SQLite, WAL):

| Table | Content |
|----|----|
| `applications` | application: name, subdomain label, operator, email, region, timezone, intro, tags, status, case key, state version, approval record (`reviewed_at` / `reviewed_by`; the `mode` / `domain` columns are kept) |
| `admins` | admins: username, scrypt password, creation time, last login |
| `sessions` | sessions: token SHA-256, admin, expiry |
| `events` | audit: submit, withdraw, create account, delete account, credential issue and revoke |
| `claim_tokens` | one-time claim tokens: SHA-256, application, handoff content, issue/expiry/use time and revocation time (reissuing the handoff retires the old link) |
| `notify_log` | send records: event, case, state version, locale, recipient domain, address hash, template version, Message-ID, result; no body. `error` keeps the SMTP verdict code (`421 4.7.28`, `550 5.1.1`, `smtp_timeout`), not the server's wording |
| `relay_tokens` | relay credentials: instance, label, token SHA-256, daily cap, issue and revoke time |
| `relay_switches` | per-instance relay switch: off only pauses acceptance, credential kept, `relay-enable` restores |
| `relay_log` | send records: instance, recipient domain, address hash, subject length, Message-ID, result; no body |
| `member_codes` | member login codes: email, instance, code SHA-256, issue/expiry/use time, attempt count |
| `member_sessions` | member sessions: token SHA-256, email, instance, issue and expiry |
| `provision_runs` | automatic provisioning run records: application id, the whole run's JSON (status, per-step state and error codes, entry host, account, port), create and update time; one row per application, whole-row overwrite on each advance |
| `settings` | hub runtime switches: `key` / `value` / who changed it / time. Currently only `mail` (`on` / `off`). No row means the env-var default; deleting it restores |

Application state and transitions:

```text
submit ──▶ approved ──▶ withdrawn
```

`approved` only means "application passed, eligible for listing", unrelated to whether the instance is connected. `rejected` / `expired` are kept read-only. Resubmitting the same address while `approved` returns `409 duplicate`; after withdrawal it is allowed, and adding services or changing the label requires a new application.

The application receives one address field: the `subdomain` label (**6–32 chars** lowercase letters, digits, hyphens, reserved names not issued), and `url` is built from it as `https://<label>.xknot.si`. Labels under 6 are never issued. `mode` accepts only `subdomain` and `domain` must be empty: `mode` not `subdomain`, or non-empty `domain`, both return `400` with field code `not_supported`. An illegal `subdomain` gives the same codes as the precheck: `required` / `too_short` / `too_long` / `format` / `reserved`. Ownership verification does not apply: before issuance there is no verifiable domain, and acceptance is the post-connection public `/api/health` probe.

The portal's right column no longer takes an application form. Visitors see "log into your XKnot" and the four-step join guide: deploy instance → open `/admin` → pick a subdomain in the instance and submit → submission is approval. The application form is submitted by the instance's own admin page; the hub side's validation, dedup, and auto-approval flow is exactly the same.

The end of the right column's "how to join" states the operator's name and email (`web/src/lib/contact.js`, default `PaulWang` / `manwjh@gmail.com`, overridable before build with `VITE_XKNOT_OPERATOR_NAME`, `VITE_XKNOT_OPERATOR_EMAIL`). On submission the applicant gets the approval letter and `XKNOT_ADMIN_EMAIL` gets a new-member alert.

### 9.2 Endpoints

| Method and path | Permission | Notes |
|------------|------|------|
| `POST /api/applications` | public | submit application, 201 with id; field error 400 with `fields`; rate limit 429 |
| `GET /api/subdomains/check?label=` | public | whether a label can be issued: `{ label, available, reason, min, suggestions }`; `reason` is `too_short` / `too_long` / `format` / `reserved` / `taken` / `ok`; 30 per minute per IP |
| `GET /api/locations` | public | each instance's observed region: `{ generatedAt, locations: { <id>: { country, at, source } } }`; country code only, no IP; without observations `locations` is empty and the page falls back to the self-described `region` |
| `GET /api/probes` | public | each instance's current probe result: `{ checkedAt, probes: { <id>: { status, latencyMs, version, lastOkAt, downSince, hidden } } }`; status only, no `checks` / `ok` / `notified` ops fields; before any probe result, `probes` is empty. The page uses it to override the snapshot's `health` |
| `POST /api/member/code` | public | the member's email receives a one-time auth code (6 digits, 10 minutes, single use). Non-members also get 202, only members receive the mail; 3 per email per 10 minutes, 10 per IP per hour |
| `POST /api/member/session` | public | `{ email, code }` exchanges a session, sets the 30-day `xknot_member` Cookie, returns `{ session, overview }`; wrong code is 401 `invalid_code` (`reason` is `mismatch` or `expired`), 5 wrong attempts on one code is 429, 12 per IP per 15 minutes |
| `GET /api/member/session` | member session | current member and site overview: name, address, listing status, probe result, activity counts, showcase count |
| `POST /api/member/logout` | member session | delete the current member session |
| `POST /api/admin/login` | public | username + password, sets the `xknot_admin` Cookie on success |
| `POST /api/admin/logout` | session | delete the current session |
| `GET /api/admin/session` | session | current admin |
| `GET /api/admin/overview` | session | overview summary: instances and per-account config, probes, application records, 24h mail, and recent events; each instance carries `location` (observed location, `{ country, at, source }` or `null`), side by side with the self-described `regions`. `mail` reports separately `switch` (`on` / `off`), `configured`, `enabled` (whether sending now); `relay.envOff` means the env var turned off relay alone |
| `GET /api/admin/instances/:id/traffic` | session | one instance's entry traffic: the last 30 days of daily aggregates (requests, bytes, status, cache, latency, upstream, daily unique visitors, bot share, search crawlers, paths fetched by those crawlers, search referrals, top paths, top referer hosts); an id outside the manifest is 404; empty `days` means not collected yet |
| `GET /api/admin/hub/traffic` | session | the portal's own entry traffic, same daily shape as an instance; reads `var/traffic/hub.json`, falls back to the roster's `hub` for the hostname; empty `days` means not collected yet |
| `POST /api/admin/mail` | session | mail master switch: `{ enabled: true \| false }`, writes `settings.mail` and takes effect immediately |
| `POST /api/admin/instances/:id/config` | session | change instance config: `{ instance, member }` two patches, whole-file validation then atomic write-back to `instances.json` and `federation.json`; illegal returns 400 + `fields[]` |
| `GET /api/admin/applications?status=` | session | list and per-status counts (`approved` / `withdrawn` / `rejected` / `expired`) |
| `POST /api/admin/applications/:id/notify` | session | resend a partner event (`event` from PARTNER-MAIL.md); `partner.handoff` is excluded, it has no link to resend and returns 409 `use_handoff` |
| `POST /api/admin/applications/:id/handoff` | session | signs a one-time claim token and sends the handoff mail, returns `claimUrl`; a reissue retires the link in the previous mail (`claim.revoked` reports how many), and with no usable channel it is 503 `mail_unavailable` with no token left behind |
| `GET /api/admin/notify-log?limit=&case=` | session | send log |
| `GET /api/admin/applications/:id/manifest` | session | generate the manifest entry, self-check after generation, illegal returns 422 |
| `GET /case/:caseKey` | public | case page: status, public key, withdraw |
| `GET /api/case/:caseKey/progress` | public | connection progress: `{ application, issued, run, handoff }`; `run` gives the status and per-step items, `handoff { host, account, port }` only after the node data is ready (`awaiting_tunnel` / `active`), otherwise `null`; the case key is itself the credential, 60 per minute per IP |
| `POST /api/case/:caseKey/{withdraw,public-key}` | public | case page actions; success 303 back to the case page |
| `GET /claim/:token` | public | claim page; renders only the button, does not consume the token |
| `POST /api/claim` | public | consume the claim token, plaintext returns this once only |
| `POST /api/federation/mail` | credential | relay one plain-text notification for an instance; field error 400, quota or frequency over 429, SMTP failure 502 |
| `GET /api/federation/mail` | credential | query that credential's 24-hour quota |

`/case/`, `/claim/`, and the matching `/api/` writes have `access_log` disabled in nginx: the link is itself a capability credential. Neither page executes scripts, all variables are escaped, and responses carry `no-store`, `no-referrer`, `X-Robots-Tag: noindex`.

Mail relay:

- Credentials are issued by command line: `npm run admin -- relay-token <instance> [--label text] [--daily 50]`. The plaintext prints once, only SHA-256 in the DB.
- **Default on**: the access material generated by `access` already carries a credential; the node writes it along the existing path and restarts the Backend, **no node code change** (it reads `XKNOT_HUB_RELAY_TOKEN` from the environment). Only a pure-SMTP access material adds `--no-relay`, which also revokes that instance's old credential.
- The access material the instance wants is generated by `npm run admin -- access <application id> --id <instance> --out <file>`: the instance id, the hub address, the four issued fields (address, date, tier, status), and one relay credential (send address derived from the hub address). Format and keys in [FEDERATION.md section 7.4](FEDERATION.md#74-access-material); what filename and directory the instance stores it under is its own business. Site topology does not enter this file, so deployment and access do not entangle. It can be issued while the manifest `status` is `pending`: the partner starts the tunnel precisely with this access material before acceptance; it is no longer issued after suspension or exit.
- Three switches: the `/admin` mail master switch stops every kind of mail at once; hub-wide `XKNOT_RELAY_ENABLED=0` is 503 for relay only; per-instance suspend is `relay-disable <instance> --note reason` (`403 relay_disabled`, `relay-enable` restores, credential untouched).
- Revocation by credential id, or by instance id revoking all of that instance's credentials: `npm run admin -- relay-revoke <id|instance>`. Revocation is irreversible; the instance must get a new access material.
- Only `Authorization: Bearer` is recognized, no Cookie; the instance must be in the manifest with `status: active`.
- 6 per minute per credential, default 50 per 24 hours; 240 per hour site-wide.
- Plain text only, sender always `MAIL_FROM`; `Reply-To` must fall within the instance's own domain, `contact` when omitted.
- Records keep only recipient domain and address hash, queryable via `relay-log`; 30 days by default.
- Without `SMTP_HOST` / `MAIL_FROM` or with `XKNOT_RELAY_ENABLED=0`, the endpoint returns 503.

Mail notifications:

- On submission two mails go out immediately: `partner.approved` to the applicant (address, tier, and the case page link), and `internal.application_new` to `XKNOT_ADMIN_EMAIL`. Internal alerts cap at 30 per hour; over it, stored but not sent.
- Later by event: issuance `partner.issuance`, handoff `partner.handoff`, live `partner.live`, suspend / retire / disconnect / contact revalidation, etc. No review-result mail and no email-verification mail.
- The send idempotency key is `{event}:{caseId}:{stateVersion}`, `+1` on every state transition; the same event is not resent. Manual `notify` is an explicit resend, allowed once more.
- Partner mail's `Reply-To` is `no-reply@xknot.si`, the body states replies are not monitored; only internal mail points `Reply-To` at the applicant.
- A send failure only writes the process log and `notify_log`; submission still succeeds; without `SMTP_HOST` / `MAIL_FROM` it silently skips.
- Rate limiting: 12/day per recipient address, 30/day per domain, 200/day site-wide; over the cap records `throttled`, resendable via `admin-cli notify`.

Partner-side events, recipients, trilingual full text, and sending rules follow [PARTNER-MAIL.md](PARTNER-MAIL.md).

Receive-side rules:

- Body cap 16KB, JSON only; a POST whose `Origin` and `Host` disagree returns 403.
- Field caps match the self-described zone: name 2–40, intro 60, operator 80, email 120, tags 9 (each 16 chars).
- Subdomain labels accept only lowercase letters, digits, hyphens, 6–32 chars; `mode` not `subdomain` or non-empty `domain` returns `400 not_supported`.
- The submission request has one hidden field (`website`); filling it marks the submitter as a bot: return success, no storage.
- Rate limiting counts by source-address hash in-process: submissions 8 per hour, logins 12 per 15 minutes.
- Passwords use `scrypt` with salt; session tokens are 32-byte randoms, only hashes in the DB, Cookie `HttpOnly`, `SameSite=Strict`, `Path=/`.

### 9.3 Console

`/admin/` is a static page that does not participate in the build:

- After login the default is the **overview**: four numbers (instances, approved applications, 24h mail, relay mail), the instance and probe list, application records, and recent events. Data from `GET /api/admin/overview`.
- The top of the "mail" panel is a **mail master switch** (`role="switch"`, ON / OFF). One click goes through `POST /api/admin/mail`, writes into the `settings` table (`mail=on` / `mail=off`), effective immediately, no restart:
  - OFF: partner mail, internal alerts, and member login codes no longer send, and `/api/federation/mail` returns `503 relay_unavailable` for every instance (their login keys stop delivering along with it). Credentials, quota, and history are untouched; one more click restores.
  - While stopped, no new mail is accepted and `notify_log` is not written: after turning it back on the same thing can be resent without the dedup key treating it as "already sent".
  - Without SMTP configured the switch is disabled, prompting to fill `SMTP_HOST` and `MAIL_FROM` first.
  - The env var `XKNOT_RELAY_ENABLED=0` is a different, relay-only gate: when the master switch is on, the panel adds "relay requests from nodes still return 503", not pretending relay is fine.
  - The command line follows the same row: with the master switch off, `admin-cli notify / handoff / live` error out directly, avoiding "stopped in the UI but the terminal sent another".
- An instance row shows name, address, tier, online/offline/never-probed, latency or disconnect duration; instances with a showcase or activity data carry a mark.
- Clicking a row expands that account's config below, without leaving the site: roster identity, standing, tunnel account and port, manifest listed, join time, timezone, language, operator, owner, contact email, public address, probe address, showcase and stats entries, and the roster note. Address-type fields give separate links; leaving the site is an explicit action, and clicking the whole row only expands.
- The identity fields in the config come from `federation.json`, the address-type fields from `instances.json`; both read by file `mtime`, so a refresh of the overview after a change is enough, no API restart. An instance in the manifest but not the roster shows "not in the roster".
- After expanding, "edit" changes the config in place without leaving the page: the manifest side's public address, tier, status, join time, showcase and stats addresses, and the roster side's domain, role, standing, tunnel account and port, whether listed, and note. Name, intro, region, timezone, contact are not changed here — that is the instance's own self-described zone, owned by its `/admin`.
- Saving goes through `POST /api/admin/instances/:id/config`: first the whole thing runs `validateInstances` and `validateRoster`, and only on pass writes back the two JSON files via temp file + rename; on failure the errors list in the form, input is kept, and not one byte of the files changes. Access mode is not changed from the form: `mode` is fixed `subdomain`, and `tunnel` must fill account and port together.
- For an account not yet in the roster, the form adds a member with default identity (`role: partner`, `standing: regular`, `mode: subdomain`, `listed: true`, `tunnel` from the form's account and port); the whole file is validated before saving, and turning one into a `founder` requires `permanent` and listed. Tier is not the roster's business: a founder can be `free`.
- Application records list counts for the two states the submission flow can produce (`approved`, `withdrawn`), and clicking a row switches to that category; "approved but not written into the manifest" is flagged separately. Rows still carrying a pre-auto-approval status (`rejected`, `expired`, …) are shown under "all" with their own badge; they get no queue entry of their own, because nothing can create them any more.
- "Application records" is split by status (approved, withdrawn, all), left list, right detail.
- Details show site, operator, email, region, timezone, intro, tags, tier, public key, and submit time; the "approval" column states `submission is approval`.
- **No review action**: submission is approval. To stop a member, change its instance's `status` (suspend / retire).
- You can "generate" the manifest fragment, to paste into `instances.json`, or write it directly by command line.

### 9.4 Writing into the manifest

```bash
node server/admin-cli.mjs publish XK-2026-XXXXXX \
  --tunnel-account knot-tunnel-cpswang --tunnel-port 18090
node server/admin-cli.mjs publish XK-2026-XXXXXX --id custom-slug \
  --tunnel-account knot-tunnel-custom --tunnel-port 18091
```

`publish` only accepts `approved` applications, derives the `id` from the site domain (punycode and illegal chars fall back to `node-...`), fills the manifest's required fields, self-checks with the same pre-publish `validateInstance`, then writes back to `instances.json`. An existing same address or same `id` is refused.

With `--tunnel-account` and `--tunnel-port`, the same command also writes `federation.json`: `host` from `url`, `role` default `partner` (`--role founder`), `standing` default `regular` (founder auto `permanent`), `mode` always `subdomain`, `listed: true`, `note` overridable via `--note`. Both files pass `checkManifestEntry` and `validateRoster` before landing, temp file then rename. Writing only the manifest and not the roster still fails `npm run validate:federation` with "the instance is not registered in federation.json".

The API caches and re-reads the manifest file by `mtime`; after `publish` adds an entry or changes `status` to `suspended`, the next relay request takes effect immediately, no process restart.

Generated entry defaults:

| Field | Value |
|------|------|
| `tier` | `free` |
| `status` | `pending` (auto `active` by `xknot-provision` after acceptance) |
| `since` | the approval day |
| `id` | derived from the site domain |

The manifest entry has only these five (`id`, `url`, `since`, `tier`, `status`). Name, intro, `region`, `timezone`, `tags` are not written into the manifest: they are in the instance's own `sites/<site>/profile.json`, shown by the portal after fetching the copy by address. Changing the manifest does not change these fields, and changing the profile does not resend the manifest.

The manifest has no probe-address field: it is always `url` + `/api/health`. At listing, `status` is `pending`, not probed and not on the portal; after acceptance it becomes `active`.

Approval does not auto-launch or auto-deploy. What comes after writing the manifest — waiting for the tunnel, the probe passing, changing to `active`, flipping the roster's "awaiting connection acceptance" to "connected", and recomputing the portal snapshot — are all done by `xknot-provision` and `xknot-republish.timer`, no manual build. The only manual step is pulling the newly added entry back to the repo (`deploy-api.sh --pull-manifest`).

An accepted node is not left alone after that. Every round the worker also checks two things: whether its manifest entry is still `active` (`deploy-api.sh` overwrites the hub's `instances.json` with the repo copy, which may still say `pending`), and whether the roster's "awaiting connection acceptance" should become "connected". When the entry disappears from the manifest entirely, it restores it from the `provision_runs` record and logs `instance.manifest_restored`; the restored entry carries only what the application recorded, so tier falls back to the default, `since` becomes today, and a paid listing has to be set back by hand. Entries a human set to `suspended` / `retired` are not overwritten, only logged once. Entry conf and roster notes are reconciled on a 2-minute cadence; a static conf the partner pushed themselves is left untouched.

### 9.5 Backup and cleanup

`var/xknot.db` and `var/session-secret` must be backed up together with `instances.json`. The database is an ordinary SQLite file, copied on shutdown; under WAL mode copy `-wal` and `-shm` too, or run `sqlite3 var/xknot.db 'pragma wal_checkpoint(truncate)'` first.

`npm run test` covers submission-is-approval, duplicate, rate limit, cross-origin, login, manifest generation, logout, and mail notification; tests use an in-memory DB and a local fake SMTP, not touching `var/` and sending no real mail.

### 9.6 Member entry

The portal right column's first item is "log into your XKnot": the member fills the email confirmed at onboarding, receives a 6-digit auth code, and exchanges a 30-day `xknot_member` Cookie. No password and no registration entry — only applications already approved, with the site already in the manifest, are recognized.

After login it is read-only, showing four things, all from the hub's existing copies, never reverse-requesting the instance for the login:

| Item | Source | Notes |
|----|------|------|
| listing status | `instances.json`'s `status` | `pending` is awaiting acceptance, `active` is listed |
| health | `var/health.json` | status, latency, last-reachable time |
| activity counts | `var/stats/{id}.json` | post total and 24h count, account count; "not yet" if never reported |
| showcase | `var/cards/{id}.json` | count |

Two boundaries:

- For non-members, `/api/member/code` also returns `202` and sends no mail. This endpoint must not become a "is this email a member" probe.
- After a site is removed from the roster, the old session is deleted on the next `GET /api/member/session`, returning 401 rather than a frozen data set.

The auth-code mail does not enter `notify.mjs`'s event table: that table is for events resendable by the onboarding flow, and the login code is triggered only by the login action and should not appear in the resend list. Text in `server/member-mail.mjs`.

## 10. Operations

Scheduled tasks (all on the hub host, installed and enabled by `deploy-api.sh`):

| Unit | Cadence | What it does |
|------|--------|--------|
| `xknot-health.timer` | 15 minutes | probes all instances, writes `var/health.json`; consecutive-disconnect mail, 7-day hide |
| `xknot-traffic.timer` | 1 hour | entry access log → `var/traffic/{id}.json` |
| `xknot-republish.timer` | 10 minutes | recomputes `/var/www/xknot/data/hub.json`: new nodes, profile revisions, health, and traffic all reach the page through it |

The resident `xknot-provision` (20-second rounds) is not in the table: it advances provisioning, changes to `active` after acceptance, and triggers one snapshot recompute on the spot.

After a `reload` you must re-read `/var/log/nginx/error.log`. The master rejects, wholesale, changes it cannot judge itself — a shared-memory zone's key changed, e.g. `limit_req_zone`'s key switched from `$binary_remote_addr` to a `map`-derived variable — in which case the old config keeps running while `systemctl reload` still returns 0 and `nginx -t` still passes (it starts a separate process to parse, legal on that path). `server/provision.mjs`'s `reloadNginx()` and `deploy-api.sh` both diff the log after reload and `restart` on a new `[emerg]`; when the log cannot be read they do not guess, and pass it by `nginx -t`. The 2026-10-23 rate-limit fix was missing exactly this step, taking effect on disk but not in the running state for three days.

| Scenario | Action |
|------|------|
| add instance | approval → the resident `xknot-provision` runs `publish` (`status: pending`, manifest and roster together) → pre-staging (account, port, DNS, certificate, static page, conf, public key, `access` claim link) → exchange point A → `status` becomes `active` after acceptance, automatically → the portal snapshot recomputes. Order in [HANDOFF.md](HANDOFF.md) |
| suspend instance | change `status` to `suspended`, keep the last health result |
| instance offline | build-time probe failure shows `down`, decide deletion after 30 consecutive days |
| showcase violation | delete `var/cards/{id}.json`, remove `cardsUrl` from the manifest, rebuild |
| probe anomaly | check `var/health.json`'s `error` field: `timeout`, `redirect`, `bad_payload`, `http_<code>` |
| page anomaly | `npm run build` rebuilds `web/dist` |
| node online but no home-page card | first check whether `instances.json` has it `active`; then `systemctl status xknot-republish.timer` and `journalctl -u xknot-republish` (a snapshot rejected by the guard logs `snapshot rejected`); finally `curl -s https://xknot.si/data/hub.json \| grep <id>` |
| status not refreshing | first check `GET /api/probes`: it is the current value, and the page overrides the snapshot with it. Both consistent means the instance really is down; inconsistent means the API is down or the page cannot reach it; only an old value in the snapshot needs a rebuild |
| forgot admin password | `npm run admin -- list-admins` to see the accounts, then `reset-password <name>` (password from `XKNOT_ADMIN_PASSWORD` or prompted); it invalidates that account's old sessions. Deleting and recreating (`delete-admin`, then `create-admin`) also works but loses its create/last-login record |
| API down | check the process log; the DB file is in `var/`, a restart loses no applications |
| application flood | lower the rate limit or temporarily stop the submit endpoint; stored records are withdrawn or kept in the console |
| notification mail not arriving | `npm run mail:test -- <address>`; check `mail failed` / `mail retry in` in `journalctl -u xknot-api`, the `error` code in `notify-log`, whether the sending address has an SMTP password, and whether DNS SPF/DKIM/DMARC pass. `421` means the receiver wants us to slow down and the hub retries with backoff; `550` means address or content refused, retrying will not help |
| mail rate-limited | read `error` in `relay-log` / `notify-log`: `4.x.x` is receiver-side throttling (when a shared sending IP is damaged every instance suffers; wait or move to a dedicated IP), `5.x.x` is an address or content problem. Then check Aliyun DirectMail's daily quota and sending-address type; split sending addresses per site when sharing with partners |
| bounce (mail sent, then came back) | Aliyun accepted it with `250` and the receiver refused later; the hub cannot see that and `status` stays `sent`. Copy the Message-ID from the provider console's bounce report and mark it `npm run admin -- bounce '<Message-ID>' --note '<reason>'`. The `id=` at the end of each `notify-log` line is that id. Messages sent before 2026-10 carry no id and can only be judged by time and recipient domain. `xknot.si`'s MX only sends; do not receive bounces on this machine |
| region wrong or missing | first check `/api/locations`: empty means no observation and the page is using the self-described `region`. Check `journalctl -u xknot-provision` for "location collection skipped" (sudo permission) or "location resolution failed" (DB-IP unreachable); no id in `var/peers.json` means its tunnel is not connected right now. A resolved address caches 30 days; after changing broadband wait at most one expiry |
| inspect a determination by hand | `node ops/geoip.mjs --ip <address>`; to write back to the page use `node ops/geoip.mjs` (reads `var/peers.json`, rewrites `var/geoip/locations.json`) |
| console view location | open the instance; the "observed location" row gives the country code and determination time; when it disagrees with the self-described `region`, the collapsed row shows "location CN (profile SG)" |
| pre-staging stuck at a step | `journalctl -u xknot-provision` shows the error code and the next retry: failures back off 30 s / 2 min / 10 min / 30 min / 2 h, and `tls` stops after 5 consecutive failures as `failed` waiting for a human — retrying the certificate step only lengthens Let's Encrypt's failed-authorization limit. Once the cause is fixed, `npm run admin -- provision-retry <application id>` releases it; steps already done are not re-run |
| stuck at `awaiting_tunnel` | after 30 minutes it logs `instance.awaiting_stalled` (visible in the console's recent events). Usually the far side never came for its parameters: check the instance's `KNOT_XKNOT_POLL_SECONDS` (0 waits forever), whether `join.json` is still there, and whether the tunnel unit starts. The hub has the parameters ready and does not need the pre-staging re-run; `provision-retry` restarts the clock |
| clock wrong | first check whether the instance's self-described zone wrote `timezone`: if so it always follows that, GeoIP does not override; only when missing does it derive by country, and then the clock is coarse |

## 11. Node status and entry traffic

Monitoring has two layers: **collection is independent, display reads one document**. Health, tunnel peer, location, and traffic have very different cadences (15 min / 60 s / 60 s / 1 h); letting them race-write one file only introduces locks and overwrites, so there is no "single writing process".

### 11.1 Where the data comes from

| Field | Source | Cadence | Blind spot |
|------|------|------|------|
| `probe` | `ops/check-health.mjs`, probes `url` + `/api/health` | 15 min | HTTP only; TLS, DNS, ports not probed separately |
| `tunnel` | `ops/peers.mjs` reads the `ss`/`ps` peer | 60 s | the whole item fails when hub and entry are on different machines |
| `location` | `ops/geoip.mjs`, peer IP → country code | follows the peer | no tunnel, no observation |
| `traffic` | entry nginx access log, `ops/traffic.mjs` aggregates | 1 h | SPA in-page navigation makes no request; real visitors are only approximated |

`ops/node-status.mjs` merges the four into `var/status.json`: one node per entry, each field carrying its collection time. Any collection's end calls `refreshStatus()` to recompute, whole-file atomic replacement; last writer wins, worst case the snapshot is one cadence late. The console reads this one per node, no longer opening four files separately.

`manifest.status` and `probe.status` are two different things: the former is the hub's listing decision, the latter is that moment's reachability. When the former is `pending` / `suspended`, the latter may still be the previous result, so the color is combined by the console, not merged into one enum at the data layer.

### 11.2 Entry traffic

All subdomains' public traffic goes through one entry nginx — static served directly by it, API returning through the tunnel. There is one collection point, so this data needs no instance cooperation and no instrumentation.

The precondition is the entry having the log format installed: `knot-platform/ops/entry/log.conf.template` defines `log_format knot_json`, and `site.conf.template` writes one `access_log /var/log/nginx/knot-access.log knot_json;` per server block. It is installed once per entry host, by `push-entry.sh`.

The portal's own conf (`ops/xknot.si.conf`) carries that same line. Without it its server block inherits `nginx.conf`'s default `main` format, which records no `$host`: aggregation can then map nothing, `hub.json` is never written, and the hourly run still exits successfully — a silent hole rather than an error. Because it references a format declared by the entry, that conf depends on `knot-log.conf` being installed on the same host.

Subdomains issued by automatic provisioning do not go through `push-entry.sh`, so `server/provision.mjs` carries the set itself: `renderVhost` **declares** a per-subdomain unique format in each conf (`knot_json_<subdomain>`, dots written as underscores), then writes `access_log ... <that name>` in the 443 server. It does not share `knot-log.conf` because `conf.d/*.conf` includes by filename: the shared file sorts after `cpswang.xknot.si.conf`, where the `knot_json` it declares does not yet exist in that file, so `nginx -t` reports `unknown log format`. Missing this line leaves a new node's "entry traffic" as "never collected".

These confs are generated on a remote host whose only check is a single `nginx -t`, so their exact text is pinned as fixtures: `server/fixtures/{http-stage,entry-static,entry-proxied}.conf`, plus the placeholder page and the sshd block. `server/provision.golden.test.mjs` compares the whole rendering byte for byte and prints a line diff when they differ, so a template change shows up in review instead of arriving unannounced on the entry host. Changing one on purpose means `node server/fixtures/render-golden.mjs --write`, with that diff committed alongside the code.

- The query string is never logged: share tokens and search terms must not enter the log.
- `$host` is the only subdomain identifier, mapped to id by `instances.json` on the aggregation side; hosts outside the manifest are counted but not written.
- The portal is the exception: its hostname comes from `federation.json`'s `hub`, and it lands in `var/traffic/hub.json` under the fixed id `hub` (`hub` is a reserved subdomain label, so no instance can take it). The console reads it through its own endpoint, not as an instance. This is the bucket that answers whether the crawl entry (`/<locale>/instances/`, `/knot-help`) is being picked up at all.
- Raw logs rotate by the default `/etc/logrotate.d/nginx`, **7 days**; `var/traffic/{id}.json` keeps the latest **30 days**. Aggregation reads not only the current file but also the latest three days of rotated files (`.1`, `-YYYYMMDD`, and `.gz`), so the requests crossing midnight do not fall between two aggregations.
- The aggregated output has no IP and no full referer: IP is used only for same-day dedup, referer keeps only the hostname.
- Search crawlers and search referrals are split out of `botShare`: whole-UA matches for Googlebot, Bingbot, Applebot, Baiduspider, and YandexBot give `crawlers`, the paths they fetch give `crawlPaths`, and the status codes they get give `crawlStatus`; referer hostnames matching a search engine's own name give `searchEngines` (`google`, `bing`, `baidu`, `duckduckgo`, `yandex`, `sogou`), so `mail.google.com` does not count. Every other bot only counts toward `botShare`. UA can be spoofed, so these are observations of a self-declared identity with no reverse-DNS check; query terms never enter the log, so they are not available here.
- `bytes` is the compressed size sent to the client. A 304 has a 0 body, so read it together with `requests` and `cache`, not bytes alone.
- A request served directly by the entry has an empty `$upstream_response_time`; only ones that went through the tunnel have a value, kept separate.
- For whole-site reverse-proxied subdomains, the entry applies `proxy_cache` to `/assets/`: one zone per subdomain, 30 days, `use_stale` to ride out tunnel jitter. Filenames carry content hashes, so from the second visit the entry disk serves them directly, and the log's `cache` column is the hit state; statically served subdomains have this column always empty.
- The same zone also caches the page skeleton (`location /`, 10 seconds): `proxy_cache_background_update` serves the stale copy first after expiry and refetches in the background, while `use_stale` serves the previous shell when the tunnel drops. This is the static-serve tier's capability; without it, a tunnel hiccup blanks the whole page. The upstream sends `no-cache` for `index.html`, so here only `Cache-Control` and `Expires` are ignored, and responses carrying `Set-Cookie` still do not enter the cache.
- Uploaded files (`/api/web/uploads/`) are cached at the entry too, keyed by `$uri` alone and kept for 1 day. Nothing is ignored here: whether a file may enter the shared cache is decided by the backend's `Cache-Control` (public content is `public`; content only its owner may read is `private` and stays out). Same semantics as the statically served entry.
- Every upstream-bound location on the entry (`/api/`, `/api/web/uploads/`, `/assets/`, `/`) carries the same plumbing: `Connection ""` (without it the upstream keepalive is void and every request reopens a TCP through the tunnel), `proxy_send_timeout` (otherwise a large upload on a slow uplink is cut at the 60-second default), and both forwarding source headers. They come from one `proxyDirectives()` in `server/provision.mjs`, not four hand-copied blocks, and `provision.test.mjs` checks them per location — a new location must be added to that list.
- Cache zones and log formats are named per subdomain rather than shared: nginx allows one declaration per zone name, and a shared zone lets two sites' identical `$uri` keys collide in each other's cache. The `push-entry.sh` set uses a shared `knot_uploads` zone with a `$uri` key, which is fine for a few sites but should gain `$host` before the count grows.

### 11.3 Who owns an entry conf

A `<subdomain>.conf` on the entry has one of two authors, and the hub only rewrites its own:

| Author | Tell | What the hub does |
|---|---|---|
| Hub auto-connect | first line contains `由 auto-connect 生成，请勿手改` | verifies, rewrites when needed, reloads |
| Partner's own `push-entry.sh` | first line is `由 ops/scripts/render-config.mjs` | leaves it alone, keeps collecting health and tunnel, says so once in the log |

`switchEntry()` and the `vhost` / `tls` steps all read the existing file first and decide by `MANAGED_MARK`. Without that check `xknot-provision` would rewrite a partner's freshly pushed static conf back to whole-site proxy, so the two sides would overwrite each other and nobody could tell which one is live. A missing file (first provisioning) counts as "may create". Accepted nodes are reconciled every 2 minutes: `deploy-api.sh` overwrites the manifest, not this conf, so a faster round would only spawn a string of pointless sudo subprocesses.

To move from proxy to static serving, the partner runs `push-entry.sh` once and the hub steps aside; to move back, remove the conf and let the hub regenerate it.

```bash
npm run traffic                 # read the default log, write var/traffic, then recompute status.json
npm run status                  # recompute var/status.json only
node ops/traffic.mjs --log ./fixtures/access.log --out ./var/traffic
```

In production `xknot-traffic.timer` runs hourly; a missing log is quietly skipped, no empty result written. The service user must be able to read `/var/log/nginx/knot-access.log`; when the log is `0640 root:adm`, add the user to the `adm` group.

Traffic only enters the console (the instance row's "yesterday N · X", the expanded "entry traffic", and the portal's own panel on the overview), not `dist/data/hub.json`, not the member entry. The expanded panel reads the traffic endpoint live: a 14-day request chart, that day's details (requests, bytes, daily unique visitors, bot share, search crawlers with their failure count, latency, upstream, status, cache), and the top paths, referer hosts, paths fetched by search crawlers, and search referrals. Crawlers and referrals measure "was it fetched, how many visits came from search"; impressions and query terms only exist in the search engines' own webmaster consoles. Publishing a site's traffic outward needs the site owner's consent, not done for now.

### 11.4 Public snapshots on the entry disk

For a whole-site reverse-proxied instance, the first-screen data is `/discover.json`. On the entry nginx it is its own location: serve the file from disk when present, fall back to the tunnel otherwise.

- **Who writes it**: the hub's `ops/snapshots.mjs`, driven by the resident `xknot-provision` at `XKNOT_SNAPSHOT_INTERVAL_MS` (default 20 s, minimum 5 s). It routes through the tunnel to the instance (`127.0.0.1:<port>/api/web/board`), bypassing public DNS, TLS, and nginx, and needing no write access on the instance.
- **Whether to write**: it sends `If-None-Match`; an unchanged instance answers 304 and no body, and a changed body with the same digest is not rewritten. What sits on disk is change-driven, not visitor-driven.
- **Where**: `/var/www/<subdomain>/discover.json`, temp file then rename, mode 644. nginx may be reading that path at any moment; truncating in place would let a visitor read half a JSON document.
- **When the fetch fails**: keep the previous copy. Deleting the file because the tunnel blipped would 404 the first screen; seeing a new post tens of seconds late is much better. A failed write (missing directory, wrong permissions) is not retried on the 20-second cadence either: without a usable etag it has to refetch everything, so it waits 5 minutes.
- **The instance may stop offering it**: a `410` deletes the on-disk copy and lets nginx fall back to the tunnel. Serving stale content after public snapshots were turned off is the one failure this chain cannot tolerate. `410` and `404` must be told apart: `410` means the instance explicitly says "no public snapshot right now", `404` only means the path does not exist (an instance not yet upgraded), and the latter keeps the on-disk copy rather than throwing away usable data.
- **One interval late**: `/api/web/session` and `/api/web/home` carry the instance-side `boardVersion`, and the page only goes back to `/api/web/board` when that is newer than what it is showing.

`var/snapshots.json` keeps each subdomain's etag and digest, so a restart does not retransmit bodies. There is no console page for it: `journalctl -u xknot-provision | grep snapshot` shows how fetches are going.

At the moment of connect `ops/warm-entry.mjs` runs once: it fetches the home page and every `/assets/` file referenced from the HTML and stylesheets. The entry's asset cache fills on demand, and nobody has stored anything before the first visitor — and a personal site has no crowd to spread that first fetch.

### 11.5 Operations

| Scenario | Action |
|------|------|
| console has no traffic | `systemctl status xknot-traffic.timer`; `journalctl -u xknot-traffic` to see if it is "no access log" |
| traffic all 0 or no subdomains | whether the entry conf has `access_log ... knot_json_<subdomain>`, and the matching `log_format` in the same file; whether `nginx -t` passes. Automatic provisioning's conf carries both lines; manually written ones (like `wang`) use `knot_json` from `knot-log.conf`, which must sort before it by filename |
| one subdomain's number clearly too small | it may have taken the `proxy` serve mode with a high cache-hit rate; check `cache` and `upstream.requests`, not bytes alone |
| hosts outside the manifest have requests | check the entry conf's `server_name` and DNS; the aggregation log lists ignored hosts |
| tunnel always "disconnected" | whether `var/peers.json` has that id; if not, the tunnel is down, or the hub is not on the entry host |
| status.json not updating | all three chains recompute it: health patrol, provision worker, traffic aggregation. All stopped leaves only the CLI |
