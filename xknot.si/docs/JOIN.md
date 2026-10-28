# XKnot Federation · Joining

Version 2.1. Documentation only; does not change runtime configuration.

Contract in [FEDERATION.md](FEDERATION.md), hub implementation in [HUB.md](HUB.md), terms in [NAMING.md](NAMING.md).

This document answers two questions: **how to apply to enter the manifest**, and **how to connect after issuance**. There is only one access shape: the hub issues `<label>.xknot.si`, with an entry host + SSH reverse tunnel.

---

## 0. Summary of conclusions

| Question | Conclusion |
|------|------|
| How to join | first deploy an instance on your own machine → open `/admin` → fill the self-description, pick a subdomain label and submit → the platform checks and issues the subdomain on the spot, **submission is approval** → the resident worker connects it automatically (section 1.5), the portal snapshot recomputes on its own. **Approval is not launch.** |
| Must I provide a domain | no. The address is issued by the hub: `<label>.xknot.si`, label 6–32 chars. Sites that already have their own domain do not need this federation step. |
| What is my identity | the `url` in the manifest — the one address, unchanged after issuance. Changing machines or IPs only reconnects the tunnel and changes DNS, never the `url`. |
| Access shape | only one: the hub issues `<label>.xknot.si`; before the tunnel is up the entry serves a placeholder page, and once up the whole site (including `/`) returns through the **SSH reverse tunnel the machine itself initiates** to the instance. The roster's `mode` is always `subdomain`, and `tunnel` is required. |
| Own domain | not registered, not issued, not redirected. A site with its own domain is its own entry and can skip this federation step. |
| Private-network address | the contract requires probes/fetches to reject loopback, private, link-local, and cloud-metadata addresses after DNS resolution. `ops/check-health.mjs`, `ops/fetch-cards.mjs`, `ops/fetch-stats.mjs` all go through `ops/fetch-guard.mjs`, judging `down` / keeping the previous copy on a hit. **Do not set `url` to an address reachable only on the LAN** — the probe address is derived from it. |
| What happens on disconnect | unreachable for 24 consecutive hours → mail reminder; 7 consecutive days → mail notice and temporarily hidden from the portal; automatically back when the probe recovers. Listed but never accepted: 14 days reminder, 30 days temporarily hidden. See section 5. |

One sentence: **the address is the identity, and the address is issued by the hub.** There is only one access shape, no second axis, and no redirect.

---

## 1. Access flow (apply → approve → manifest → launch)

Joining is application-based; see [FEDERATION.md](FEDERATION.md) section 9 and [HUB.md](HUB.md) section 9.

The whole flow meets exactly once: the public key is handed over at application time, so after approval the hub can finish all the configuration alone, and then comes exchange point A. Details in [HANDOFF.md](HANDOFF.md).

```text
partner: instance /admin (subdomain label + site profile) → paste .pub at /case/<caseKey>
    │  POST /api/applications → approved on the spot (reviewed_by=auto)
    ▼
approval letter and operator alert sent together
    │
    ▼
hub pre-staging (no partner presence needed, done in one pass)
    │  write manifest status: pending · write roster mode/tunnel · allocate account and port
    │  DNS · certificate · static root and placeholder page · subdomain conf (placeholder page + /api already on the loopback port)
    │  create account · install public key · sshd Match → run stops at awaiting_tunnel
    ▼
exchange point A (the only meeting)
    │  hub gives: account, port, entry host, public-key fingerprint (instance reads progress by case key)
    │  partner gives: local {"ok":true,...} receipt
    ▼
finish (each side does its own, no more waiting for replies)
    │  partner starts tunnel + resident service; hub connects / to the tunnel too (/api has always gone through the tunnel)
    │  probe passes → status: active → npm run build
    ▼
the entry appears in the portal map and directory
```

### 1.1 Application

- Entry: the instance's own `/admin`, the "join XKnot" block (`knot-platform/admin/index.html`), which submits through the instance's own `POST /api/admin/xknot/apply`; that endpoint hands the self-description to the hub's `POST /api/applications`.
- The hub portal's right column no longer takes an application form: there it is "log into your XKnot" and the four-step join guide (deploy → `/admin` → pick a subdomain and submit → submission is approval); already-onboarded owners see their site's status, health, and activity counts from here.
- Endpoint: `POST /api/applications` (`server/app.mjs`). Calling it directly works too, with the same fields as the instance's on-behalf submission.
- Check the subdomain first: `GET /api/subdomains/check?label=` returns `available`, `reason` (`too_short` / `too_long` / `format` / `reserved` / `taken` / `ok`) and candidate suggestions. In the instance's `/admin` this is the "check" button.
- Fields (consistent with `server/validate.mjs`):
  - **subdomain label** `subdomain`: **6–32 chars** of lowercase letters, digits, and hyphens, not starting or ending with a hyphen. Fewer than 6 is never issued: short numbers are reserved for later, not handed out in the first batch. System-reserved names (`www`, `api`, `admin`, `mail`, `xknot`, etc.) are not issued.
  - site name, one-line tagline, operator, contact email, region, timezone, tags, consent checkbox. These are only for validation and contact: **they are not written into the manifest**. After launch the owner fills them into the site profile (self-described zone) in their own instance's `/admin`; the hub fetches it via `GET /api/federation/profile`.
  - the region shown on the portal is judged by the hub from this tunnel's egress IP, not the one filled at application: if the machine moves city or data center, the page follows. A wrong value does not block access; it only serves as fallback when the tunnel is down.
  - `mode` and `domain` are retired. Requests still carrying `mode: "own-domain"` or a non-empty `domain` return `400` with field code `not_supported`, not silently treated as an issuance application.
  - on validation failure, the subdomain error codes in `fields` match the precheck: `required` / `too_short` / `too_long` / `format` / `reserved`.
- During application the hub **fetches nothing** from any site.
- Resubmitting the same label while `approved` returns `409 duplicate`; after withdrawal a new application may be submitted, to add services or change the label.
- After submission the hub immediately sends two mails: the approval letter to the applicant (subdomain address, tier, and the `/case/<caseKey>` link) and the new-application alert to the operator. Mails do not receive replies; anything needing action always goes through the case page link.

### 1.2 Submission is approval

- The platform checks fields and dedupes on receipt; on passing, it writes the application directly as `approved`, with `reviewed_by` set to `auto`. There is no pending queue and no email-confirmation gate.
- The subdomain is issued on the spot and the approval letter goes out immediately: address, current tier (default `free`), and the `/case/<caseKey>` link are all in the letter.
- **Paste the public key while you're at it**: the case page has an `ssh-ed25519 …` input box. This is the only input of the pre-staging phase — with it, the hub can finish the account, `authorized_keys`, and sshd config in one pass after approval, without asking again.
- Application status, public-key submission, and withdrawal are all at `/case/<caseKey>`: the link is in every mail; whoever holds it can act, so do not forward it.
- Ownership verification is removed: at application time the subdomain is not yet issued, so there is nothing for the applicant to prove. The real acceptance is the public `/api/health` probe after connection.

### 1.3 Console (read-only records and ops)

- Console: `/admin/` (`admin/` static page + `/api/admin/*`). Details show the address, tier, public key, tunnel account, and contact email directly.
- **No review action**: submission is approval. The console only does record viewing, instance config, manifest entry generation, and probe/mail observation.
- Notifications: on submission, an approval letter to the applicant and a new-member alert to the operator; afterwards issuance, handoff, launch, disconnect, etc. send per-event mail. Internal notes are not sent out. Full event and trilingual text in [PARTNER-MAIL.md](PARTNER-MAIL.md).
- Accounts: `npm run admin -- create-admin <username>` (`server/admin-cli.mjs`). Passwords and session secrets do not enter this document or version control.
- Resend any mail: `npm run admin -- notify <application id> <event>`. The handoff mail is the exception: its body is the claim link, so reissue with `handoff`, which signs a new link and retires the previous one.

### 1.4 Write into the manifest and launch

**Automatic by default.** The resident worker (section 1.5) runs the `publish` step itself: it allocates the tunnel account and port, writes the manifest entry and the roster member together, and continues through the whole pre-staging. On the normal path no one runs `publish` by hand.

The manual command below is only for the exception path — the worker stopped, or redoing one application from scratch, where the account and port are chosen by hand:

```bash
cd xknot.si
npm run admin -- publish XK-2026-XXXXXX \
  --tunnel-account knot-tunnel-cpswang --tunnel-port 18090   # writes manifest and roster together
npm run validate:federation
npm run build                                    # validate, probe, build
# optional remote sync: see ops/README-deploy-aws.md, ops/deploy-hub.sh
```

`publish` defaults (`server/manifest.mjs`):

| Field | Default |
|------|------|
| `id` | the subdomain label (use `--id` to override on conflict) |
| `url` | `https://<label>.xknot.si`, built from the label |
| `tier` | `free` |
| `status` | `pending` (listed, not yet accepted; becomes `active` after `/api/health` passes) |
| `statsUrl` / `cardsUrl` | `null` (optional, edited in the manifest later) |

Name, intro, locale, tags are not in the manifest: `publish` only writes the issued zone. After connection, remind the partner to open their own instance's `/admin` → **XKnot** and fill in the site profile; without it the portal uses the issued-zone fields and fallback text.

`publish` writes both `instances.json` and `federation.json`: the membership facts (`mode` always `subdomain`, the `tunnel` account and port) come from `--tunnel-account` / `--tunnel-port`, `host` takes the `url`'s hostname, and both files must pass validation before anything is written. On the manual path, giving only the manifest and no tunnel params still leaves the roster missing this entry, and the build stops.

DNS and the tunnel are handled by the worker, not by hand: the `dns` step checks that `*.xknot.si` already resolves to the entry host (a wildcard preconfigured once by ops), and the tunnel is started by the instance itself after it reads its progress (section 1.5).

### 1.5 Pre-staging, exchange, and finish

After approval it is not "exchange one message per step", but the hub finishing everything first, then meeting once.

**Now done automatically by a resident process by default.** `xknot-provision` (`ops/provision-worker.mjs`) scans every 20 seconds: applications that are approved, have a public key, and have no connection record yet get a run created, then advance step by step through `allocate → publish → account → sshd → static → dns → vhost → tls`. Each step is idempotent; a failure only records an error code and retries after a backoff (30 s, 2 m, 10 m, 30 m, 2 h, counted per step). `tls` stops after five attempts instead of retrying forever: continued failures would only widen Let's Encrypt's failed-validation limit, which is five per hostname per hour. When done it enters `awaiting_tunnel`; once probing `https://<subdomain>/api/health` passes, it switches the entry conf from the placeholder page to whole-site reverse proxy and changes the manifest's `status` to `active`. If the wait for the tunnel exceeds 30 minutes (`XKNOT_AWAITING_TIMEOUT_MS`), the worker records one `instance.awaiting_stalled` event instead of leaving the run silently parked.

| Phase | Who | Done when |
|----|------|------------|
| pre-staging | hub (automatic) | manifest `pending` and roster member written; account, port, static page, subdomain conf, public key, sshd `Match`, DNS check, certificate all ready |
| exchange point A | instance fetches | the instance reads `GET /api/case/<key>/progress` by case key, gets the entry host, account, and port from `handoff`, writes them into `sites/<site>/tunnel.env` and starts the tunnel; `issued` has the issued id, address, tier, and date |
| finish | hub (automatic) | after the probe passes, changes `status` to `active`, then recomputes the portal snapshot (`ops/republish.mjs`); the card appears on the home page; `xknot-republish.timer` tops up every 10 minutes. `XKNOT_AFTER_ACTIVATE` can also hang one custom command |
| finish | instance (automatic) | seeing `run.state = active`, writes `issued` into `sites/<site>/xknot.env` and restarts the Backend; `/api/federation/profile` has content from then on. If the access material carried a relay token, the login keys now go through the hub relay |

**Communication direction.** The instance is behind NAT; the hub cannot dial in. Every action is the instance connecting out: submitting the public key, reading progress, fetching handoff parameters. The case key is itself the capability credential, so no separate claim link is issued.

**The only external precondition is DNS.** The entry domain needs a wildcard `*.xknot.si → entry public IP`; without it, the `dns` step keeps reporting `dns_missing`, and the error code shows directly in the XKnot section of the instance admin UI.

Pre-staging can finish in one pass because **the public key is handed over at application time** (section 1.2). The instance side now generates and submits the key automatically; no one has to paste it into the case page.

**Listing ≠ connected**: when written into the manifest, `status` is `pending` — not probed, not on the portal; only after acceptance does it become `active`. Details in [HANDOFF.md](HANDOFF.md).

For manual re-runs (worker stopped, or redoing one application from scratch): `node ops/provision-worker.mjs` runs the same steps; or follow [HANDOFF.md](HANDOFF.md)'s ten-item checklist alone.

`*.xknot.si` belongs to PaulWang and is issued by the rights holder; see the README "Ownership and license" and [FEDERATION.md](FEDERATION.md) section 8.

## 2. Connecting: entry host + reverse tunnel

Applies when the instance sits on a machine that usually has no fixed public IP (home broadband, behind NAT, can only initiate outbound), with the hub issuing the subdomain and connecting it to the entry.

It needs a public entry host holding the certificate and static files, and the instance initiating an outbound reverse tunnel. **This is the instance side's deployment shape, not part of the hub**; concrete config and commands are in the instance repo's [ops/entry/README.md](../../knot-platform/ops/entry/README.md).

```text
browser ──HTTPS──▶ public entry (nginx + certificate)
                     ├── /      before connection: the placeholder page on the entry disk /var/www/<id>
                     │          after connection: the whole site goes through the tunnel, showing the instance's own WebUI
                     └── /api/ ─▶ 127.0.0.1:18081
                                              │   the loopback port on the entry sshd
                                              ▼
                                     reverse tunnel (instance initiates)
                                              ▼
                           instance behind NAT 127.0.0.1:8080 (Knot Backend)
```

**After connection the whole site goes through the tunnel; the entry disk keeps only the placeholder page and the ACME challenge.** In the conf generated during pre-staging, `/` serves a placeholder page ("subdomain issued, entry connecting") and `/api/` is already connected to the loopback port for the health probe; once the probe passes, the worker uses the same generator to change `/` to a reverse proxy too, and the placeholder page retires. So the partner does not need to push the WebUI artifact to the entry host, and after launch there is no "API works, page is stale" state.

The entry template also has a `KNOT_ENTRY_SERVE=static` deployment shape (pages come from the entry disk, only `/api/` goes through the tunnel) — that is for self-built entries, not the default path of issued subdomains; see [ops/entry/README.md](../../knot-platform/ops/entry/README.md).

The hub cares about only three things here:

| Item | Requirement |
|----|------|
| What it is not | **not** pointing DNS A to a home LAN IP; **not** a traditional DDNS client changing A records |
| What it is | the entry holds the public IP and certificate; the instance uses SSH remote forwarding to connect the entry's loopback port to the local service |
| Manifest | `url` must be **public HTTPS** (reachable through the entry), not `http://192.168.…` or `http://127.0.0.1:…`; the probe address is derived from it |
| Keys | only on the running machine's `~/.ssh/`, **not in the repo, not in this document** |
| Roster | `mode: "subdomain"`, `tunnel: { account, port }` required, not allowed to be null |

The DNS, certificate, static root, `server` block, tunnel account, and port in this section are **all finished by the hub alone before exchange point A** — no partner presence or prior work needed. The only thing the partner must hand over at application time is the public key. Order and the ten-item checklist are in [HANDOFF.md](HANDOFF.md) section 3. Template and steps in [ops/entry/README.md](../../knot-platform/ops/entry/README.md); wildcard multi-tenant auto-server is not done (section 6).

`ops/README-deploy-aws.md` notes: the tunnel user `knot-tunnel@` must be separately provisioned on the entry host before the tunnel is used; the entry host is given by the deployment config, with no default value in the repo.

**Each subdomain must have its own tunnel account and loopback port, not shared with existing instances on the same machine** — the first matching `Match` block wins, and `PermitListen` allows only one port. Per-item handoff in [HANDOFF.md](HANDOFF.md).

### 2.1 Changing IP

An IP change does not require changing any manifest field: the instance reconnects, the entry host's loopback port is unchanged, and the probe recovers automatically. The same applies after switching home networks.

Changing the **subdomain label** is changing identity, not changing a string:

1. The partner emails the operator (`manwjh@gmail.com`), stating the instance id, the new label, and the reason.
2. Staff re-issue as a new application, change `instances.json`'s `url` and `federation.json`'s `host`, and run `npm run validate:federation`.
3. The old subdomain is reclaimed per the rights-holder flow; after the portal snapshot is recomputed, the entry points to the new address.

Once the address changes, there is no 301 transition; links at the old address will break. Try to settle the label on the first submission.

---

## 3. Federation probe notes (`/api/health`)

The hub's L2 runs in two places: `ops/check-health.mjs` at build time, and the resident timer `ops/watch-health.mjs` (every 15 minutes, see section 5).

### 3.1 What the instance side should satisfy

| Item | Requirement |
|----|------|
| Method | `GET`, response `Content-Type` parseable as JSON |
| Success body | `{ "ok": true, "service": "…", "version": "…" }` (`ok === true` is the hard condition) |
| URL | always `url` + `/api/health` (derived by `ops/probe-target.mjs`); `url` must be **https**, with no URL username/password |
| Redirect | the hub does **not follow** redirects; 3xx is `down` |
| Timeout | 5 seconds; ≤2s is `up`, >2s is `degraded` |
| Credentials | the hub sends no Cookie and no token |

Entries whose `status` is not `active` are not probed. While the manifest `status` is still `pending` (listed, not accepted) it is not probed and status is `unknown`, which is legal.

### 3.2 Private and unreachable addresses

| Layer | Current state (repo is authoritative) |
|------|-------------------|
| Contract | [FEDERATION.md](FEDERATION.md) §6.6 / §8: probes and fetches reject loopback, private ranges, link-local, and cloud-metadata addresses after DNS resolution |
| L2 implementation | `ops/check-health.mjs` enforces `https`, no redirects, timeout, `ok === true`, and rejects private addresses via `ops/fetch-guard.mjs` |
| L3 / activity data | `ops/fetch-cards.mjs` and `ops/fetch-stats.mjs` use the same guard; failure keeps the previous copy and does not affect the build |

Practical conclusion: **the manifest's `url` cannot be an address reachable only on the intranet** — the prober resolves and probes on the public side, and an intranet address is judged `private_address` or `down`. A tunneled instance should have the entry reverse-proxy `/api` through the tunnel, so the probe is still `https://<subdomain>/api/health`.

### 3.3 Application address vs probe address

- The application form's subdomain label: just a registered address; **not resolved or fetched on receipt**.
- Only after writing into `instances.json` and changing `status` to `active` does it actively GET `url` + `/api/health` (and, in the future, `cardsUrl`).

---

## 4. Disconnect monitoring and temporary hiding

`ops/watch-health.mjs` runs a probe every 15 minutes, writes results and consecutive duration into `var/health.json`, and sends mail per the rules below. **`instances.json` is never auto-changed**; hiding is a one-time judgment at portal render time.

| Situation | Trigger | Action |
|------|------|------|
| unreachable 24 consecutive hours | from `downSince` | mail the instance `contact` a reminder: address, first-failure time, auto-return to the list on recovery |
| unreachable 7 consecutive days | from `downSince` | mail "temporarily closed from the federation list"; the portal no longer shows the entry |
| recovery | any probe `up` / `degraded` | clear the timer and hide flag; the entry returns to the list automatically, **no reapplication** |
| 14 days after listing, still not accepted | from the manifest `since`, and `status` still `pending` | internal reminder to the operator to follow up the handoff |
| 30 days after listing, still not accepted | same | temporarily hidden from the portal, plus an internal reminder |

Key points:

- Each notice sends once, recorded in `var/health.json`'s `notified`; repeated runs do not resend.
- Hiding does not affect the instance itself: database, accounts, content, points are all still on the partner machine, and the manifest entry stays.
- For manual review or recovery, email the operator `manwjh@gmail.com`.
- Without SMTP configured, the script still writes status, just sends no mail; such records appear in the log.
- `--dry-run` only probes and prints, writing no status and sending no mail, to avoid the preview eating pending-send flags.

Implementation: `ops/watch-health.mjs` (mail and scheduling), `ops/check-health.mjs` (probe and state machine). Timers: `ops/xknot-health.service`, `ops/xknot-health.timer`.

---

## 5. Responsibility boundary among hub / entry / instance

| Role | Responsible for | Not responsible for |
|------|------|--------|
| **hub** (`xknot.si`) | `instances.json`, application records and console, probe and disconnect notices, portal static site | user accounts, content, points, orders; hosting partner sites; deploying or maintaining tunnels for partners |
| **entry host** (nginx/sshd on the public machine) | certificate, outbound HTTPS, static pages, reverse-proxying `/api` to the tunnel port; tunnel user isolation | business databases; changing `instances.json` |
| **instance** (the partner's Knot, currently `knot-platform`) | own deployment, database, uploads, accounts, review, maintaining the tunnel, providing `/api/health` and optional showcase | changing the hub manifest; asking the hub to host content |

The two sides' code and scripts are stored separately: the hub's deployment files are in the `ops/` at this document's level; the instance's deployment files are in [`knot-platform/ops/`](../../knot-platform/ops). The hub does not reference the instance's files, and the instance does not reference the hub's; the two meet only through the HTTP contract and the access material, and this document only explains policy and links. Swapping the instance implementation (Go, Rust, another language) does not affect the hub's code, manifest, or probes.

**The hub host and the entry host can be the same machine — the current deployment is exactly that.** Role ownership does not merge just because they share a machine: the hub's config belongs to `xknot.si/ops/`, the entry's config belongs to the instance side `knot-platform/ops/entry/`. The easiest mistake on a shared machine is editing the hub site with the entry's nginx config, or the reverse. The full concept map and ownership are in [`docs/concepts.md`](../../docs/concepts.md).

**"Entry" is split into two places by scope**: reusable templates in [`knot-platform/ops/entry/`](../../knot-platform/ops/entry/) (usable by any instance); the concrete conf and connection runbook for hub-issued subdomains in [`xknot.si/ops/entry/`](../ops/entry/) (hardcoded domains, changed only by hub staff).

- hub nginx: `ops/xknot.si.conf`; hub deployment notes: `ops/README-deploy-aws.md`
- public entry template (instance side): `../../knot-platform/ops/entry/README.md`
- entry for issued subdomains (hub side): `../ops/entry/`, holding only confs and runbooks needing manual maintenance; `cpswang` is written by automatic provisioning and is not in the repo

Billing and subdomain services do not happen in the hub's order flow (see the README "Listing and billing").

---

## 6. Not implemented / separate tasks (do not treat as live)

| Item | Status |
|----|------|
| auto-approval / case page / one-time claim page | **implemented**: submission is `approved`, `/case/<caseKey>`, `/claim/<token>`; the email-confirmation gate is removed |
| address validation | **implemented**: `server/validate.mjs` (subdomain label 6–32 chars, reserved names, same-label dedupe; `mode` / `domain` retired) |
| subdomain label precheck | **implemented**: `GET /api/subdomains/check`; `ops/subdomain.mjs` judges length, reserved names, taken, and gives candidates |
| member login (email + auth code) | **implemented**: `/api/member/code`, `/api/member/session`, `/api/member/logout`; the portal right column shows site status, health, activity counts, and showcase count |
| disconnect reminder and temporary hiding | **implemented**: `ops/watch-health.mjs` + `ops/check-health.mjs` |
| free / paid tiers | **implemented**: manifest `tier` is `free` / `paid` (`demo` for samples only), default `free`, operator upgrades manually |
| auto-issue DNS after approval | **not implemented**: the worker only *checks* DNS (step `dns`). The wildcard `*.xknot.si → entry IP` is preconfigured once by ops, not issued per application |
| traditional DDNS (client changes A to current egress IP) | **not done**; NAT scenarios use entry + SSH reverse tunnel |
| issued subdomain + DNS to the partner's own fixed IP (no tunnel) | **unsupported**: access has only the "entry host + reverse tunnel" shape; this combination fits neither side, and `validate-federation.mjs` rejects it. For a fixed IP, use an own domain and self-build the site, outside the federation |
| single-subdomain entry config | **exists** (instance side): the entry and nginx are rendered by the instance implementation itself. Current implementation is `knot-platform`: entry file [`sites/_template/entry.example.env`](../../knot-platform/sites/_template/entry.example.env), template [`knot-platform/ops/entry/site.conf.template`](../../knot-platform/ops/entry/site.conf.template), steps in [`knot-platform/ops/entry/README.md`](../../knot-platform/ops/entry/README.md). The hub only requires "one account and one port per subdomain, `/api` reachable to the instance" |
| wildcard multi-tenant `*.xknot.si` entry nginx | **not done**: the worker generates one conf per subdomain automatically (steps `vhost` / `tls`), still no single per-Host tenancy |
| hub site HTTPS / NS switch details | see `ops/README-deploy-aws.md`; certificate and some DNS steps are marked separate tasks |

## 7. Mail relay (on by default)

When your own SMTP is hard to deliver, hand the notification to the hub. Contract in [FEDERATION.md](FEDERATION.md) section 7.
**This is now the default path**: the access material carries a relay token, so the instance does not need to configure its own SMTP.

| Item | Notes |
|----|------|
| Precondition | instance in the manifest with `status: active`; hub has SMTP configured |
| How to enable | on by default. The access material the operator generates via `access` carries `XKNOT_HUB_RELAY_TOKEN`; the instance writes it into the access material and restarts — no node-side code change |
| How to disable | per instance on the hub: `relay-disable <instance>` (recoverable) / `relay-revoke <instance>` (irreversible); globally: the `/admin` mail master switch (one click stops, recoverable) or `XKNOT_RELAY_ENABLED=0` (stops only relay). Instance side for pure SMTP: just leave this item out |
| Instance fallback | with a working local SMTP (host and sender address) configured too, a stopped or exhausted relay falls back to the instance's own SMTP; a relay-only instance cannot mail sign-in keys while relay is off |
| Instance config | `XKNOT_HUB_ORIGIN=https://xknot.si`, `XKNOT_HUB_RELAY_TOKEN=…`; the send address is derived from the hub address |
| Sender | always the hub's `MAIL_FROM`; the instance cannot override |
| Reply | `Reply-To` must fall within the instance's own domain; when omitted, the manifest's `contact` is used |
| Content | plain text only, ≤4000 chars; no attachments, HTML, cc, or bcc |
| Quota | default 50 per 24 hours, adjustable; 6 per minute per credential |
| Record | the hub keeps only the recipient domain, address hash, and result, no body |
| Disable | operator `relay-disable <instance>` takes effect immediately and is recoverable; `relay-revoke <instance>` is revocation, irreversible. Neither affects the instance's other features |

Bounces and complaints are the instance's own to watch. Abuse can get the shared sending domain downgraded for everyone, and the credential will be revoked outright.

---

## 8. Related files

The hub's own file map — what each script and directory does — is the single copy in [HUB.md](HUB.md#2-directory); it is not repeated here. For the partner side, the three entry files are:

| Path | Use |
|------|------|
| [`knot-platform/ops/entry/README.md`](../../knot-platform/ops/entry/README.md) | entry + tunnel realization |
| [`knot-platform/sites/_template/entry.example.env`](../../knot-platform/sites/_template/entry.example.env) | per-entry site config template (domain, static root, conf, serve mode) |
| [`knot-platform/ops/entry/sshd-tunnel.conf.template`](../../knot-platform/ops/entry/sshd-tunnel.conf.template) | sshd config for the entry tunnel account |

Keys, passwords, and PEM paths live only in each machine's private environment and `~/.ssh/`; this document and the repo do not include them.
