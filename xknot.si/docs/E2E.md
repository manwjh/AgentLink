# Local Deployment and End-to-End Testing

This document explains how to run the full hub on this machine, and what the automated tests cover and do not cover.
The acceptance checklist is in [HUB.md](HUB.md) section 8; here we turn the automatable part of it into scripts.

## 1. Local deployment shape

In production there are two processes: the `systemd` `xknot-api` listening only on the loopback, and nginx serving the static site and reverse-proxying `/api/` and `/admin/` to it. Locally we split into two processes with the same division of labor:

```text
browser
  │  http://127.0.0.1:5190
  ▼
ops/local-hub.mjs        static site + reverse proxy + security headers (replicates ops/xknot.si.conf)
  │  /api/*  /admin/*
  ▼
server/index.mjs         127.0.0.1:5181, SQLite in var/e2e/<run>/data
```

`ops/local-hub.mjs` is not a production server, but it deliberately mirrors production behavior:

| Path | Behavior |
|------|------|
| `/` | 302 to `/en/` |
| `/en/`, `/zh-CN/`, `/zh-TW/` | directory index, `cache-control: no-cache` |
| `/assets/*` | long cache `max-age=31536000, immutable` |
| `/data/hub.json` | the snapshot the build writes, `no-cache` |
| `/admin` | 301 to `/admin/` (matches nginx's exact match) |
| `/admin/*` | reverse proxy, only adding HSTS and `X-Robots-Tag`; the API sends its own CSP |
| `/case/*`, `/claim/*` | reverse proxy to the API, adding `X-Robots-Tag: noindex`; the pages send their own CSP and `no-store` |
| `/api/*` | reverse proxy, adding server-level security headers and `X-Forwarded-For` (appended, not overwritten) |
| otherwise | 404; `..` and `%2e%2e` cannot escape `web/dist` |

One-shot start:

```bash
cd xknot.si
npm run deploy:local                 # validate → build → start API → start entry, 127.0.0.1:5190
npm run deploy:local -- --no-build   # reuse web/dist
npm run deploy:local -- --preview    # merge fixtures samples into the portal
npm run deploy:local -- --admin paul:correct-horse-battery
npm run deploy:local -- --port 8080 --data-dir /tmp/xknot
```

After start, the terminal prints the portal, console, API, and data directories. `Ctrl-C` stops both processes together.
Data lands in `var/local/` (`--data-dir` can change it), and is **not deleted**: after a restart the applications, send log, and relay log are still there. `5180/5181` are reserved for `npm run dev`; deployment defaults to `5190`.
End-to-end tests start their own random ports and temp directories, deleted when done.

### Test manifest coverage

The API reads the repo root's `instances.json` by default, and the roster reads `federation.json`. Local integration and end-to-end can point `XKNOT_INSTANCES_FILE` and `XKNOT_FEDERATION_FILE` at temporary copies; both the API and `admin-cli` (including `publish`) honor these variables, so the repo files are not modified. The console's "edit" writes back to whichever two files the API is reading, so the browser cases copy each manifest to a temp directory at startup and point to it via `node ops/local-stack.mjs --instances <file> --federation <file>`.

```bash
XKNOT_DATA_DIR=/tmp/xknot-data \
XKNOT_INSTANCES_FILE=/tmp/xknot-instances.json \
XKNOT_FEDERATION_FILE=/tmp/xknot-federation.json \
npm run api
```

## 2. Test layers

| Layer | Command | What it runs | Dependencies |
|----|------|--------|------|
| Unit | `npm test` | manifest and roster validation, page data, API and mail pure functions | Node, no network |
| API end-to-end | `npm run test:e2e` | real HTTP, real SQLite, real SMTP sessions, real CLI | Node + `web/dist` |
| Browser end-to-end | `npm run test:ui` | real Chromium running the portal, application form, console | Playwright + Chrome + `web/dist` |
| Full | `npm run test:all` | the three above in order | same |

Both end-to-end suites read the static site from `web/dist`; a clean checkout builds once first:

```bash
npm run build -- --offline   # skips partner probes, otherwise same as npm run build
```

Without `web/dist`, the local stack reports "run npm run build first" directly, rather than only failing on one assertion.

Browser tests need dependencies installed on first use:

```bash
npm --prefix e2e install
```

It uses the locally installed Chrome by default, downloading no browser. To use Playwright's own copy:

```bash
npm --prefix e2e run install:browser
E2E_CHANNEL= npm run test:ui
```

## 3. Isolation and fixtures

Each end-to-end file starts its own deployment, sharing no port, database, or rate-limit counters:

- Ports are kernel-assigned; the data directory is `var/e2e/<random>`, deleted on exit (`startStack({ keep: true })` can keep it).
- The API environment's `SMTP_*` and `XKNOT_*` are cleared and then injected per case, unaffected by the dev machine's shell.
- `DEFAULT_MANIFEST` provides two instances: `e2e-node` (active) and `e2e-paused` (paused), used to verify relay allow/deny.
- Browser tests use `--preview`: `fixtures/` sample entries, health status, showcase, and activity data merge into the current snapshot, with no external network or partner sites.
- Relay mail does not mock `mailer`: `e2e/smtp-sink.mjs` runs a minimal SMTP receiver, so `server/mail.mjs`'s full session (EHLO → MAIL FROM → RCPT TO → DATA) is exercised.
- Rate-limit cases live in their own file: the API counts by source address, with all requests in one process sharing one bucket.

## 4. Case list

### 4.1 Static site and snapshot (`e2e/api.e2e.test.mjs`)

- Root path 302s to `/en/`; all three locale entries open, with `lang` and `hreflang` consistent.
- HTML carries CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS.
- Hashed `/assets/` long-cache; HTML and `hub.json` revalidate every time.
- `hub.json` contains only manifest instances; without probe/showcase/activity data it is `null` and `[]`, not 0.
- Unknown paths, path traversal, and files outside the `/admin` whitelist are 404.

### 4.2 Application and auto-approval (`e2e/api.e2e.test.mjs`)

- Missing fields return per-field error codes; cross-site POST is 403; a filled honeypot returns 201 but is not stored.
- A valid submission is 201, with an id of the form `XK-YYYY-XXXXXX` and status directly `approved`; resubmitting the same subdomain is 409.
- After submission two mails arrive: the applicant gets the approval letter (address, tier, and the `/case/` link), the operator gets the new-member alert; the partner mail's `Reply-To` is `XKNOT_MAIL_REPLY_TO` (defaults to `MAIL_FROM`, i.e. `no-reply@<hub domain>`), and the body states replies are not monitored.
- There is no `/verify/` page and no `/api/verify` endpoint; an application never sits waiting for confirmation.
- `/case/<caseKey>` shows status, public-key submission, and withdrawal.
- Not logged in is 401, a forged cookie is 401, a wrong password is 401; the login cookie carries `HttpOnly`, `SameSite=Strict`, `Path=/`.
- The approved list shows the application, `reviewedBy` is `auto`; the generated manifest entry passes `checkManifestEntry`, defaulting to `tier: free`.
- The review endpoint is removed; calling it returns 404; the session is invalidated immediately after logout.
- `handoff` generates a one-time claim link: `GET /claim/<token>` does not consume it, `POST /api/claim` returns the plaintext only once, then 409; the mail body contains no credentials.
- Reissuing a handoff retires the link from the previous mail: it answers 410 and reveals nothing; `notify` refuses `partner.handoff`.

### 4.3 Partner onboarding (`e2e/partner.e2e.test.mjs`)

This file walks the whole path the way a partner would, with real HTTP, a real SMTP session, and real tokens recovered from the mail body — no reading the database and no test back door:

- submit → immediately `approved`, approval letter received, and no verification step anywhere.
- the `/case/` page shows status, accepts a public key, and after withdrawal refuses further review.
- `handoff` sends a one-time claim link; the mail body holds no credential plaintext.
- reissuing `handoff` revokes the previous link: it answers 410 and leaks nothing.
- the claim page only renders (`no-store`), consuming it must be `POST`, and the same token works once (the second `POST` is 409).
- the message after the first claim checks `/api/admin/applications/<id>/manifest` and asserts the entry is written as `pending`, with `url` and `id` derived from the subdomain label.

### 4.4 Mail relay (`e2e/relay.e2e.test.mjs`)

- A credential issued by the `admin-cli relay-token` command can send; the recipient sees `From` as `MAIL_FROM`, `Reply-To` defaults to the instance `contact`, and the message carries `X-XKnot-Instance`.
- `GET /api/federation/mail` returns the 24-hour quota; retrying the same idempotency key does not resend.
- Illegal fields are rejected per field: `to` with a display name, `subject` with a newline, `replyTo` falling to an external domain.
- Missing or forged credentials are 401; a suspended instance is immediately 403 (changing the manifest needs no restart); a revoked credential is 401.
- Per-instance switch: after `relay-disable` it is 403 `relay_disabled`; after `relay-enable` the same credential works again, no reissue or restart.
- Hub master switch: after `/admin` switches OFF (or `settings.mail=off`), relay and quota queries are 503 `relay_unavailable`, partner mail is not sent and `notify_log` is not written; switching back ON makes the same credential work immediately.
- Daily quota exhausted is 429; the 7th mail per minute per credential is 429.
- SMTP unavailable is 502, `relay-log` records `failed`, and the log contains no body or full address.

### 4.5 Rate limiting (`e2e/limits.e2e.test.mjs`)

- From the 9th submission per hour it is 429, with `retry-after`.
- From the 13th login per 15 minutes it is 429.

### 4.6 Browser (`e2e/browser/*.spec.mjs`)

| File | Coverage |
|------|------|
| `portal.spec.mjs` | renders all cards from `hub.json`, map visible, entries link back to origin; trilingual switching and `aria-current`; light/dark; region filter and "online only"; "showcase only"; no horizontal overflow at 360/390/768/1280; keyboard reachability and form labels; no script errors under CSP |
| `member.spec.mjs` | right column has only the email field and the four-step join guide, no application form; no request until the email is complete; after logging in with a code from real mail, see the site's status, health, and counts; no state leftover after logout; at 390px the two fields and login button are ≥44px and the right column does not overflow |
| `admin.spec.mjs` | login failure message; login → overview shows the four panels and the mail master switch (disabled without SMTP); open an approved application → generate manifest entry → logout; clicking an instance expands its config in place; in-place edit, illegal values not written, draft not lost; approved applications no longer offer an approve action and the list doesn't duplicate; a failed list read leaves an error bar and no stale rows; no script errors under CSP |

The console exposes stable hooks for these cases — `data-view` on the nav, `data-panel` on the overview panels, `data-status` on tabs, queue rows, and badges, `data-action` on the buttons each case drives. Copy changes then do not break the tests, and neither do the tests pin the current wording.

Browser cases also assert the page has **no** `pageerror` and no CSP violation. This assertion has caught two real classes of bug: inline styles blocked by the console CSP, and fonts inlined by Vite as `data:` then blocked by `font-src 'self'`.

## 5. Mapping to the HUB.md acceptance checklist

| HUB.md section 8 | Automated |
|----------------|--------|
| manifest/roster validation exit codes, roster rules | `npm test` (`ops/*.test.mjs`) |
| region filter, card grid, showcase toggle, `online only` | `portal.spec.mjs` |
| 360/390/768/1280 readable and clickable, no horizontal overflow | `portal.spec.mjs` |
| no write requests except the application; only same-origin data | `portal.spec.mjs` network and render assertions, CSP |
| application form per-field errors, id format, duplicate prompt | `partner.e2e.test.mjs`, `api.e2e.test.mjs` |
| unauthenticated 401, auto-approval and manifest entry | `api.e2e.test.mjs`, `admin.spec.mjs` |
| cross-site POST 403, consecutive submissions 429 | `api.e2e.test.mjs`, `limits.e2e.test.mjs` |
| credential issue/revoke, quota, idempotency, SMTP failure | `relay.e2e.test.mjs` |
| data survives API restart | guaranteed by SQLite persistence; `relay-log` and application cases read the same DB across CLI/API |

## 6. Still needs manual or pre-launch checks

Automation does not replace these:

- **Real partner probes**: the SSRF guard and timeouts of `check-health.mjs`, `fetch-cards.mjs`, `fetch-stats.mjs` against the public internet are verified only in real builds; end-to-end uses `--offline`/`fixtures`.
- **TLS, DNS, certificates**: the real effect of Cloudflare, Certbot, HSTS.
- **nginx and systemd**: config syntax (`nginx -t`), boot autostart, log rotation, backup and rollback (`ops/README-deploy-aws.md`).
- **Real SMTP**: the provider's AUTH, STARTTLS, and the asynchronous bounces it raises after accepting a message. The local sink only verifies protocol and business rules; the `4xx` retry path is covered at unit level (`server/mail.test.mjs` replays a `421 4.7.28` reply), but whether the provider actually recovers on our schedule is only visible in production.
- **Browser matrix**: automation runs only Chromium; Safari/Firefox `Intl.DisplayNames`, `container-type`, `datalist` behavior still needs spot checks.
- **Large data volumes**: map and directory performance at thousands of instances.

## 7. CI suggestion

```bash
npm ci                 # or the existing flow
npm --prefix web ci
npm --prefix e2e install
npm run build -- --offline
npm test
npm run test:e2e
npm run test:ui
```

- Browsers default to the system Chrome; when the runner has no Chrome, run `npm --prefix e2e run install:browser` first and set `E2E_CHANNEL=`.
- `e2e/test-results/`, `e2e/report/` are failure artifacts and the HTML report, not in version control.
- End-to-end does not touch the public internet; CI can run offline (`--offline` build + `--preview` data).

## 8. Troubleshooting

| Symptom | Cause and handling |
|------|------------|
| `web/dist does not exist` | run `npm run build` first, or drop `--no-build` |
| `listen EADDRINUSE` | the previous stack did not exit cleanly; `lsof -iTCP:<port> -sTCP:LISTEN` then kill the process |
| browser cases report "Executable doesn't exist" | no Chrome on this machine: install Chrome, or `install:browser` then `E2E_CHANNEL=` |
| 429 appears in a case it should not | submissions/logins in the same stack share the counter bucket; give that case its own `startStack()` |
| page fonts differ from the design | check whether CSP is `font-src 'self'`, and whether the build inlined fonts as `data:` again |
