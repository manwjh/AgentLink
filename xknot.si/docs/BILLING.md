# XKnot Federation · Billing

Status: **draft**. No runtime code implements this yet.

Contract in [FEDERATION.md](FEDERATION.md), hub implementation in [HUB.md](HUB.md), joining in
[JOIN.md](JOIN.md), terms in [NAMING.md](NAMING.md).

---

## 1. Scope

Product: **federated access**.

| Sold | Not sold |
|------|------|
| The issued `<label>.xknot.si` address | Content, posts, showcases, or any hosted data |
| The entry's TLS certificate and renewal | The partner's machine, deployment, or database |
| The entry's static root and reverse proxy for the subdomain | The partner's users, accounts, or hosted data |
| The tunnel account, port, and `sshd` isolation | Upgrades or incident response performed *for* the partner |
| Coordination around backup and upgrade windows | Uptime guarantees and credit-backed SLAs |

Permanently out of scope:

| Item | Rule |
|------|------|
| Listing position | Never sold as a slot. A tier carries a badge and sort order; a partner who stops paying keeps the entry |
| Additional subdomains | One address per instance in every plan, `free` included |
| Revenue share, Connect, platform balance | No cut of anything sold elsewhere; no funds held for anyone |
| Support contribution | Voluntary, buys no access (4) |
| Bandwidth, latency, uptime | Not collected per instance, so not sold |

---

## 2. Money path

| Buyer | Seller | Product | Stripe account | State lives in |
|------|------|------|------|------|
| Partner | hub (`xknot.si`) | access subscription | the rights holder's account | `var/xknot.db` |

- The hub accepts payment only for its own access service.
- The hub's code is not a shared billing library.
- `xknot.si/` and `knot-platform/` do not import each other; this document covers the hub only.
- `free` is not a trial: no expiry, no conversion deadline, no proxy shutdown. A `free` entry stops
  being served only by a listing decision ([FEDERATION.md](FEDERATION.md) section 9) or by 3.6.

---

## 3. Plans

| Plan | Price | Intent |
|------|------|------|
| `free` | **USD 0**, no expiry | permanent, for a low-traffic site |
| `paid` | **USD 20 per month** | the same access, with entry capacity a busy site needs |

`paid` bills monthly or annually. The interval is a Stripe price, not a plan: both grant 3.1 unchanged.

| Interval | Amount | Effective per month | Discount |
|------|------|------|------|
| Monthly | **USD 20.00** | USD 20.00 | — |
| Annual | **USD 200.00** | USD 16.67 | two months free, 16.7% below twelve monthly payments |

- No proration and no mid-cycle change, of plan or of interval: cancel and subscribe again.
- No trial. `free` replaces a trial, so `trialing` never occurs (6).

### 3.1 Entitlements

| Entitlement | `free` | `paid` | Enforced by | Runtime shape |
|------|------|------|------|------|
| Issued subdomain | 1 | 1 | manifest | not a lever |
| Entry port, tunnel account, `sshd` isolation | 1 | 1 | `provision.mjs` | not a lever |
| TLS certificate | 1 | 1 | `provision.mjs` | not a lever |
| Health probe interval | 15 min | 15 min | `ops/check-health.mjs` | not a lever |
| Entry cache `max_size` | **64 MiB** | **512 MiB** | `renderVhost()` | config render |
| Entry cache `inactive` | 30 d | 30 d | `renderVhost()` | same for both |
| Snapshot poll interval | **60 s** | **20 s** | `XKNOT_SNAPSHOT_INTERVAL_MS` | scheduler |
| Entry traffic retention | **7 d** | **90 d** | `ops/traffic.mjs` `days` | read-time query |
| Relay mail per token per 24 h | **20** | **100** | `relay_tokens.daily_limit` | row value |
| Portal badge and sort | after `paid` | before `free` | `web/src/lib/hub.js` | derived |
| Help channel | public mail | direct operator line | policy, no code | — |

- The hub-wide relay ceiling (`RELAY_LIMITS.perHour = 240`, one shared SMTP) does not change with plan.
- No support column: a support contribution resolves to no entitlements (4).

### 3.2 Not entitlements

| Item | Rule |
|------|------|
| Request body size | `client_max_body_size 52m` for both plans. The instance owns the real limit (`KNOT_UPLOAD_ATTACHMENT_MAX_BYTES`, default 50 MiB). The entry passes through only |
| Subdomain count | 1 for both (1) |

### 3.3 Prices and discounts

| Rule | Detail |
|------|------|
| Amounts | Every amount is a Stripe price object: monthly, annual, support. Changing one is a Stripe edit plus a new price id in `var/billing.env`. No amount is computed in code, and `20` / `200` / `5` in a locale file or component is a bug |
| Annual discount | Expressed once, as the annual price's own amount. No coupon, no percentage constant, no `monthly * 12 * 0.833` |
| Displayed saving | Derived from the two amounts in `prices[]`. A hardcoded "save 16.7%" is a bug |
| Promotion codes | Created in the dashboard. The subscription Checkout session sets `allow_promotion_codes` when `XKNOT_PROMO_ENABLED=1` (default `0`); Stripe renders and enforces the field. The server validates and stores nothing about a code |
| Discount scope | Changes an amount only. A discounted `paid` subscription is `paid` with 3.1 unchanged; nothing reads a discount when resolving a plan |
| Support | No promotion codes: the amount is fixed (4) |
| Capacity | No coupon grants a 3.1 row. 3.1 stays the only path to entitlement |
| `tier` | The display truth, not the billing truth. Resolved in one function: `role === "founder"` → `paid` (5); active subscription → `paid`; otherwise `free` |
| `instances.json` | Never written by billing. A disagreement with the derived value is reported as drift (11) |

### 3.4 Refunds

| Rule | Detail |
|------|------|
| Default | Not refundable. The term appears on the Checkout screen before the card is entered, for both products (4) |
| Statutory right | Honoured. The operator refunds in the Stripe dashboard and the resulting state arrives through the webhook |
| Implementation | No refund endpoint, no console action, no separate state machine |
| Error correction | A charge we caused in error (duplicate, wrong amount) is reversed in the dashboard. This is not a refund of a valid sale |
| Cancellation | Access runs to `current_period_end` (6). That is not a refund |
| Disputes | Decided by the cardholder and the issuer. Recorded, never answered with a counter-refund |

### 3.5 Tier change

| Entitlement | Mechanism | Action |
|------|------|------|
| Cache `max_size` | rendered into the vhost | re-render + `nginx -t` + reload |
| Snapshot interval | `xknot-provision` loop | restart the worker, or read per-instance value (8.1) |
| Traffic retention | query parameter | none |
| Relay quota | row value | none |
| Badge and sorting | derived from `tier` | republish the manifest |

An entitlement is not in effect until its row has run. Cache fails silently: until the reload the
portal claims 512 MiB while nginx serves 64 MiB.

### 3.6 Reclamation of `free` entries

| Condition | Action |
|------|------|
| No requests for **90 days** | operator is warned in the console; entry stays listed |
| No requests for **180 days**, and no renewal in the last 180 days | `retired` by an explicit console action, freeing its port and certificate; the partner was notified twice |
| Instance unreachable for 7 days | hidden from the portal by `ops/check-health.mjs` |

- Never automatic on an unpaid invoice, never triggered by billing.
- Unreachability is hidden by health, not by reclamation, and does not depend on plan.
- A supporter mark changes no condition above.

---

## 4. Support contribution

A voluntary one-time **USD 5**. Not a plan, no recurring state.

| Aspect | Decision |
|------|------|
| Amount | **USD 5**, fixed by the price. No amount in the request body; a body carrying one is rejected |
| Mode | one-time Checkout (`mode=payment`) |
| Repeatable | yes; each payment is independent |
| Who may send it | a signed-in member of an entry on the roster. No anonymous page |
| Grants | a supporter mark on the portal |
| Never grants | capacity, rank, exemption from 3.6, any change to `tier` |
| Refunds | as 3.4 |
| Name | "support" / 支持. "Donation" / 捐赠 is not used in the UI, the copy, or the identifiers |

- No capacity: USD 5 granting 3.1 would undercut the USD 20 plan, and a time-limited grant would need a
  second lifecycle, a second expiry clock, and a second downgrade path.
- No ranking: 1 refuses to sell listing position.
- Member session, fixed amount, per-member rate limit. Stripe Radar is the last line against card
  testing.
- The amount, the refund term, and "not a subscription, buys no capacity" appear in the Checkout
  session's submit text — the screen where the card is entered. A route that cannot show them is not
  shipped.
- A dispute moves the row to `disputed` and removes the mark; an issuer reversal records `reversed`.

---

## 5. Founder entries

Founders are `role: "founder"`, `standing: "permanent"` in `federation.json`. Billing adds no field, no
flag, and no tier: it reads `role` and stays out of the way.

| Rule | Detail |
|------|------|
| Charged | No. No customer row, no upgrade action rendered |
| Entitlements | the `paid` column of 3.1, through the same resolver as a subscriber |
| Reclamation | not applicable; the roster forbids unlisting a founder |
| Outside the roster | no exemption — it is derived from `role` |
| Via Stripe | not grantable; neither a subscription nor a coupon |
| Subscribing | the button is absent. Payment is verified in test mode against a non-founder entry |
| Drift check | the exemption is a prerequisite: a founder is `paid` with no subscription, and is excluded from every drift row (11) |
| Tier label | `paid`, not `demo`. Sorting first would be an explicit portal decision, not a tier side effect |

Two properties of the current roster are outside billing and stay unchanged:

| Item | Rule |
|------|------|
| Ports | `wang` holds 18080 (below `FIRST_PORT = 18090`), `cpswang` 18090. `nextPort()` seeds from every roster port, so both are skipped correctly |
| Tunnel account | `wang` uses `knot-tunnel`, not `knot-tunnel-<id>`. `tunnelFor()` reuses the roster value |
| Resulting capacity | both founder slots are permanent, so 99 of the 101 ports are reclaimable |

---

## 6. Lifecycle

```
incomplete ──▶ active ──▶ past_due ──▶ unpaid ──▶ canceled
                 ▲            │
                 └────────────┘  (payment recovered)
```

| Stripe status | Plan | `tier` | Access service | Grace |
|------|------|------|------|------|
| `trialing` | `paid` | `paid` | full | — |
| `active` | `paid` | `paid` | full | — |
| `past_due` | `paid` | `paid` | full | until `XKNOT_BILLING_GRACE_DAYS` ends |
| `unpaid` | `free` | `free` | unchanged | — |
| `canceled` | `free` | `free` | unchanged | — |
| `incomplete` | `free` | `free` | not yet started | — |
| never subscribed | `free` | `free` | full | — |

- Interval does not appear here: an annual subscription moves through the same statuses with
  `current_period_end` a year out.
- Mid-term cancellation keeps access to `current_period_end`.
- **Billing never changes `instances.json.status`.** `status` is the listing decision (`pending` /
  `active` / `suspended` / `retired`); payment state is a separate axis resolved at read time.
- **Billing never removes a subdomain, stops a tunnel, or deletes an entry.** Downgrade is a capacity
  change: 3.1 falls back to the `free` column.

---

## 7. Data

`var/xknot.db`, defined in `server/store/schema.mjs` as inline `create table if not exists`,
plus numbered migrations gated by SQLite's `user_version`.

| Table | Columns | Purpose |
|------|------|------|
| `billing_customers` | `instance_id` (unique), `stripe_customer_id` (unique), `email`, `created_at` | one Stripe customer per instance |
| `billing_subscriptions` | `instance_id`, `stripe_subscription_id` (unique), `price_id`, `plan`, `status`, `current_period_end`, `cancel_at`, `created_at`, `updated_at` | only source of truth for entitlements |
| `billing_events` | `stripe_event_id` (unique), `type`, `object_id`, `created`, `received_at`, `processed_at`, `result` | webhook idempotency and replay record |
| `billing_sessions` | `instance_id`, `stripe_session_id` (unique), `plan`, `status`, `created_at` | reconciliation; a return page is never proof of payment |
| `billing_supporters` | `instance_id`, `stripe_session_id` (unique), `amount`, `currency`, `status`, `paid_at` | one row per contribution |

| Rule | Detail |
|------|------|
| Idempotency | `billing_events.stripe_event_id` is a unique index, not a convention |
| Content | no card data, no address, no invoice body: identifiers and statuses only |
| `billing_sessions` | answers "did this partner pay" without the Stripe dashboard; not consulted when granting entitlement |
| `free` | has no row. Absence of a subscription *is* the free plan |
| `billing_supporters` | not joined when resolving entitlements. The mark is "a row with `status='paid'` exists", so withdrawing it is one `update`. `status` is `paid` / `disputed` / `refunded` / `reversed`, each written from a Stripe event |

---

## 8. Interfaces

### 8.1 Per-instance snapshot interval

3.1's snapshot row requires `ops/provision-worker.mjs` to resolve the interval per instance, falling
back to `XKNOT_SNAPSHOT_INTERVAL_MS`, with the existing 5 000 ms floor kept as a hard minimum. Until
that lands the row is not enforced.

### 8.2 Routes

All under `XKNOT_BILLING_ENABLED=1`; at `0` every route answers `503 billing_disabled` and none appear
in the portal.

| Method and path | Auth | Request | Response |
|------|------|------|------|
| `POST /api/member/billing/checkout` | member session | `{ plan, interval }` | `{ url }` |
| `POST /api/member/support/checkout` | member session | — (amount fixed) | `{ url }` |
| `POST /api/member/billing/portal` | member session | — | `{ url }` |
| `GET /api/member/billing` | member session | — | `{ plan, interval, status, currentPeriodEnd, cancelAt, entitlements, supporter, prices[] }` |
| `POST /api/billing/webhook` | Stripe signature | raw event body | `{ received: true }` |
| `GET /api/admin/billing` | admin session | `?status=` | `{ summary, subscriptions, drifts }` |

`entitlements` echoes the resolved rows of 3.1.

### 8.3 Errors

| Code | Status | When |
|------|------|------|
| `billing_disabled` | 503 | master switch off |
| `support_disabled` | 503 | `XKNOT_SUPPORT_ENABLED=0` while billing is on |
| `not_member` | 401 | no member session, or the instance left the roster |
| `invalid_plan` | 400 | unknown plan |
| `invalid_interval` | 400 | unknown interval, or one the plan does not have |
| `already_subscribed` | 409 | an active or past-due subscription exists |
| `no_customer` | 409 | portal requested before any checkout |
| `upstream_error` | 502 | Stripe call failed; the body carries no Stripe message |
| `invalid_signature` | 400 | missing, stale, or mismatched `Stripe-Signature` |
| `rate_limited` | 429 | creation over the per-member limit |

### 8.4 Behaviour

| Rule | Detail |
|------|------|
| Return page | grants nothing. `success_url` shows "processing" while the webhook lands |
| Checkout idempotency | `Idempotency-Key` from `instance_id` + plan + interval + a five-minute bucket |
| Interval | chooses a price id (`STRIPE_PRICE_PAID_MONTHLY` or `STRIPE_PRICE_PAID_ANNUAL`), never an amount. An unknown pair is `invalid_interval`; no request field carries a number |
| Support idempotency | per member per minute; repeat contributions are legitimate |
| Prices | read from Stripe, cached in process for five minutes. An unfilled cache returns an empty `prices[]` and the portal shows "temporarily unavailable" |
| Webhook routing | one endpoint, two modes: `subscription` → 3.1, `payment` → one `billing_supporters` row. A `payment` session never reaches the entitlement code |
| Webhook auth | the only unauthenticated write path: exempt from the same-origin check, dependent on the signature alone |

---

## 9. Configuration

Stripe objects, created by hand.

| Object | Count | Notes |
|------|------|------|
| Product | 1 | access subscription |
| Price | 3 | monthly **USD 20.00**, annual **USD 200.00**, one-time **USD 5.00** |
| Webhook endpoint | 1 | `https://<hub>/api/billing/webhook`, both modes |
| Billing Portal configuration | 1 | cancellation allowed; plan and interval switching off (3) |
| Promotion codes | 0 or more | dashboard-created; used only when `XKNOT_PROMO_ENABLED=1` |
| Tax | decide once | Stripe Tax on or off, and whether the amounts are tax-inclusive. Follows the operating entity, which also determines invoice requirements. Changes what the portal displays, so it is settled before the first live payment |

Environment, in `var/billing.env` (`0600`, not in version control, not synced by
`ops/deploy-api.sh`), loaded by the unit's `EnvironmentFile=`:

| Key | Purpose |
|------|------|
| `XKNOT_BILLING_ENABLED` | master switch, default `0` |
| `XKNOT_SUPPORT_ENABLED` | support button, default `0`; ignored when billing is off |
| `XKNOT_PROMO_ENABLED` | show Stripe's promotion-code field on subscription Checkout, default `0` |
| `XKNOT_BILLING_GRACE_DAYS` | grace after `past_due`, default `14` |
| `STRIPE_SECRET_KEY` | server-side API calls only |
| `STRIPE_WEBHOOK_SECRET` | signature verification |
| `STRIPE_PRICE_PAID_MONTHLY` | monthly price id |
| `STRIPE_PRICE_PAID_ANNUAL` | annual price id |
| `STRIPE_PRICE_SUPPORT` | support price id |

- Changing a price is a new price object plus the matching key. Existing subscriptions stay on the
  price they bought.
- Installation mirrors the mail file: a second `EnvironmentFile=-/opt/xknot/var/billing.env` in
  `ops/xknot-api.service`, plus `env-file.mjs` in the CLI paths so `admin-cli` sees the same values.
- No SDK. `server/stripe.mjs` calls the REST API over `fetch` with form-encoded bodies; signature
  verification uses `node:crypto`. Zero runtime dependencies; `npm test` runs without a network.

---

## 10. Security

| Area | Rule |
|------|------|
| Card data | never reaches our servers: hosted Checkout and Portal only |
| Webhook | verify `Stripe-Signature` over the raw body, `t` tolerance 300 s, `timingSafeEqual` |
| Raw body | read the buffer before any JSON parse; other routes keep the 16KB limit, the webhook gets its own cap |
| Replay | unique `stripe_event_id`; a duplicate returns 200 without reprocessing |
| Out of order | re-fetch the subscription from Stripe on every subscription event; never trust embedded ordering |
| Failure | a handler failure returns non-2xx so Stripe retries; `processed_at` stays empty until success |
| Secrets | `var/billing.env` `0600`; not in the repo, not in logs, not in the console, not in a chat or a screenshot |
| Logging | event id, type, and instance id only — no email, address, amount, or Stripe object dump |
| Rate limits | checkout 3 per member per 5 min; support 2 per member per 10 min; webhook unlimited |
| Card testing | amount fixed in the session, never from the request body; a rejection is a Stripe-side `402`, never a custom code that confirms a card is live |
| Promotion codes | `allow_promotion_codes` is a boolean, so no code value reaches our server. Stripe validates what the customer types |
| Admin surface | `/api/admin/*` stays blocked at the entry; the webhook is the only billing route reachable from the internet |
| Refunds | no endpoint, no console action (3.4) |
| Disputes | answered with Checkout evidence; recorded, never counter-refunded |

---

## 11. Console and portal

| Surface | Rule |
|------|------|
| Portal right column (`web/src/components/BillingPanel.vue`) | plan, interval, resolved entitlements, one action. Interval choice shows both amounts from `prices[]` and the derived saving; a missing annual price removes the option rather than rendering a number. Absent, not disabled, when billing is off or the visitor is not a member. `free` sees "upgrade", never an expiry date. A founder sees no action |
| Support entry | outside the plan block, one line and one button. Never inside the plan comparison or beside the USD 20 figure |
| Supporter mark | a label next to the entry, no effect on `web/src/lib/hub.js` sorting, derived from `billing_supporters`. `free` and `paid` entries only |
| Console (`/admin/`) | a billing column per instance and a summary panel: active, past due, canceled, cash collected over 30 days, support contributions as a separate figure. Read from SQLite, not Stripe. Cash received, so an annual payment counts once in the month it was charged |
| Drift, shown and never auto-fixed | subscription active while the entry is `suspended`; subscription canceled while `tier` is `paid`; a customer row without a subscription; a `paid` subscription whose vhost still carries the `free` cache size. Founders excluded from every row (5) |
| Dormant `free` entries | a column, so reclaimable ports are visible (3.6) |

---

## 12. Operations

| Situation | Action |
|------|------|
| Paid, tier did not change | check `billing_events`; if absent, the webhook URL or secret is wrong — resend from the dashboard |
| Payment failed | let dunning run; after the grace period the plan drops to `free` |
| Tier flipped, old cache size still served | re-render the vhost, `nginx -t`, reload; the drift check (11) surfaces it |
| Refund requested | not by default (3.4). Where the law requires one, refund in the dashboard and let the webhook record it |
| Charge we caused in error | reverse it in the dashboard; note the operator's name in `events` |
| Annual subscription cancelled mid-term | access runs to `current_period_end`; no pro-rata refund unless the law requires one (3.4) |
| Promotion code abuse | disable the code in Stripe; no deploy, no server state |
| Support payment disputed | row moves to `disputed`, the mark disappears; an issuer reversal records `reversed` |
| "I thought USD 5 was an upgrade" | disclosure bug: check the Checkout submit text still carries section 4 |
| Access must continue during a dispute | manual override row, recorded in `events` with the operator's name |
| Webhook backlog | `GET /api/admin/billing` shows the oldest unprocessed event; Stripe retries for three days |
| Reconciling the portal | compare `billing_subscriptions` with `instances.json` `tier` |
| Rotating keys | write to `var/billing.env`, `systemctl restart xknot-api`, revoke in Stripe |
| Stopping billing | `XKNOT_BILLING_ENABLED=0`; existing subscriptions keep running in Stripe and must be canceled there |
| Backup | `var/xknot.db` is backed up with the two JSON files |

---

## 13. Tests

Run by `npm test` in `xknot.si`; no test opens a network connection, fixtures are captured events with
signatures computed locally.

| Area | Cases |
|------|------|
| Signature | valid, missing, stale, tampered body, repeated event id |
| Status mapping | every row of section 6 |
| Grace | `past_due` before and after expiry |
| Checkout | disabled switch, unknown plan, duplicate subscription, upstream failure |
| Interval | monthly and annual map to their own price ids; an unknown interval and a body carrying an amount are rejected; an annual subscription is `paid` with 3.1 unchanged |
| Discount | a discounted subscription resolves to `paid` with 3.1 unchanged; the displayed saving is derived from `prices[]`, and a missing annual price removes the option |
| Promotion codes | `XKNOT_PROMO_ENABLED=0` sends no `allow_promotion_codes`; `1` sets it; the support session never sets it |
| Entitlement | every row of 3.1 resolves from plan, not `tier`; a plan-less instance resolves to `free` |
| Founder | a `founder` resolves to `paid` with no subscription and no drift row; the same member as `partner` resolves to `free` |
| Support | `mode=payment` writes one `billing_supporters` row and changes no entitlement; `mode=subscription` never writes a supporter row; a disputed row removes the mark; the amount comes from the price id and a body carrying one is rejected |
| Refunds | no route, helper, or console action calls Stripe's refund API; `refunded` and `reversed` rows only come from Stripe events |
| Render | `renderVhost()` emits 64m for `free`, 512m for `paid`, and never a different `client_max_body_size` |
