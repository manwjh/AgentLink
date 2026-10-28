# XKnot Federation · Listing Handoff Sheet

Version 3.2.

[JOIN.md](JOIN.md) explains policy: how to apply and how to connect after issuance. This document answers a single question — **from application approval to instance connection, what each side does and where they meet**.

> **Current state: automatic by default.** After approval and with the public key in, the resident `xknot-provision` process on the entry host finishes the pre-staging automatically in the order of section 3 (`ops/provision-worker.mjs`, step code in `server/provision.mjs`). When done, the instance reads `GET /api/case/<key>/progress` by case key to take the entry host, account, and port, writes its own `tunnel.env`, and starts the tunnel; the hub changes it to `active` once probing `/api/health` passes. With `knot-platform` nobody has to open the admin page for this: the Backend polls progress itself (`KNOT_XKNOT_POLL_SECONDS`, default 60, 0 disables).
>
> Sections 2–5 below still hold, but only in two situations: the worker is stopped, or a given application must be redone manually from scratch. The rules written into code are `server/provision.mjs` and `ops/provision-worker.mjs`; where they diverge, change the code first, then this sheet.

Copy one per new instance and fill it in before starting. Any part left blank is a part not yet settled — do not start.

![Listing handoff: the hub finishes everything it can first, then meets once](handoff-flow.svg)

---

## 0. One sentence

**Meet exactly once.** The applicant hands over the public key at submission; after approval the hub finishes, in one pass, everything that needs **no partner presence** (manifest, roster, DNS, certificate, static page, entry conf, account, public key, access material); then comes an **exchange point A**, where each side hands over the one thing only it has; the remaining two steps each side does alone, with one final probe to close out.

Listing is not connection: when written into the manifest, `status` is `pending`, the hub does not probe and the portal does not show it; only after `/api/health` returns `ok: true` does it become `active`.

The application phase determines only the subdomain label. Access has only one shape:

| Address | Issued subdomain | Entry tunnel | Exchange point A |
|------|----------|----------|----------|
| `https://<label>.xknot.si`, hub-issued | required | required | account + port + public-key receipt |

A site with its own domain does not take this step: it is its own entry, needs no issuance, and has no tunnel.

---

## 1. Four phases

| Phase | Who runs it | Done when | Manifest `status` | Runtime status |
|------|--------|----------|----------------|----------|
| 0 application | partner | submitted (which is approval) + public key pasted at the case page | no entry yet | — |
| 1 pre-staging | hub | all eight steps of section 3 ready, run enters `awaiting_tunnel` | `pending` | `unknown` (legal) |
| A exchange | both sides once | the hub has the self-test receipt; the partner has the entry host, account, port, and `issued` from `progress` (the manual path sends a `/claim` link and handoff mail separately) | `pending` | `unknown` |
| 2 finish | both, separately | tunnel up, `/api` up, probe `up` | `active` | `up` or `degraded` |

There is only one rule: **everything the hub can do without waiting for the partner goes before A.** There is no back-and-forth before A, and no waiting for replies after A.

---

## 2. Phase 0: hand over the public key at application time

| Step | Who | Artifact |
|------|------|------|
| fill the form | partner | subdomain label + site profile |
| submit | partner | `POST /api/applications`, the platform approves and issues the subdomain on the spot |
| paste the public key | partner | the textarea at `/case/<caseKey>`, one line `ssh-ed25519 AAAA…` |
| record | hub | console read-only: the application is already `approved`, no review action |

**Why the public key at application time.** It is the only input of the pre-staging phase: the account, `authorized_keys`, and sshd `Match` all depend on it. Asking again after approval is one more round-trip, and A would drag into two rounds. The case page accepts the public key right after submission — already implemented (`POST /api/case/<key>/public-key`).

The private key never leaves the machine. The partner pastes only the `.pub` text; staff do not request, receive, or copy the private key.

If the public key is missing: pre-staging stops at the `account` step — it needs the key to write `authorized_keys`, and reports `public_key_missing`; the later `sshd`, `static`, `dns`, `vhost`, `tls` wait for the key. The run does not enter `awaiting_tunnel`, so `handoff` in `progress` stays `null` — the partner has no parameters to start the tunnel with.

---

## 3. Phase 1: hub pre-staging (no partner presence needed)

Done in order, each step with a verifiable artifact. The automatic path is `server/provision.mjs`'s `STEP_ORDER`: `allocate → publish → account → sshd → static → dns → vhost → tls`; when done, the run stops at `awaiting_tunnel` and no handoff mail is sent — the instance reads `GET /api/case/<key>/progress` by case key to take `handoff { host, account, port }` and `issued`, then writes `tunnel.env` and starts the tunnel. The table below lists the artifacts in the same order; a step counts as done only after `validate` passes.

| # | Action | Artifact | What happens if it stops |
|---|------|------|------------|
| 1 | write manifest | new `instances.json` entry, `status: "pending"` | no address to hang anything on |
| 2 | write roster | same-name member in `federation.json`: `mode`, `host`, `role`, `standing`, `since` | `validate` reports "not in the roster", build stops |
| 3 | allocate account and port | `knot-tunnel-<id>` + one dedicated loopback port, written into the roster `tunnel` | cannot create the account |
| 4 | DNS | A/AAAA of `<label>.xknot.si` points to the entry public IP | the certificate cannot be signed |
| 5 | certificate | `certbot certonly --webroot`, confirm the renewal job | the entry can only serve HTTP |
| 6 | static root and placeholder page | `/var/www/<id>` + `/` serves a static page | nothing visible on issuance day |
| 7 | subdomain conf (placeholder version) | `/etc/nginx/conf.d/<id>.conf`: `/` serves the placeholder page, `/api/` already on the loopback port; `nginx -t` then reload | the domain does not open |
| 8 | create account + install key + sshd | system account, `authorized_keys` (600), `Match User` block, `sshd -t` then reload | the partner cannot connect after A |
| 9 | access material and claim token (manual path) | `access` generates env + `handoff` generates the `/claim/<token>` link (72 hours); the automatic path sends no link, `issued` comes with `progress` | the partner cannot get credentials |
| 10 | send handoff mail (manual path) | `partner.handoff`, body has only the claim link; the automatic path relies on `progress` self-fetch and sends no mail | the partner does not know it can connect |

Notes:

- Steps 4 and 5 must come before step 7. Reloading a conf whose certificate does not exist yet takes the whole entry down.
- Step 8's `Match` block matches by account; **one subdomain, one account, one port**, never shared (reason in section 9 item 1).
- Step 8 installs the public key handed over in phase 0; if the fingerprint does not match, stop and ask — do not generate your own.
- Step 9 appears only in the manual path: the claim link shows once, and re-running `handoff` reissues a link and retires the one from the previous mail in the same transaction. The automatic path has no such step; the `handoff` field is given directly by `progress` once the node data is ready, and that field carries tunnel parameters only — the relay token is still issued by the operator.

After pre-staging, the hub has nothing left to wait for. At this point the public `https://<label>.xknot.si/` serves the static page, and `/api/health` hits the pre-connected loopback port with nobody listening yet, so it answers `502` — not the SPA fallback — while the manifest is still `pending` and no probe runs.

**The entry conf has two versions.** The one written during pre-staging serves `/` from `/var/www/<id>`'s placeholder page ("subdomain issued, entry connecting"), with only `/api/` pre-connected to the loopback port. The moment the probe passes, the worker rewrites this conf with the same generator: `/` reverse-proxies to the tunnel too, visitors see the instance's own WebUI, and the placeholder page retires (the static root is left only for ACME). The switch runs `nginx -t` first and writes the old content back on failure. Afterwards each round re-checks; a conf that is overwritten or deleted is switched back automatically.

---

## 4. Exchange point A: exchange only two things

This is the only place in the whole flow where both sides must be present at once. What is exchanged is "what only the other side has":

| Direction | Content | Why only it can give it |
|------|------|------------------|
| hub → partner | tunnel account, dedicated port, entry host, the installed public-key fingerprint (the automatic path takes them from `progress`; the manual path also has the `/claim` link) | the port and account are allocated by the hub |
| partner → hub | one line of `curl -s localhost:8080/api/health` output from the local machine | the instance is on the intranet; only the partner can test it |

The partner's receipt looks like this — one line is enough:

```text
{"ok":true,"service":"knot-platform","version":"0.7.0"}
```

Reading it: `ok` must be `true`. If it is not `true`, stop at A — do not start the tunnel. The tunnel would expose an unhealthy backend to the public as-is.

A is complete when: the hub has this receipt in hand, and the partner has the account and port. From then on there is no more "waiting for your confirmation".

---

## 5. Phase 2: finish (parallel, no waiting for each other)

| Step | Who | Action | Artifact |
|------|------|------|------|
| 2.1 | partner | start the tunnel, then install the resident service (auto-reconnect on drop) | the entry shows a listener |
| 2.2 | hub | add the `/api/` reverse proxy, `/api/admin` 404; `nginx -t` then reload | `/api` reaches the instance |
| 2.3 | hub | probe → `status: "active"` → recompute the portal snapshot (`ops/republish.mjs`, triggered on connect, plus a 10-minute timer as backup) → auto-send `partner.live` (`ops/notify-live.mjs`, once per application) → update the roster note | the portal shows the entry |

The order of 2.1 and 2.2 is not sensitive: if the reverse proxy is added first, `/api` is 502 while the tunnel is down, but the manifest is still `pending`, so the portal does not show it and the probe does not run — no down instance is hung out. 2.3 must come last.

The partner-side deployment items (which keys to write, which file they go in, is up to the instance implementation):

| Item | Value |
|----|----|
| public address | `https://〈subdomain〉` |
| tunnel peer | `knot-tunnel-〈id〉@〈entry host〉`, the private key is the local one |
| local and remote port | remote `〈1808x〉` → local backend port (Knot default 8080) |

When deploying with `knot-platform`, these land in `sites/<site>/tunnel.env`, written by the instance's own Backend once it reads progress (keys and examples in
[`../../knot-platform/ops/README.md`](../../knot-platform/ops/README.md) section 1 and 4),
installed by `deploy-site.sh` as the tunnel resident service. The entry conf is the hub's: the instance installs nothing on the entry host.
With another implementation, follow the table above; there is no need to know what `tunnel.env` is.

The access material and these deployment items are two different things: the access material only contains what the hub issues, no domain, port, or host.

---

## 6. Appendix: handoff sheet (copy and fill in)

Placeholders use `〈…〉`. The final version of the sheet goes into that instance's runbook, not into `instances.json`.

### 6.1 Identity

| Item | Value | Responsibility |
|----|----|--------|
| instance `id` | subdomain label (lowercase kebab, 2–32 chars; newly issued ones at least 6) | partner picks, staff confirm |
| public address | `https://〈subdomain〉.xknot.si`, built from the label | staff |
| operator / owner | 〈operator〉 / 〈owner〉 | partner |
| region | `region`: 〈country code or `GLOBAL`〉 | partner fills it in the instance `/admin` (self-described zone); staff do not write the manifest |
| contact email | same as on the application, also the later communication address; not in the manifest, belongs to the self-described zone | partner |
| public-key fingerprint (`SHA256:…`) | 〈fingerprint〉, received in phase 0, one copy kept by each side | partner hands over, staff verify |

### 6.2 Entry and tunnel

| Item | Value | Responsibility |
|----|----|--------|
| entry host | 〈host〉, SSH port 〈22〉 | staff |
| entry disk root | `/var/www/〈id〉` | staff |
| entry nginx conf | `/etc/nginx/conf.d/〈id〉.conf` | staff |
| tunnel system account | `knot-tunnel-〈id〉` | staff create |
| dedicated loopback port | `〈1808x〉` | staff allocate |
| private key | only on the partner machine, path of the partner's choosing, mode 600 | partner, **not handed over** |

### 6.3 Manifest and roster

Two files, each managing its own part. **The same `id` must be in both or neither**, otherwise the build stops.

Manifest `instances.json` (issued zone, used for portal rendering):

| Item | Value | Responsibility |
|----|----|--------|
| `id` | subdomain label | staff |
| `url` | `https://〈subdomain〉.xknot.si`, built from the label | staff |
| `since` | listing date | staff |
| `tier` / `status` | `free` / first `pending`, then `active` after acceptance | staff |
| `statsUrl` / `cardsUrl` | first `null`, filled when the partner wants to publish activity data or a showcase | staff |

The manifest does **not** write name, intro, or contact: that is the self-described zone, filled by the owner in their own instance's `/admin` and fetched by the hub via `GET /api/federation/profile` (see [FEDERATION.md](FEDERATION.md) section 4). So after acceptance, remind the partner to fill the profile; without it the portal only uses the issued-zone fields as fallback.

Roster `federation.json` (membership facts, not rendered):

| Item | Value | Responsibility |
|----|----|--------|
| `host` | the manifest `url`'s host; the two must match | staff |
| `role` / `standing` | `partner` / `regular` (`founder` / `permanent` for founding instances) | staff |
| `mode` | always `subdomain` | staff |
| `tunnel` | required `{ account, port }`, not `null`; account and port unique on the machine | staff |
| `listed` / `since` | `true` / listing date | staff |

### 6.4 Division of labor

| Item | Value | Responsibility |
|----|----|--------|
| dynamic paths through the tunnel | `/api/` | fixed |
| admin surface | entry `^~ /api/admin` returns 404, not tunneled | fixed |
| tunnel resident service | auto-reconnect on drop; which service manager is the partner's choice | partner |
| database, uploads, accounts, points, backups | partner | fixed |

### 6.5 People and time

| Item | Value |
|----|----|
| staff executor | 〈name〉 |
| partner executor | 〈name〉 |
| exchange point A time (with timezone) | 〈time〉 |
| handoff sheet issue date | 〈YYYY-MM-DD〉 |

---

## 7. Probe contract

The hub sends one `GET` to `<url>/api/health` at build time (`ops/check-health.mjs`). The address is derived from the manifest's `url` and needs no registration. The partner implements `/api/health` per this table.

| Item | Requirement |
|----|------|
| Protocol | must be `https`, no URL username/password |
| Method | `GET`, no Cookie, no token |
| Redirect | **not followed**; 3xx is `down` |
| Timeout | 5 seconds |
| Response body | must be JSON and `ok === true`, otherwise `bad_payload` |
| Instance identifier | optional. If `instance` is present it must equal the manifest `id`, otherwise `instance_mismatch` |
| Determination | ≤2s `up`, >2s `degraded` |

An instance joining the federation should include `instance` in the response (value from the access material's `XKNOT_INSTANCE_ID`). The hub uses it to confirm "is this domain actually the instance in the manifest"; instances without it are still judged by `ok`.

While the manifest `status` is `pending` it is not probed and runtime status is `unknown`. After acceptance it becomes `active`.

---

## 8. Boundary

The hub provides: entry page, site profile, runtime status, showcase, mail relay.

The hub does not provide, and does not host on behalf of:

- private keys, entry sudo, the partner's database and backups.
- the partner's content, accounts, points, orders, review.
- certificates or reverse proxies for the partner's own self-built domain; maintaining the tunnel for the partner.
- any write entry outside `instances.json`.

---

## 9. Common blockers

1. **Two instances sharing a tunnel account fail silently.** sshd's first matching `Match` block wins; two blocks for the same `User` only count the first; and `PermitListen` allows only one port. The second instance connects and cannot claim the port; with `ExitOnForwardFailure=yes` it exits directly, leaving only one `remote port forwarding failed` line in the log. Must be one subdomain, one account, one port.
2. **Assuming the WebUI has to be pushed to the entry host.** Nothing is pushed: the entry reverse-proxies the whole site back through the tunnel, and its disk only holds the placeholder, ACME, `robots.txt` / `sitemap.xml` and the snapshot. `/assets` sitting in the entry cache is an accelerator, not a copy anyone maintains — a new page means a new deploy on the instance.
3. **Changing the manifest to `active` too early.** The portal first hangs a down instance. Keep `pending` at listing, change to `active` after `/api` works.
4. **Not running `nginx -t` before reload, or installing the conf before signing the certificate.** The entry usually hosts multiple `server_name`s; one bad conf takes down a whole cluster.
5. **Assuming the probe address must be filled by hand, or treating the intranet address as `url`.** The probe address is derived from `url`; the manifest has no such field, and writing one fails validation; `url` must be a publicly reachable `https://…`, the build machine resolves on the public side, and an intranet address only gets `down`.
6. **Missing the public key during pre-staging.** Account created, `Match` written, `authorized_keys` empty — after A the partner cannot connect and the key has to be asked for again. The key is received in phase 0.
7. **Running the tunnel manually in a terminal only.** After a drop no one brings it back. The resident service is a completion condition, not an option.
8. **Setting the tunnel account's login shell to `nologin`.** `ForceCommand` runs through the login shell; the session exits immediately. Login restriction relies on `PermitTTY no` + `PermitOpen none` + `ForceCommand`, not on swapping the shell.
9. **Changing only the manifest and forgetting the roster.** No matching `id` in `federation.json`, `npm run validate:federation` fails outright, the build stops. Add both together.
10. **Manifest `url` not under `xknot.si`.** Access only has issued subdomains; both `validate-instances.mjs` and `validate-federation.mjs` reject it.
11. **Roster member without `tunnel`.** Every member goes through the entry tunnel; `null` is a validation error, not an optional field.

---

## 10. Definition of done

All four hold at once to count as delivered:

```bash
# 1. entry: the port is held by that tunnel account
sudo ss -lntp | grep 〈port〉

# 2. public: the health check is JSON with ok true
curl -s https://〈subdomain〉/api/health

# 3. hub: runtime status is up / degraded (manifest status already active)
cd xknot.si && node ops/check-health.mjs | grep 〈id〉

# 4. portal: the entry appears. On connect the worker already recomputed the snapshot,
#    and xknot-republish.timer tops up every 10 minutes.
#    To only check data without a whole-site build:
node ops/republish.mjs          # writes web/dist/data/hub.json; on the hub the timer writes /var/www/xknot/data/hub.json
```

Missing any one keeps the manifest `status` at `pending`, not announced as listed complete.

---

## 10.1 Credentials, public key, and claim links

The credentials in the handoff sheet (relay token, connectivity parameters) **do not go into mail bodies, nor into the public version of the sheet**.

```text
phase 0   partner pastes .pub at /case/<caseKey>
            │
            ▼
phase 1   hub creates the account, installs the key, writes sshd Match, allocates the port
            │
            ▼
         npm run admin -- access <application id> --id <instance id> --out /tmp/<id>-access.env
            │
            ├─ generates a one-time claim token (only SHA-256 stored)
            └─ sends partner.handoff, body has only /claim/<token>
                    │
                    ▼
exchange A  partner opens the claim page, clicks the button, plaintext shows once (72-hour expiry)
            │
            ▼
phase 2   write into the instance config (with knot-platform: ./ops/scripts/join-xknot.sh --payload <file>)
```

**The access material only contains what the hub issues**, an env file whose keys and semantics are in
[FEDERATION.md section 7.4](FEDERATION.md#74-接入件):

```bash
XKNOT_INSTANCE_ID=wang
XKNOT_HUB_ORIGIN=https://xknot.si
XKNOT_ISSUED_URL=https://wang.xknot.si
XKNOT_ISSUED_AT=2026-10-20
XKNOT_ISSUED_TIER=paid
XKNOT_ISSUED_STATUS=active
XKNOT_HUB_RELAY_TOKEN=xkr_wang_...
```

One fact, one key: the four `XKNOT_ISSUED_*` lines are a verbatim mirror of the manifest's issued zone. The instance stores and repeats them; it does not interpret the values, does not fill in a default when one is missing, and does not refuse to start over a value it does not recognise. An empty value means the hub has not said, and the instance shows it as unstated.

The send address is derived from the hub address, not written into the access material. It **does not** contain deployment topology: domain, port, entry host, and tunnel account are written by staff in the handoff sheet for people to read, and land in the partner's own deployment config (section 5). Thus the access material can go through mail claim, and the deployment config stays on the partner's own machine.

How the instance stores this file is its own decision: `knot-platform`'s convention is `sites/<site>/xknot.env`
(`0600`), written with `join-xknot.sh --payload`; another implementation just reads the same keys.

`access` writes the access material to the file named by `--out` and sets 600; without `--out` it only prints to the terminal.
**It issues one relay token by default** and writes it into the access material; only when pure SMTP is explicitly wanted do you add `--no-relay`.
The access material is issued by the operator, and `access` writes the same file whether the instance was connected automatically or by hand. Automatic connection hands over only the `issued` fields through `progress`; the relay token never travels that path, so an instance that wants hub relay mail asks the operator for one access material (one-time claim, 72 hours).

The `partner.issuance` mail is used only when the public key is late (its body asks the partner for the `.pub`). When the key arrives on time, it is skipped, and pre-staging sends `partner.handoff` directly after finishing — so the whole flow has only one mail waiting on partner action.

- The claim link shows once; expired or already claimed both require reissue.
- Re-running `handoff` issues a new link and retires every outstanding link of that application; use the link in the latest mail.
- Without a usable mail channel `handoff` refuses before writing anything (it reads `var/mail.env` when the shell has no SMTP variables). Add `--offline` to get a link for manual delivery: it prints `claimUrl` to the terminal and sends nothing. Do not commit this output to version control or chat.
- The mail body only says "where to claim", not "what to claim". Any credential plaintext in a mail counts as an incident.
- The claim page and case page have `access_log` disabled in nginx.
- To retire a link without reissuing: `npm run admin -- claims <application id>` lists them, `claim-revoke <claim id|application id>` revokes.
- Revoke access: `npm run admin -- relay-revoke <instance>`; the instance side deletes the access material (`knot-platform` uses
  `./ops/scripts/join-xknot.sh --remove`).

---

## 11. Related files

| Path | Use |
|------|------|
| [JOIN.md](JOIN.md) | application, auto-approval, entry and tunnel, probe notes |
| [FEDERATION.md](FEDERATION.md) | the hub contract |
| [HUB.md](HUB.md) | hub implementation and ops |
| [NAMING.md](NAMING.md) | terms and wording |
| [`../federation.json`](../federation.json) | federation roster: membership identity, access mode, tunnel account and port |
| [`../instances.json`](../instances.json) | instance manifest: issued-zone fields |
| [`../ops/validate-federation.mjs`](../ops/validate-federation.mjs) | roster validation (cross-checked with the manifest) |
| [`../../knot-platform/ops/README.md`](../../knot-platform/ops/README.md) section 4 | the instance-side tunnel: key, `tunnel.env`, resident unit |
| `ops/check-health.mjs` | the health probe implementation (source of section 7) |
| `ops/watch-health.mjs` | 15-minute patrol: 24h reminder, 7d hide |
