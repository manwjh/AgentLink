# XKnot Federation · Hub Contract

Version 2.1. The hub is a lightweight entry.

> L1 divides into an **issued zone** (`instances.json`, hub-written) and a **self-described zone** (`sites/<site>/profile.json`, written by the owner in the instance `/admin`). The hub fetches `GET /api/federation/profile` via `url`, with the copy landing in `var/profiles/{id}.json`. Renaming or changing contact info is edited in the self-described zone, no submission or approval to the hub.

> Access has only one shape: the hub issues `<label>.xknot.si`, entry host + SSH reverse tunnel. The roster records access via `mode` + `tunnel`, and the manifest records identity and acceptance status via `url` + `status`. Terms in [NAMING.md](NAMING.md).

Terms and bilingual wording in [NAMING.md](NAMING.md), locale and region rules in [I18N.md](I18N.md). Concept names in this document follow those two.

![XKnot Federation architecture](federation.svg)

## 0. Summary

`xknot.si` is the hub of the XKnot Federation, providing three kinds of information: **site profiles, runtime status, and showcases**. Users, content, points, and operation belong to each instance.

There is one additional one-way service: **mail relay** (section 7). An instance hands a plain-text notification to the hub's SMTP for delivery, because the federation has only one verified sending address. It is not one of the three information layers, and it does not write the hub's manifest or snapshot; the credential is written into the access material by default, and the hub can suspend acceptance per instance.

## 1. Three layers of information

The hub and an instance exchange only three layers of information, divided by who writes, who reads, and the trust level:

| Layer | Name | Who writes | Flow | Change frequency | Trust |
|----|------|------|------|----------|------|
| **L1** | site profile | hub writes the issued zone, owner writes the self-described zone | hub reads its own manifest, then fetches the self-described zone via `url` | issuance rare, self-description anytime | the issued zone is the hub's authoritative identity; the self-described zone is the partner's expression |
| **L2** | runtime status | instance (machine-generated) | hub GETs | minute-level | verifiable fact |
| **L3** | showcase | partner (published on their own site) | hub GETs | day-level | the partner's expression, the hub does not review |

One rule runs through all three layers:

> **The hub is read-only: everything is GET'd by the hub, and the manifest is the only write entry.**

A partner registers a URL, content stays on their own site, and the hub fetches on schedule. This yields three properties:

- The hub has no data-receiving endpoint, so no tokens, receive validation, rate limiting, or atomic writes.
- A partner does not need to submit material to the hub, nor notify anyone.
- There is only one gate: `instances.json`. Changing, submitting, and publishing an entry is the entire set of operations.

`instances.json` manages only portal-facing fields. The network's membership facts — founding instance, access mode, tunnel account and port — live in the sibling `federation.json` (the federation roster). The roster does not participate in portal rendering; the two files are cross-checked before the build, and a mismatch stops publication.

The only exception is section 7's **mail relay**: the instance POSTs a message to the hub's SMTP. It does not write the manifest, does not write the snapshot, does not keep the body, and is not a fourth information layer — just a delivery service.

The three layers differ in trust:

- L2 is a fact the partner cannot deny. An unreachable site is `down`; self-reported activity is display-only.
- L3 is an expression the partner actively picks. What to show is the partner's choice; the hub fetches, renders, and links back.

## 2. Responsibility boundary

### 2.1 The hub is responsible for

- Maintaining `instances.json` and manifest validation.
- Probing `/api/health` at build time, writing `var/health.json`.
- Fetching `url` + `/api/federation/profile` at build time, writing `var/profiles/{id}.json`.
- Fetching `statsUrl` at build time, writing `var/stats/{id}.json`.
- Fetching `cardsUrl` at build time, writing `var/cards/{id}.json`.
- Building the trilingual portal: Vue 3 + Vite, output is static files, runtime reads only `/data/hub.json`.
- Delisting the whole showcase group of a violating instance.
- Relaying mail for instances per section 7, maintaining credentials, quota, and the send log.

### 2.2 The instance is responsible for

- Users, sessions, accounts, points, orders, and settlement.
- Content publishing, editing, removal, review, and complaint handling.
- Image and media hosting.
- Its own database, backups, domain, and certificate.
- Data-subject requests for EU users.

### 2.3 Judgment for new capabilities

A new capability's data source must satisfy one of:

1. Written into `instances.json`, by the hub (the resident worker or the command line).
2. GET'd by the hub from the manifest's URL.

The hub accepts no writes and stores no partner data. Data outside the manifest is published by the instance, and the hub only fetches a copy.

Mail relay is the only write call, judged separately: it must bind to a listed instance, send only plain text, keep no body, have its own credential and quota, be revocable or suspendable at any time, and change none of the hub's data. If not, do not do it.

## 3. Implementation milestones

| Milestone | Scope | Delivers |
|--------|------|------|
| **M1** | L1 profile, L2 health probe, trilingual portal, region filter | static site + build scripts |
| **M2** | L3 showcase, L2 activity data | added fetch steps and a portal showcase slot |

Both milestones fetch at build time, producing only static files, with no resident service.

## 4. L1: site profile

L1 lives in two places, divided by who may change it:

| Zone | Fields | Stored in | Who writes |
|----|------|--------|------|
| **issued zone** | `id`, `url`, `since`, `tier`, `status`, `cardsUrl`, `statsUrl` | `xknot.si/instances.json` | the hub |
| **self-described zone** | `name`, `locale`, `tagline`, `intro`, `logo`, `owner`, `contact`, `region`, `timezone`, `tags` | the instance's `sites/<site>/profile.json` | the owner, edited in the instance `/admin` |
| **observed zone** | `health`, `locations` (country code judged from the egress IP) | the hub's `var/health.json`, `var/geoip/locations.json` | the hub itself: probes and the tunnel peer; the instance cannot declare it |

The hub accepts no writes: the issued zone changes through manifest edit, submit, publish; the self-described zone is changed by the owner on their own site and fetched by the hub at the next build via `url`. The observed zone is written only by the hub; neither side can change it through an endpoint. Only the three zones together make one profile on the portal.

### 4.1 Issued zone

Single source of truth: `instances.json`. An edit, submit, publish is one change. There is no backend and no approval UI.

| Field | Constraint |
|------|------|
| `id` | lowercase letters, digits, hyphens, 2–32 chars, unique in the manifest, immutable |
| `url` | the identity address, shared by all locales. Always the hub-issued `https://<label>.xknot.si`; anything under another domain is rejected by validation |
| `since` | ISO date, the listing day |
| `tier` | `demo`, `free`, `paid`. A display rank; a missing value fails validation and readers add no default |
| `status` | `pending`, `active`, `suspended`, `retired`. An operator decision; a missing value fails validation and readers add no default |
| `statsUrl` | nullable. When set, L2 activity data is fetched |
| `cardsUrl` | nullable. When set, the L3 showcase is fetched |

All five fields are written by the hub. The matching keys in the instance's `xknot.env` are a **receipt**: they store and restate, they do not interpret the value, add no default, and do not refuse to start over an unknown value. The hub does not read its own decisions back from that receipt either — `fetch-profile` only compares it with the manifest, records a problem on a mismatch, and still goes by the manifest.

Self-described zone fields (`name`, `logo`, `intro`, etc.) appearing in an entry are rejected by `ops/validate-instances.mjs`: those belong to the owner and cannot be changed from the hub side.

### 4.2 Self-described zone

The owner edits it in the instance's `/admin` → **XKnot**, landing in `sites/<site>/profile.json`; the instance publishes it via `GET /api/federation/profile`. Fields, limits, required items, and validation rules are in [`knot-platform/docs/PROFILE.md`](../../knot-platform/docs/PROFILE.md); the two implementations are `ops/profile-schema.mjs` and `knot-platform/backend/src/profile.js`, with this repo's `ops/profile-schema.mjs` as authoritative.

The format is `{ "formatVersion": 2, "updatedAt": "YYYY-MM-DD", "site": { … } }`, ten flat fields:

| Field | Type | Limit | Required | Where it appears on the portal |
|------|------|------|------|---------------|
| `name` | string | 40 | yes | card name, map dot |
| `locale` | `zh-CN` / `zh-TW` / `en` | — | no | not shown on the portal. The instance uses it to pick the first-visit UI language |
| `tagline` | string | 60 | no | the card's one-liner |
| `intro` | string | 800 | no | card body |
| `logo` | https address | 300 | no | card badge |
| `owner` | string | 40 | no | the owner in the card footer |
| `contact` | string | 120 | no | only in the copy, not shown directly |
| `region` | two-letter country code or `GLOBAL` | 2 | no | region grouping and map placement; when an egress-IP observation exists, it wins, see `HUB.md` section 4 |
| `timezone` | IANA name | 40 | no | the local clock on the card; when missing, derived from the egress-IP country and marked, see `HUB.md` section 4 |
| `tags` | string array | 9 × 16 | no | card tags and tag filtering |

Key points:

- **No per-locale text mapping**: whatever language the owner writes is what the portal shows. The hub does not translate, nor pick one per UI locale. `locale` is not the text language; it is the instance UI's default language, and the portal only validates its value.
- `tags` is free text: no preset vocabulary, no semantic merging, no translation; only whitespace stripping, case-insensitive dedup, and preserving the owner's order.
- `logo` is an https absolute address. Images in the self-described zone store only the address; no binary enters the hub.
- `region` is a **declaration** the owner writes, not a location the hub asserts. The portal's location display follows the tunnel peer's egress IP (GeoIP, country code only); the declared value is only the fallback when there is no observation, e.g. the instance is offline or the hub is not on the entry host.
- Do not write empty strings: clearing a field omits the whole key. Unknown keys drop only that one field, not the whole profile (field table in `ops/profile-schema.mjs`'s `SITE_FIELDS`).

### 4.3 Fetch and cache

At build time `ops/fetch-profile.mjs` fetches `url` + `/api/federation/profile` for each `status: active` entry:

- validates `formatVersion`, `issued.id` equals the manifest id, and `issued.url` is on the same host as the manifest `url`;
- the self-described zone goes through `cleanSite` (`ops/profile-schema.mjs`): only a missing `name` drops the whole profile and keeps the previous copy; other problems drop only that one field, the rest is kept;
- response cap 64KB, with ETag, `304` treated as unchanged;
- writes `var/profiles/{id}.json`, with `fetchedAt` and `source`; a failed fetch does not clear the old file.

The portal only uses this copy: missing fields are filled with issued-zone fields and fallback text, never counting the entry as down (that is L2's business).

**Upgrade order: instance first, portal second.** On fetch, a response whose `formatVersion` is not 2 is rejected whole and the previous copy kept; an old copy has no `site`, so the portal shows only the id for that entry. `ops/verify-hub-data.mjs` before `deploy-hub.sh` treats "has an issued zone but no self-described name" as a problem and blocks publication, precisely to make this order explicit.

**When adding a self-described field, the reverse: hub first, instance second.** `cleanSite` only accepts keys in `SITE_FIELDS`; unknown keys are dropped without rejecting the whole profile. `locale` was added exactly this way: the hub's `SITE_FIELDS` accepted it first, then the instance started writing it; reversing the order does not crash, but the site's locale keeps using the fallback on the portal, with a few problem records left in `var/`.

### 4.4 Rules

- The probe address is derived from `url`, not registered separately; `statsUrl` and `cardsUrl` decide what else the hub fetches, and an empty field is skipped without error.
- `tier` only affects the display badge, not sorting, not rating or revenue sharing.
- Sample entries may be marked `tier: demo` and are not counted in instance statistics.
- Pages sort by `tier`, then `since`, stably.
- Region is only for grouped browsing, not sorting, and does not affect listing.
- The manifest must pass `ops/validate-instances.mjs` before publication.

### 4.5 Access mode

Access has only one shape; identity is the `url` itself, with no second axis:

| `federation.json` `mode` | Identity | Entry and tunnel |
|------|------|------------|
| `subdomain` | `https://<label>.xknot.si`, hub-issued | the entry hosts the static page, `/api` returns through the SSH reverse tunnel; `tunnel` required |

The `mode` field is kept, with the only value `subdomain`. The probe address is always `url` + `/api/health`. The roster `host` and the manifest `url`'s hostname must match, and both fall under `xknot.si`.

A site that already has its own domain is not registered here: it is its own entry, needs no issuance and no redirect. Such sites do not enter the manifest and do not participate in federation probes.

`status: pending` is the state between listing and acceptance, not another access mode: the entry is already in the manifest but not probed and not on the portal; after `/api/health` passes it becomes `active`. Changing machines or IPs only changes DNS and entry config, not the `url`.

## 5. L2: runtime status

### 5.1 Endpoint

| Endpoint | Frequency | Cache | Content |
|------|------|------|------|
| `/api/health` | on demand (build time) | `no-store` | `ok`, `version`, `service`, `instance` |

A Knot instance provides `GET /api/health`, returning `{ ok: true, service, version }`. The hub uses this endpoint directly; the instance side needs no change. The Knot deployment layer additionally attaches `release`, `commit`, `builtAt` for publish scripts to check versions; the hub does not read these fields.

An instance joining the federation also carries `instance` (the access material's `XKNOT_INSTANCE_ID`), e.g. `{ ok: true, service: "knot-backend", version: "0.7.0", instance: "wang" }`. The hub uses it to verify "is this domain the instance in the manifest"; instances without it are still judged by `ok`.

### 5.2 Probe determination

- The address is always `url` + `/api/health`, derived by `ops/probe-target.mjs`; only `status: active` is probed, `pending` / `suspended` / `retired` are not.
- Method `GET`, timeout 5 seconds, no redirect following.
- Only `https` accepted. Non-https is `unknown`.
- Success: HTTP 200, body is JSON, and `ok === true`.
- Carrying `instance` that differs from the manifest id: `down`, `error` records `instance_mismatch`.
- Does not read the instance's database, no Cookie, no credentials.

### 5.3 Status

| Status | Determination | Display |
|------|------|------|
| `up` | success and ≤2s | green dot |
| `degraded` | success but >2s | yellow dot |
| `down` | failure | red dot |
| `unknown` | never probed, or the manifest `status` is still `pending` | gray dot |

A failed probe keeps `lastOkAt`, only changes `status` to `down`, and the page shows "last ok: 3 hours ago".

### 5.4 Consecutive disconnect

`ops/watch-health.mjs` runs a probe every 15 minutes, records consecutive duration with `downSince` and `notified`, and handles per these lines:

| Condition | Action |
|------|------|
| `down` for 24 consecutive hours | mail the instance `contact` a reminder |
| `down` for 7 consecutive days | send the disconnect notice, the portal no longer shows the entry (`hiddenAt` / `hiddenReason`) |
| any probe `up` / `degraded` | clear `downSince` and the hide flag, the entry returns to the portal automatically |
| `status` still `pending` and `since` is 14 days ago | internal reminder to the operator |
| `status` still `pending` and `since` is 30 days ago | temporarily hidden from the portal |

"Never connected" is judged only by the manifest status: `status: pending` entries count from `since`, with a 14-day internal reminder and 30-day temporary hide. Ones already `active` but unreachable follow the `down` rules above, not mixed.

Hiding only affects `health.hidden` in `buildHubData`'s output, and **does not change `instances.json`**. Each notice is recorded once in `notified`; repeated runs do not resend.

### 5.5 Result file

Written to `xknot.si/var/health.json`; the portal reads only this file:

```json
{
  "checkedAt": "2026-10-19T02:30:00.000Z",
  "instances": {
    "wang": {
      "status": "up",
      "httpStatus": 200,
      "latencyMs": 137,
      "version": "0.7.0",
      "lastOkAt": "2026-10-19T02:30:00.000Z",
      "since": "2026-10-19T02:30:00.000Z",
      "checks": 1,
      "ok": 1,
      "error": null,
      "downSince": null,
      "notified": {},
      "hiddenAt": null,
      "hiddenReason": null
    }
  }
}
```

- `checks` and `ok` accumulate from `since`, used to compute availability. No per-attempt history is kept.
- The file is the only state; deleting it returns the entry to `unknown`.
- Write method: temp file + rename.

### 5.6 Activity data

A partner optionally exposes `statsUrl`, providing only counts. The hub fetches at build time, writes `var/stats/{id}.json`; the portal reads only this file; a missing file shows "not shared".

```json
{
  "generatedAt": "2026-10-19T02:00:00.000Z",
  "posts": { "total": 1234, "last24h": 12, "last7d": 80 },
  "accounts": { "total": 300, "last7d": 18 },
  "authors": { "active7d": 45 }
}
```

- Only counts, no nicknames, emails, avatars, bodies, or record ids.
- Missing `statsUrl` shows "not shared", not 0.
- Self-reported numbers are display-only, not for sorting, rating, or revenue sharing.
- Only window values are accepted, not daily series.

Field constraints:

| Field | Constraint |
|------|------|
| `generatedAt` | nullable, ISO time; used as "partner updated at" |
| `posts.total` / `posts.last24h` / `posts.last7d` | nullable, non-negative integer |
| `accounts.total` / `accounts.last7d` | nullable, non-negative integer |
| `authors.active7d` | nullable, non-negative integer |
| Unknown fields | ignored, not entering `hub.json` |

At least one recognized count, otherwise the whole thing is discarded. The fetch is done by `ops/fetch-stats.mjs`: https only, no redirects, 5s timeout, 32KB body cap, rejecting loopback, private ranges, and cloud-metadata after DNS resolution; failure keeps the previous copy. Supports `ETag` / `If-None-Match`.

### 5.7 Entry traffic (hub observation, not part of the contract)

The hub sees each subdomain's requests and bytes in the entry nginx access log, aggregating into `var/traffic/{id}.json`. This item **needs no instance cooperation and enters no endpoint**:

- The instance reports nothing and does no instrumentation; the access material and `/api/*` are unchanged.
- Only shown in the hub console; not written into `hub.json`, not in the member entry. Publishing a site's traffic outward needs the owner's separate consent.
- When the hub and entry are on different machines, this whole item does not apply; the rest of the contract is unchanged.

Fields, retention, and blind spots in [HUB.md](HUB.md) section 11.

## 6. L3: showcase
A partner registers a URL (`cardsUrl`), content is published on their own site, and the hub fetches at build time.

### 6.1 Positioning

| Showcase | Feed |
|------|--------|
| fixed 6 cards, full replacement | infinite scroll |
| the partner picks | the platform ranks by algorithm |
| can only link back to the origin | can be read in full on the hub |
| hides when stale | permanently accumulated |
| the hub does not review; the whole group can be delisted | the hub bears content responsibility |

### 6.2 Fetch

```
GET https://travel.xknot.si/.well-known/knot-cards.json
Accept: application/json
```

The response body is a fixed wrapper. The hub overwrites the previous copy on fetch and keeps it on failure. Implementation is `ops/fetch-cards.mjs`, landing in `var/cards/{id}.json`.

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-10-19T02:00:00.000Z",
  "cards": [
    {
      "id": "c-2026-10-19-kyoto",
      "lang": "zh-CN",
      "title": "京都的秋天该怎么走",
      "summary": "一条不赶时间的路线。",
      "body": "## 第一天\n先到南禅寺……",
      "url": "https://travel.xknot.si/?id=0f3c",
      "images": [
        {
          "url": "https://travel.xknot.si/api/web/uploads/abc",
          "alt": "红叶",
          "width": 1200,
          "height": 800
        }
      ],
      "publishedAt": "2026-10-18T09:00:00.000Z",
      "tags": ["日本", "秋季"]
    }
  ]
}
```

### 6.3 Constraints

| Item | Constraint |
|----|------|
| `cards` | 0–6. `[]` means clear; each fetch fully overwrites, no append |
| `formatVersion` | integer, only `1` recognized for now; decoupled from the instance version |
| `id` | unique within the instance, ≤64 chars |
| `lang` | nullable, BCP 47, the card's own language; omitted means unmarked |
| `title` | required, ≤80 chars |
| `url` | required, https, pointing to that instance's own host |
| `summary` | nullable, ≤160 chars |
| `body` | nullable, ≤4000 chars, an MD subset: headings, lists, links, quotes, bold, code. No HTML, scripts, `javascript:`, or `data:` |
| `images` | nullable, ≤3. https absolute addresses, host same as or a subdomain of `url` |
| `images[].width` / `height` | required, positive integers |
| `publishedAt` | nullable, ISO time |
| `tags` | nullable, ≤5 short words |
| Response body | ≤256KB |
| Fetch timing | once at build time. Supports `ETag` / `If-None-Match` |
| Clear | publish `{"formatVersion":1,"cards":[]}`, cleared at the next build |

A minimal valid entry only needs `title` and `url`. A partner that does not maintain the wrapper can give an address pointing to their own hot-list page, and the hub renders it as one external link.

Unqualified cards are dropped one by one; if all are unqualified the whole thing is discarded and the previous copy kept. HTML tags are stripped before landing on disk; the body does not enter the portal, which renders only title, summary, language, and the link.

`cardsUrl` and `statsUrl` are public read-only addresses. The hub carries no credentials; private data is not connected.

### 6.4 Image hotlinks

The hub stores no images, only URLs:

- saves storage and bandwidth, avoids mirrored-copyright risk.
- when the partner is unreachable, show a placeholder block without breaking the layout.
- the hub keeps a whole-group delist switch.

Whole-group delisting is L3's governance mechanism: the hub does not review item by item, and removes the whole group when problems appear.

### 6.5 Cache and invalidation

- On fetch, atomically overwrite `var/cards/{id}.json`; keep the previous copy on failure.
- The page shows "updated X".
- Over 7 days grayed; over 30 days the whole group hidden. Judged on read, no scheduled cleanup.
- The hub stores no historical versions or images.
- After the partner revises, the next build syncs; whole-group delist deletes the file directly.

### 6.6 Security

Fetch addresses come from the repo manifest but are still treated as untrusted:

- https only, no URL username/password.
- No redirects, 5s timeout, 256KB body cap.
- After DNS resolution, reject loopback, private ranges, link-local, and cloud-metadata. The manifest is written by the worker, but the same checks run at runtime.
- No Cookie or credentials.
- Whitelist cleaning before landing: strip HTML tags, drop dangerous protocols, `body` renders only the MD subset.
- The fetch runs inside the build step; on failure the previous `var/cards/` is kept.

## 7. Mail relay

The federation has only one verified sending address. Instances are small and their domains new, so self-configured SMTP tends to land in spam; a notification can be handed to the hub for delivery. This is the only service outside the three information layers, and the hub's only write entry.

**On by default.** The credential is issued by the operator when generating the access material, and handed to the instance together with it; the instance uses it to send, with no SMTP of its own and no separate application. The hub keeps a per-instance switch and can suspend or resume acceptance at any time (section 7.2).

It **does not write the hub's manifest or snapshot**: no change to `instances.json`, no snapshot write, no body kept, only one record in `relay_log` with no address and no body.

### 7.1 Why the hub sends

- Sending reputation accumulates per domain. Spreading it across instances means every one starts from zero.
- Recipients only look at the sending domain. One verified address delivers better than ten new ones.
- The instance need not hold SMTP credentials, nor open 465 / 587 on its firewall.

The cost is that recipients see the hub's address as the sender, and replies rely on `Reply-To` going back to the instance.

### 7.2 Credentials and switches

- One credential binds to one instance; `relay_tokens` stores only the token's SHA-256.
- The plaintext prints once at issuance, written into the instance's env vars.
- Revocation can be by credential id, or by instance id revoking all of that instance's credentials at once.
- The instance must still be in the manifest with `status: active`; a delisted or non-active instance's requests are rejected.
- Each credential has its own 24-hour quota, default 50, capped by hub config.

**Three switches, expressing three different things.**

| Switch | Scope | How to use | Instance sees | Reversible |
|------|------|--------|----------|------|
| the `/admin` "mail master switch" | all hub mail | click in the console, persisted, effective immediately | relay `503 relay_unavailable` | click again to restore |
| `XKNOT_RELAY_ENABLED=0` | all hub instances | hub env var; one-click stop in an incident | `503 relay_unavailable` | set back to restore |
| `relay-disable <instance>` | one instance | operator command; records the reason | `403 relay_disabled` | `relay-enable` restores, credential untouched |
| `relay-revoke` | one instance | credential leak, leaving the federation | `401 token_revoked` | **irreversible**, reissue and have the instance swap the file |

The console master switch governs **whether the whole hub sends at all**: partner mail, internal alerts, member login codes, and relay stop together. It writes into the `settings` table (`mail=off`), not config, not env vars, no restart; deleting that row returns to default. The env var `XKNOT_RELAY_ENABLED=0` is a different, relay-only gate: it does not lock the console; when the master switch is on, the panel notes "relay still returns 503", the two stating their own facts without impersonating each other.

Suspend and revoke are two things: **suspend only stops acceptance** — credential, quota, and history stay as-is, and enabling continues use; **revoke invalidates that key** — the instance must get a new access material to send again. Day-to-day rate limiting and rising bounce rates use suspend; a credential leak uses revoke. When the master switch is off, `admin-cli notify / handoff / live` also refuse directly, avoiding "stopped in the UI but still sent one from the terminal".

```bash
cd xknot.si
node server/admin-cli.mjs relay-disable cpswang --note "rising bounce rate"
node server/admin-cli.mjs relay-enable cpswang
```

**Whether to use relay is the instance's own choice**: with `XKNOT_HUB_ORIGIN` and `XKNOT_HUB_RELAY_TOKEN` in its environment it hands to the hub, otherwise it uses its own SMTP. The hub does not notify in advance; it only rejects per the table above when a request arrives.

**One tradeoff you must know.** The instance puts relay ahead of local SMTP, and that choice is fixed at process start: once it holds a credential, the hub is used first. When the hub is stopped, an instance that also has a usable SMTP (host and sender address both set) falls back to sending locally; an instance with only relay configured just reports a sending failure, so **for that instance suspending means its login keys cannot be delivered** (XKnot login has only the email-verification-code path). Operationally there are only two paths: either confirm the instance has its own SMTP before stopping, or accept that it temporarily cannot log in.

Issue, view, and revoke:

```bash
cd xknot.si
node server/admin-cli.mjs relay-token wang --label "login reminder" --daily 50
node server/admin-cli.mjs relay-tokens
node server/admin-cli.mjs relay-revoke wang
node server/admin-cli.mjs relay-log 50
```

The instance side configures only two things: hub address and credential. The send address is a protocol constant, derived from the hub address (`<XKNOT_HUB_ORIGIN>/api/federation/mail`), no extra field; only when changing the entry do you write `XKNOT_HUB_RELAY_URL`.

```bash
XKNOT_HUB_ORIGIN=https://xknot.si
XKNOT_HUB_RELAY_TOKEN=xkr_wang_...
```

These two govern only mail relay; the **access material** also carries the instance id, the hub address, and the four issued fields — the full key table is in section 7.4. Generate the whole thing at once:

```bash
node server/admin-cli.mjs access <application id> --id wang --out /tmp/wang-access.env
```

`access` issues one relay credential by default and writes it into the access material; add `--no-relay` only when a pure-SMTP access material is genuinely wanted.

### 7.3 Endpoints

| Method and path | Auth | Notes |
|------------|------|------|
| `POST /api/federation/mail` | `Authorization: Bearer <token>` | send one plain-text notification |
| `GET /api/federation/mail` | same | query the 24-hour quota |

Only these two. Credential issuance and suspension are all on the hub command line, not open to the case key or web sessions.

Request body:

```json
{
  "to": "lin@example.com",
  "subject": "登录提醒",
  "text": "点开这个链接继续：https://wang.xknot.si/login/8f3c",
  "replyTo": "support@wang.xknot.si",
  "idempotencyKey": "login-8f3c"
}
```

| Field | Constraint |
|------|------|
| `to` | required. A single bare address, no display name, ≤254 chars |
| `subject` | required, ≤120 chars, no newlines |
| `text` | required, plain text, ≤4000 chars, no `\r` or NUL |
| `replyTo` | nullable. Must fall within the instance's own domain (`url` or `contact`'s host and subdomains); when empty, `contact` is used |
| `idempotencyKey` | nullable, ≤64 `A-Za-z0-9._:-`; the same key sends once within 24 hours |

Success:

```json
{ "ok": true, "delivery": { "id": 42, "at": "2026-10-19T02:31:00.000Z", "toDomain": "example.com" } }
```

Retrying the same idempotency key returns `{"ok":true,"duplicate":true,...}` without resending. If the first request is still in transit, the retry carries `"pending": true`; the quota is already occupied, so query it again after the original finishes.

Quota query:

```json
{
  "instance": "wang",
  "token": { "label": "登录提醒", "dailyLimit": 50 },
  "quota": { "windowHours": 24, "used": 12, "limit": 50, "remaining": 38 }
}
```

Error codes:

| Status | `error` | Meaning |
|------|---------|------|
| 400 | `invalid` | field error, `fields` gives the field codes |
| 400 | `bad_json` | body is not JSON |
| 401 | `missing_token` / `invalid_token` / `token_revoked` | credential missing, invalid, or revoked |
| 403 | `instance_not_listed` / `instance_inactive` | instance not in the manifest, or status is not `active` |
| 403 | `relay_disabled` | this instance's relay is suspended; the credential is still valid and works after restore |
| 413 | `too_large` | body over 16KB |
| 429 | `rate_limited` | 6 per minute per credential, or 240 per hour site-wide |
| 429 | `quota_exceeded` | the 24-hour quota is used up |
| 502 | `smtp_failed` | the hub's SMTP refused this delivery; see the two classes below |
| 503 | `relay_unavailable` | the hub has no SMTP, or the `/admin` master switch or `XKNOT_RELAY_ENABLED=0` is off |

`502 smtp_failed` carries `smtp`, the receiver's numeric code plus enhanced status code, e.g. `"smtp": "421 4.7.28"`. It falls into two classes, and the instance's handling is entirely different:

| Class | How to tell | Body | What to do |
|------|---------|------|----------|
| transient | SMTP `4xx`, timeout, connection dropped | `"transient": true`, with `Retry-After` | wait `Retry-After` seconds, then retry with **the same idempotency key**; retrying at once only extends the receiver's throttle |
| permanent | SMTP `5xx`, illegal address, content refused | no `transient` | do not retry the same message; change the recipient or the content, or the same sentence rejects it every time |

When the receiver says "slow down on our side" it gives a 4xx, typically a shared sending IP being throttled:

```json
{ "error": "smtp_failed", "transient": true, "smtp": "421 4.7.28" }
```

A failure also consumes that call's quota (`failed` counts toward the 24-hour usage), so repeatedly retrying one rejected address hits `quota_exceeded` sooner.

### 7.4 Access material

The access material is the only credential file the hub hands to the instance: **env format, with these keys, values only the hub can sign**. It is a contract, not an implementation's config template — what filename the instance stores it under, which directory, and what tool reads it are all the instance's own decision; the hub only fixes the key names and semantics (`knot-platform`'s convention is `sites/<site>/xknot.env`).

| Key | Required | Semantics |
|----|------|------|
| `XKNOT_INSTANCE_ID` | yes | the instance id in the manifest, lowercase letters/digits/hyphens |
| `XKNOT_HUB_ORIGIN` | yes | the hub address, e.g. `https://xknot.si` |
| `XKNOT_ISSUED_URL` | yes | the manifest's `url` |
| `XKNOT_ISSUED_AT` | yes | the manifest's `since`, `YYYY-MM-DD` |
| `XKNOT_ISSUED_TIER` | yes | the manifest's `tier`, copied verbatim |
| `XKNOT_ISSUED_STATUS` | yes | the manifest's `status`, copied verbatim |
| `XKNOT_HUB_RELAY_TOKEN` | no | the relay credential; issued by default, absent when generated with `--no-relay` |
| `XKNOT_HUB_RELAY_URL` | no | the relay address, not issued by the hub: derived from `XKNOT_HUB_ORIGIN` by default, the instance adds it only when changing the entry |

The four `XKNOT_ISSUED_*` keys are a mirror, not a snapshot: the next connect check (the `/admin` sync) or a re-run of `join` rewrites them from the manifest's current issued zone.

Rules:

- Generation: `node server/admin-cli.mjs access <application id> --id <instance> [--no-relay] --out <file>`, issued only to approved applications; carries one relay credential by default.
- Writing: the instance persists it along its existing access-material write path (`knot-platform` is `join-xknot.sh --payload`), then restarts the Backend to apply.
- Transfer: one-time claim, `0600`, not in chat, not in mail bodies, not in version control.
- Storage: the instance keeps it itself; an instance not joining the federation does not need this file and works as usual.
- Scope: **access only**. Domain, port, entry host, tunnel account, and static-file ownership are deployment topology, recorded by the instance's own deployment plan; the hub does not issue or validate them.
- Reissue: re-signing for the same instance revokes its old relay credential (there is no separate reclaim besides `relay-revoke`, so do not keep old files); hub address and site address are unchanged, other keys are rewritten per the current manifest.
- Mismatch: the instance uses only its latest file; combining two files sends with the old credential and the hub rejects as `token_revoked`.
- Retired keys: a key outside the current contract (renamed or dropped) makes the instance reject the whole file and leave the existing one untouched. The receiver does not rename keys or wave such a key through as an ordinary unknown: writing it in means nobody reads it, and the missing tier row is only noticed later on the portal. A new key has to come from a re-sign by the hub on the current version.

The instance reports `instance` in `/api/health` using `XKNOT_INSTANCE_ID`; the hub verifies it equals the manifest id, and a mismatch is `down` (section 5).

### 7.5 Boundary

- Plain text only: no HTML, attachments, multiple recipients, cc, or bcc.
- Sender is always the hub's `MAIL_FROM`, the instance cannot override; `Reply-To` must fall within the instance's own domain.
- No body, full recipient address, or subject is kept; the log only keeps instance, recipient domain, address hash, subject length, and result.
- Each send carries `X-XKnot-Instance: <id>` for recipient-side reconciliation with the hub.
- The hub does not retry relayed mail on the instance's behalf: a `4xx` answers 502 with `Retry-After` immediately and the instance resends after that interval; a `5xx` also answers 502 but without `Retry-After`, because the same message would be refused by the same sentence. Only the hub's own application and live notices retry internally, at 1 / 5 / 30 minutes.
- The hub sees only the result inside the SMTP session. When the receiver accepts `250` and bounces later (asynchronous bounce) the hub cannot see it, does no bounce handling, and does not host subscriptions; bounce and complaint rates are the instance's own to control.
- The hub can suspend or revoke the credential at any time; neither affects the instance's other features, only mail is rejected.

### 7.6 Abuse and handling

| Symptom | Action |
|------|------|
| a single instance's bounce rate rises | `relay-disable <instance>` to stop it first (recoverable); then decide between lowering `--daily` and revoking |
| a spam complaint arrives | immediately `relay-disable`, then `relay-revoke` and delist; also delete the L3 cache |
| credential leak | `relay-revoke` (irreversible), re-`access` and have the instance swap the file |
| replies to recipients go unanswered | check the instance's `contact` and `replyTo`; replies should land in the instance's own mailbox |

`relay_log` keeps 30 days by default: cleaned once at startup, then every 6 hours for older records; `pending` is checked every minute, and a placeholder still `pending` after 15 minutes is treated as the process exiting mid-send, reclaimed directly — no longer occupying quota, and not blocking the same idempotency key forever.

## 8. Security and privacy

- The hub only accesses manifest addresses. The join application only receives the subdomain label and site info, not resolved or fetched on receipt; only after approval, manifest listing, and acceptance does the build probe.
- Probes and fetches reject loopback, private ranges, link-local, and cloud-metadata after DNS resolution.
- There are only two write paths: `POST /api/applications` (form fields only, no file storage, no HTML echo, length caps and a honeypot) and `POST /api/federation/mail` (Bearer credential, plain text, its own quota, no body). Credential issuance, suspension, and revocation are all on the hub command line, with no HTTP entry.
- Mail relay is fully isolated from browser sessions: reads no Cookie, and does not accept cross-origin POSTs reusing a session via `Origin`.
- The console needs an admin account and session; accounts are created by command line, passwords stored with scrypt+salt, and the session Cookie is `HttpOnly`, `SameSite=Strict`.
- The portal executes no partner scripts and embeds no iframes. External links carry `rel="noopener noreferrer"`.
- The hub keeps no user table, author directory, or individual visit profile; application records keep only site info, contact email, and a hashed source address; mail records keep only recipient domain and address hash.
- `.si` is inside the EU. A GDPR assessment is completed before M2 goes live, focusing on whether self-reported counts can reverse-identify individuals and on mail-log minimization.

## 9. Ownership and license

- The code is released under Apache-2.0, copyright PaulWang, attribution in `NOTICE`.
- `xknot.si` and the subdomains issued under it belong to PaulWang and are not licensed with the code.
- The license grants no trademark rights. The names and marks `Knot`, `xknot`, `xknot.si` belong to PaulWang.
- Listing does not change ownership. A partner's site, content, and users belong to the partner.

## 10. Listing and delisting

Joining is application-based: the owner submits in their own site's `/admin`, the platform checks on the spot, **auto-approves**, and issues the subdomain; the resident worker then writes it into the manifest and connects it. Approval is not automatic onboarding, and it does not change instance autonomy.

| Phase | What happens |
|------|----------|
| Submit | the owner fills the subdomain label and contact email in the instance `/admin`'s "join XKnot", submitted on the instance's behalf via `POST /api/applications`, with fields subdomain label, name, intro, operator, email, region, timezone, tags; the hub endpoint can also be called directly. The address comes only from the `subdomain` label |
| Check the label | before submitting, ask `GET /api/subdomains/check?label=`. Labels under 6 chars are not issued, nor reserved or taken ones; candidates are given on failure |
| Auto-approve | the platform validates fields and dedupes; on passing it writes the application as `approved` (`reviewed_by=auto`), no pending queue |
| Notify | immediately sends the approval letter to the applicant and a new-member alert to the operator |
| Write the manifest | after approval, the resident worker (`server/provision.mjs`) runs `publish`: it allocates the tunnel account and port and writes the `instances.json` entry (`status: pending`) together with the same-name `federation.json` member; the command line is only for an exceptional re-run |
| Launch | once the tunnel is up and `/api/health` passes, the worker sets `status` to `active` and recomputes the portal snapshot on the spot; the entry appears in the map and directory |

| Situation | Action |
|------|------|
| New partner | submit which approves → worker writes the manifest (`pending`) → automatic pre-staging and connect → acceptance sets `active` → the snapshot recomputes |
| Rename | edit the corresponding entry |
| Change IP | partner submits the change; only DNS and entry config change, `url` does not |
| Change label | change `url` and roster `host`, re-issue; old subdomain reclaimed, no 301 transition |
| Long offline | 24-hour reminder, 7 days temporarily hidden from the portal (entry not deleted); back automatically when the probe recovers |
| 30 days still not connected | temporarily hidden from the portal, followed up or subdomain reclaimed by a person |
| Illegal, fraudulent, impersonating, trademark-infringing | removed from the manifest, L3 whole-group delisted and cache deleted |
| Partner leaves | delete the entry, delete the L3 cache, reclaim the subdomain |

Approval or withdrawal does not affect the site itself; the applicant can correct the info and resubmit. The hub hosts no content; delisting affects only the entry, not the partner site's data.
