# XKnot Federation · Partner Mail Templates

Version 2.3.0.

This document is the specification of `xknot.si → partner` mail: events, trigger conditions, recipients, trilingual full text, variables, idempotency keys, and link rules. The runtime source of truth is `server/notify.mjs`; the two must stay in sync. When changing text, change this document first, then the code, bump `TEMPLATE_VERSION`, and run `npm test`.

Contract in [FEDERATION.md](FEDERATION.md), join flow in [JOIN.md](JOIN.md), handoff rules in [HANDOFF.md](HANDOFF.md), terms in [NAMING.md](NAMING.md). Concept names in this document follow those: colloquial "节点" is written **instance** here, and "节点拥有者" is written **partner** or its **owner**.

---

## 0. Current state and scope

This chain is fully in code:

| Location | Role |
|------|------|
| `server/notify.mjs` | template registry `TEMPLATES[event]`, 9 partner mails + 2 internal mails, all three languages |
| `server/store/schema.mjs` + `server/store/mail-log.mjs` | `notify_log`, `claim_tokens`, application state, and `state_version` |
| `server/app.mjs` | submission (auto-approval), case actions, handoff, claim endpoints, and send triggers |
| `server/pages.mjs` | the `/case/`, `/claim/` two script-free pages |
| `server/admin-cli.mjs` | `notify` / `handoff` / `claims` / `claim-revoke` / `live` / `contact-revalidate` / `suspend` / `retire` / `notify-log` |
| `server/notify.test.mjs` | every event × 3 locales, asserting the id is included, internal notes are not sent out, no placeholder left, no credential plaintext |

The path of one mail:

```text
partner / owner                           hub xknot.si
     │  submit application ────────────▶ POST /api/applications (which is approved)
     │  ◀────────────────────  1 approved (with the case page link)
     │  ◀────────────────────  2 issuance
     │  ◀────────────────────  3 handoff (one-time claim page)
     │  ◀────────────────────  4 live
     │  ◀────────────────────  5 contact_revalidate (every 180 days)
     │  ◀────────────────────  6 suspended / 7 retired
     │  ◀────────────────────  8 unreachable_24h / 9 hidden_7d (runtime patrol)
```

The state machine allows only these transitions:

```text
submit ──▶ approved ──▶ withdrawn
```

`rejected` / `expired` are read-only states and are no longer produced.

---

## 1. Sending contract

### 1.1 Envelope and headers

| Item | Value |
|----|----|
| `From` | `XKnot 联邦 <no-reply@xknot.si>` (from `MAIL_FROM`, the instance cannot override) |
| `Reply-To` | `no-reply@xknot.si` |
| Subject | `[XKnot] {id} <action>`, no newlines, ≤120 chars |
| Body | plain-text UTF-8, ≤4000 chars |
| Other | no HTML, attachments, cc, or bcc; no tracking pixels |

**`Reply-To` also points to `no-reply`, which declares outright "do not reply".** `xknot.si`'s MX points to Aliyun and only sends (see `ops/README-deploy-aws.md`); replies bounce or fall into a black hole. Hence two hard requirements:

1. Every body must contain "本邮件由系统发出，不接收回复。" (this message was sent automatically; replies are not monitored).
2. Everything needing the applicant's action must carry a link, not rely on "reply to this mail".

### 1.2 Locale

| Item | Rule |
|----|------|
| Maintained locales | `zh-CN` (default), `zh-TW`, `en` |
| Selection | the application's `locale`; `zh-tw` / `zh-hk` / `zh-hant` → `zh-TW`, other `zh*` → `zh-CN`, everything else → `en` |
| Completeness | all three per event must be present; a missing one is a defect, fall back to `en` and log |

### 1.3 Idempotency and retry

| Item | Rule |
|----|------|
| Idempotency key | `{event}:{caseId}:{stateVersion}`, unique index in the DB |
| Repeated trigger | the second time with the same key is skipped, not resent |
| Transient failure | SMTP `4xx`, timeout, connection dropped: at most 3 tries, backoff 1 / 5 / 30 minutes |
| Permanent failure | SMTP `5xx`, invalid address, rejected content: no retry, record `failed` |
| While retrying | the row stays `pending` and keeps the idempotency key, so no second path can send the same event |
| Master switch turned off mid-retry | stop, record `skipped` with `mail_switch_off` |
| Stale `pending` | reclaimed as `failed` / `stale_pending` after 2 hours, so the event can be sent again |
| State rollback | the same event is not resent when state rolls back and re-advances (the key has a version; whether to bump is up to the implementation) |

Retrying is the only thing the hub can do about a rate limit on the receiving side. A
`421` at the wrong time is not the hub's reputation problem and there is nothing to fix
in the message; it is the sending IP being throttled, often because of other tenants on
the same shared pool. Sending again immediately only extends the block, which is why the
delays are minutes and not seconds.

A `5xx` is the opposite: the same message will be refused again. Recording `failed` and
leaving it to `admin-cli notify` is deliberate — an automatic retry would just be the same
rejection logged three times.

### 1.4 Rate limiting

| Scope | Cap |
|------|------|
| Single recipient address | 12 / day |
| Single recipient domain | 30 / day |
| Site-wide partner mail | 200 / day |
| Internal mail | 30 / hour |

The per-address cap leaves headroom for "one real partner going through submit → issue → handoff → live" (about 5 mails), while blocking scripted floods. Over the cap it is stored but not sent, recorded as `throttled`, the operator deciding whether to resend.

### 1.5 Records

New `notify_log`: event, case id, recipient domain, address hash, template version, message id, locale, result, error code, time. **No body, no full address, no full subject.**

Kept 90 days, cleaned daily.

`error` holds the SMTP verdict as a code, never the server's sentence: `421 4.7.28`,
`550 5.1.1`, `smtp_timeout`. The number alone does not say why, and the enhanced status
code (`4.7.28`) is the part that does — the free-text reason behind it is kept out because
it often quotes the recipient address, which this table must not hold. That sentence is
printed in the process log instead, with the local part masked.

### 1.6 Bounces

A `250` from the SMTP session is acceptance, not delivery. The receiving side can reject
the message afterwards, and the hub never sees that: `xknot.si`'s MX points at the mail
provider, so the bounce report lands in the provider's console rather than in a mailbox
this process reads.

What makes the loop closable at all is `message_id`. Every delivery records it (the part
before the `@`; the domain is always the sender's), and it is the only field that ties a
bounce report back to a row — the recipient address is stored as a hash and cannot be
matched. Ingestion is manual and deliberately so:

```
npm run admin -- bounce '<Message-ID>' --note '5.1.1 user unknown'
```

That flips the row from `sent` to `bounced`. It only touches `sent` / `accepted`, and an
unknown id is refused rather than guessed: marking a delivered message as bounced would
send the operator to resend a second copy. Rows written before this field existed have no
id and can only be matched by time and recipient domain.

### 1.7 Links

| Item | Rule |
|----|------|
| Form | always `https` absolute, no URL username/password |
| Case link | `https://xknot.si/case/<caseKey>`: a 12-byte opaque key, no application id; holding the link is enough to view status and submit material |
| Claim page | `GET` only renders the confirm button; consuming the token must be `POST` (to stop mail gateways prefetching) |
| Response headers | `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` |
| Logs | nginx disables `access_log` for `/case/`, `/claim/`, `/api/claim`, `/api/case/` |
| Validity | claim page 72 hours, single use |
| Body wording | the mail says where to claim, never what is on the claim page. The payload is chosen per delivery, so a fixed list of contents would promise items that this delivery does not carry |

### 1.8 Variable hygiene

- All variables are inserted after stripping `\r`, `\n`; user-filled fields do not enter mail headers.
- `name` ≤40, `operator` ≤80, `url` ≤200, `{id}` ≤32, truncated beyond.
- The body only states facts, not judgments: no internal notes, IP, hash, or other applicants' data.
- No credential plaintext, private key, or SMTP password may appear in a body.

---

## 2. Variables

| Variable | Meaning | Example |
|------|------|------|
| `{id}` | application id | `XK-2026-7F3C9Q` |
| `{name}` | site name | `Knot · wang` |
| `{url}` | site address | `https://wang.xknot.si` |
| `{operator}` | operator / owner | `PaulWang` |
| `{origin}` | portal address | `https://xknot.si` |
| `{caseUrl}` | case page | `https://xknot.si/case/<opaque>` |
| `{confirmUrl}` | case-page confirm entry | `https://xknot.si/case/<opaque>` |
| `{claimUrl}` | one-time claim page | `https://xknot.si/claim/<opaque>` |
| `{portalUrl}` | portal entry link | `https://xknot.si/en/` |
| `{supportUrl}` | outward support entry | optional; empty omits the whole line |
| `{claimTtl}` | claim validity, following the token's actual TTL (1–168 hours) | `72 小时` |
| `{entryHost}` / `{account}` / `{port}` | entry and tunnel | `54.169.33.64` / `knot-tunnel-wang` / `18080` |
| `{healthUrl}` | probe address | `https://wang.xknot.si/api/health` |
| `{statusLabel}` | runtime status | `正常` |
| `{contactMasked}` | masked contact | `m***@gmail.com` |
| `{effectiveAt}` / `{reclaimAt}` / `{exportUntil}` | time points | `2026-11-01` |
| `{resumeCondition}` | resume condition | filled by the operator, states only the condition, not judgment |

---

## 3. Events and states

### 3.1 State transition → event

| Transition | Event | Recipient |
|------|------|--------|
| submit (auto `approved`) | `partner.approved` | applicant |
| subdomain issued, access parameters settled (only `subdomain`) | `partner.issuance` | owner |
| access material generated, one-time claim ready | `partner.handoff` | owner |
| acceptance passed, manifest `status` → `active` | `partner.live` | owner |
| runtime `active` → `suspended` | `partner.suspended` | contact |
| runtime `active` / `suspended` → `retired` | `partner.retired` | contact |
| probe `down` for 24 consecutive hours | `partner.unreachable_24h` | contact |
| probe `down` for 7 consecutive days | `partner.hidden_7d` | contact |
| every 180 days | `partner.contact_revalidate` | contact |

There is no email-verification, hold, or rejection mail: submission is approval, and all later actions start from the case page or the operator.

---

## 4. Templates

Subjects are uniformly `[XKnot] {id} <action>`. The body's closing signature is fixed and not repeated.

### 4.1 `partner.approved`

**Subject**: `[XKnot] {id} 已通过，地址已签发`

```text
{operator} 你好：

你提交的 XKnot 联邦加入申请（{id}）已通过。平台在收到申请时自动核对，通过即生效，不需要再等回信。

站点：{name}
地址：{url}
当前档位：免费

接下来中枢会自动把实例写进联邦清单并接通入口。收录当天，门户的实例目录里会出现这个条目：状态先是「待验收」，公网 /api/health 通过后转为在线。

收录不包含入口主机与 SSH 反向隧道，需要时另行确认。

委托发信默认由中枢代发：要用它，请运营方签发一次接入件（一次性领取），里面带发信凭据；不必自己配 SMTP。

申请状态与公钥提交：
{caseUrl}

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 已通過，位址已簽發`

```text
{operator} 你好：

你提交的 XKnot 聯邦加入申請（{id}）已通過。平台在收到申請時自動核對，通過即生效，不需要再等回信。

站點：{name}
位址：{url}
目前檔位：免費

接下來中樞會自動把實例寫進聯邦清單並接通入口。收錄當天，入口的實例目錄裡會出現這個條目：狀態先是「待驗收」，公網 /api/health 通過後轉為上線。

收錄不包含入口主機與 SSH 反向隧道，需要時另行確認。

委託發信預設由中樞代發：要用它，請營運方簽發一次接入件（一次性領取），裡面帶發信憑證；不必自己設 SMTP。

申請狀態與公鑰提交：
{caseUrl}

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] {id} is approved and the address is issued`

```text
Hello {operator},

Your application to join the XKnot Federation ({id}) is approved. The hub checks every application as it arrives, so approval takes effect immediately and no further reply is needed.

Site: {name}
URL: {url}
Current tier: free

The hub will now add the instance to the federation manifest and connect the entry. The entry appears in the portal's instance directory on the day it is listed: first as pending, then as online once the public /api/health check passes.

Listing does not include the entry host and SSH reverse tunnel, which are confirmed separately.

Delegated mail is on by default: when you want it, ask the operator to issue an access material (one-time claim), which carries a relay token; you need no SMTP setup of your own.

Application status and public key:
{caseUrl}

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.2 `partner.issuance`

**Sent only when the public key is late.** In the normal flow the applicant has already handed over `.pub` at `/case/<caseKey>`, so after approval the hub finishes the config directly and sends `partner.handoff`, skipping this one. If the case page never received a public key, use `npm run admin -- notify <application id> partner.issuance` to request it; pre-staging stops at the `account` step at that point (no key means no `authorized_keys`).

**主题**：`[XKnot] {id} 的接入信息已确定`

```text
{operator} 你好：

实例 {id}（{name}）的接入信息已确定。

实例地址：{url}
入口主机：{entryHost}
隧道账号：{account}
专属端口：{port}

下一步需要你做两件事：

1. 在本机生成密钥，私钥留在本机：
   ssh-keygen -t ed25519 -f ~/.ssh/knot-entry-{id} -N ''

2. 把 ~/.ssh/knot-entry-{id}.pub 的内容交给我们：
   {caseUrl}

只交 .pub。不要交私钥，也不要贴进邮件或网页。

我们确认公钥已装、端口已就绪后，会再发一封交付信。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 的接入資訊已確定`

```text
{operator} 你好：

實例 {id}（{name}）的接入資訊已確定。

實例位址：{url}
入口主機：{entryHost}
隧道帳號：{account}
專屬埠：{port}

下一步需要你做兩件事：

1. 在本機產生金鑰，私鑰留在本機：
   ssh-keygen -t ed25519 -f ~/.ssh/knot-entry-{id} -N ''

2. 把 ~/.ssh/knot-entry-{id}.pub 的內容交給我們：
   {caseUrl}

只交 .pub。不要交私鑰，也不要貼進郵件或網頁。

我們確認公鑰已裝、埠已就緒後，會再發一封交付信。

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] access details for {id} are set`

```text
Hello {operator},

Access details for instance {id} ({name}) are set.

Instance URL: {url}
Entry host: {entryHost}
Tunnel account: {account}
Dedicated port: {port}

Two things to do next:

1. Generate a key pair on your own machine, keeping the private key local:
   ssh-keygen -t ed25519 -f ~/.ssh/knot-entry-{id} -N ''

2. Send us the contents of ~/.ssh/knot-entry-{id}.pub:
   {caseUrl}

Send the .pub file only. Never send the private key, and never paste it into mail or a web page.

Once the key is installed and the port is ready, we will send a handoff message.

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.3 `partner.handoff`

**主题**：`[XKnot] {id} 的接入资料已就绪`

```text
{operator} 你好：

实例 {id}（{name}）的接入资料已就绪。

请在 {claimTtl}内领取：
{claimUrl}

领取页只显示一次，领取后请立即写进实例配置；不要转发、截图或存进版本库。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 的接入資料已就緒`

```text
{operator} 你好：

實例 {id}（{name}）的接入資料已就緒。

請在 {claimTtl}內領取：
{claimUrl}

領取頁只顯示一次，領取後請立即寫進實例設定；不要轉發、截圖或存進版本庫。

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] access material for {id} is ready`

```text
Hello {operator},

Access material for instance {id} ({name}) is ready.

Claim it within {claimTtl}:
{claimUrl}

The claim page is shown once. Write it into the instance configuration right away; do not forward, screenshot, or commit it.

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.4 `partner.live`

**主题**：`[XKnot] {id} 已在联邦上线`

```text
{operator} 你好：

实例 {id}（{name}）已接入 XKnot 联邦。

公网地址：{url}
门户条目：{portalUrl}
运行状态：{statusLabel}

之后中枢会定期探测 {healthUrl}。连续不可达时运行状态会变成中断，条目保留，不自动删除。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 已在聯邦上線`

```text
{operator} 你好：

實例 {id}（{name}）已接入 XKnot 聯邦。

公網位址：{url}
入口條目：{portalUrl}
運行狀態：{statusLabel}

之後中樞會定期探測 {healthUrl}。連續不可達時運行狀態會變成中斷，條目保留，不自動刪除。

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] {id} is live on the federation`

```text
Hello {operator},

Instance {id} ({name}) is now part of the XKnot Federation.

Public URL: {url}
Portal entry: {portalUrl}
Runtime status: {statusLabel}

The hub probes {healthUrl} periodically. If the instance stays unreachable, its runtime status becomes down; the entry stays and is not removed automatically.

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

**Trigger**: sent automatically in the round when `ops/provision-worker.mjs` sees `/api/health` pass and the manifest `status` turns `active` (`ops/notify-live.mjs`). Event + application id are unique in `notify_log`, so a process restart does not resend; a failed delivery is marked `failed`, and `admin-cli live <application id>` can resend later. With no SMTP configured it only logs one line, not affecting acceptance.

---

### 4.5 `partner.contact_revalidate`

**主题**：`[XKnot] 请确认 {id} 的联系人`

```text
{operator} 你好：

我们每 180 天确认一次成员的联系人是否有效。

请确认这个邮箱仍然可用：{contactMasked}
{confirmUrl}

{confirmTtl} 内未确认，我们会把实例标记为联系人待确认，并暂停向该地址发送运营通知。站点本身、收录与运行状态都不受影响。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] 請確認 {id} 的聯絡人`

```text
{operator} 你好：

我們每 180 天確認一次成員的聯絡人是否有效。

請確認這個信箱仍然可用：{contactMasked}
{confirmUrl}

{confirmTtl} 內未確認，我們會把實例標記為聯絡人待確認，並暫停向該位址發送營運通知。站點本身、收錄與運行狀態都不受影響。

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] please confirm the contact for {id}`

```text
Hello {operator},

We confirm member contacts every 180 days.

Please confirm that this address still works: {contactMasked}
{confirmUrl}

If it is not confirmed within {confirmTtl}, we mark the instance contact as stale and stop sending operational notices to that address. The site, its listing, and its runtime status are unaffected.

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.6 `partner.suspended`

**主题**：`[XKnot] {id} 已暂停收录`

```text
{operator} 你好：

实例 {id}（{name}）已在联邦中暂停收录。

生效时间：{effectiveAt}

影响：

- 门户不再展示该条目的站点档案与热点橱窗
- 委托发信暂停（凭据保留，恢复收录后继续可用）
- 隧道账号暂停

不受影响：

- 实例自己的库、账号、内容与积分
- 实例自己的域名与证书

恢复条件：{resumeCondition}

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 已暫停收錄`

```text
{operator} 你好：

實例 {id}（{name}）已在聯邦中暫停收錄。

生效時間：{effectiveAt}

影響：

- 入口不再展示該條目的站點檔案與熱點櫥窗
- 委託發信暫停（憑證保留，恢復收錄後繼續可用）
- 隧道帳號暫停

不受影響：

- 實例自己的庫、帳號、內容與積分
- 實例自己的網域與憑證

恢復條件：{resumeCondition}

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] {id} is suspended`

```text
Hello {operator},

Instance {id} ({name}) is suspended from the federation.

Effective: {effectiveAt}

Affected:

- the portal no longer shows this entry's site profile or showcase
- relay sending is paused (the credential stays and works again once the listing resumes)
- the tunnel account is disabled

Not affected:

- the instance's own database, accounts, content, and points

To resume: {resumeCondition}

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.7 `partner.retired`

**主题**：`[XKnot] {id} 已退出联邦`

```text
{operator} 你好：

实例 {id}（{name}）已退出 XKnot 联邦。

生效时间：{effectiveAt}
子域回收：{reclaimAt}
运行状态与橱窗缓存：已删除

你的实例、内容与用户数据仍在自己的机器上，中枢不保留副本。
需要导出中枢侧与该实例相关的记录（申请单、审计事件），请在 {exportUntil} 前提出。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

**主題**：`[XKnot] {id} 已退出聯邦`

```text
{operator} 你好：

實例 {id}（{name}）已退出 XKnot 聯邦。

生效時間：{effectiveAt}
子網域回收：{reclaimAt}
運行狀態與櫥窗快取：已刪除

你的實例、內容與使用者資料仍在自己的機器上，中樞不保留副本。
需要匯出中樞側與該實例相關的紀錄（申請單、稽核事件），請在 {exportUntil} 前提出。

本郵件由系統發出，不接收回覆。

—— XKnot 聯邦
```

**Subject**: `[XKnot] {id} has left the federation`

```text
Hello {operator},

Instance {id} ({name}) has left the XKnot Federation.

Effective: {effectiveAt}
Subdomain reclaimed: {reclaimAt}
Runtime status and showcase cache: deleted

Your instance, content, and user data remain on your own machine. The hub keeps no copy.
If you need an export of hub-side records for this instance (application, audit events), ask before {exportUntil}.

This message was sent automatically; replies are not monitored.

— XKnot Federation
```

---

### 4.8 `partner.unreachable_24h`

**Trigger**: `ops/watch-health.mjs` finds the instance unreachable for 24 consecutive hours; `notified.down_24h` not yet written.
**Recipient**: the manifest's `contact`
**Subject**: `[XKnot] {id} 已连续 24 小时无法访问`

```text
{operator} 你好：

中枢探测不到实例 {id}（{name}）。

公网地址：{url}
健康检查：{url}/api/health
首次失败：{firstSeenAt}
最近一次探测：{checkedAt}

门户上现在显示为中断。若 7 天内仍未恢复，该条目会从联邦列表中暂时关闭；
恢复探测后自动回到列表，不需要重新申请。

先在本机确认实例在运行，再确认公网地址与隧道是否通。
需要变更地址或请人协助，请写信给 {outbox}。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

### 4.9 `partner.hidden_7d`

**Trigger**: unreachable for 7 consecutive days, `hiddenAt` written for the first time.
**Recipient**: the manifest's `contact`
**Subject**: `[XKnot] {id} 已从联邦列表暂时关闭`

```text
{operator} 你好：

实例 {id}（{name}）已连续 7 天不可达，条目已从联邦列表暂时关闭。

公网地址：{url}
首次失败：{firstSeenAt}
最近一次探测：{checkedAt}

这不影响你的实例、内容、账号与数据。清单条目仍然保留，
探测恢复后会自动重新出现在列表里；也可以写信给 {outbox} 请人核对。

本邮件由系统发出，不接收回复。

—— XKnot 联邦
```

---

## 5. Internal mail

Internal mail goes to the operator and does not enter the partner chain. It is the only kind whose `Reply-To` may point to a real person.

### 5.1 `internal.application_new`

**Recipient**: `XKNOT_ADMIN_EMAIL`; `Reply-To` = the applicant's email
**Subject**: `[XKnot] 新成员 {id} · {name} 已自动通过`
**Body**:

```text
有一条新的加入申请，已按提交即通过自动结案。

编号：{id}
站点：{name}
地址：{url}
运营方：{operator}
联系邮箱：{email}
区域 / 时区：{region} / {timezone}
简介：{intro}
标签：{tags}

下一步是写清单、接通入口；收录后的档位默认免费，要改收费在实例配置里改：
{origin}/admin/
```

### 5.2 `internal.instance_alert`

**Subject**: `[XKnot] {id} 运行状态异常`

```text
实例 {id}（{name}）需要关注。

现象：{alertLabel}
首次出现：{firstSeenAt}
最近一次探测：{checkedAt}（{httpStatus}，{latencyMs} ms）
公网地址：{url}

处置面板：{origin}/admin/
```

`{alertLabel}` values: `down_24h` (24h unreachable), `down_7d` (7 days, already temporarily closed), `never_14d` (14 days after issuance still not connected), `never_30d` (30 days after issuance, temporarily closed), `relay_quota_80` (relay quota 80% used), `cert_expiring_14d` (entry host certificate expires within 14 days).

---

## 6. Must complete before launch

| Item | Status | Impact |
|----|------|------|
| case page `/case/<caseKey>` | implemented | the action entry for status, public key, and withdrawal; `issuance`, `handoff`, `contact_revalidate` also point here |
| claim page `/claim/<token>` | implemented | plaintext shows once, 72-hour expiry; mail body has no credentials |
| outward support entry `{supportUrl}` | **pending** | with `no-reply` chosen, the partner has no reply channel. Before launch, decide between the support page and the ticket mailbox; when empty the line is omitted, but then the partner can only rely on the case page |
| `no-reply@xknot.si` sending auth | configured | Aliyun requires `SMTP_USER` equals `SMTP_FROM`; changing the sending address changes both |
| `MAIL_FROM` and `Reply-To` consistent | configured | both use `no-reply@xknot.si`, matching the "replies not monitored" wording |
| template version and text owner | settled | runtime version `TEMPLATE_VERSION=2.3.0`; text changes must change both sides and bump the version |
| ownership-verification records | **none** | applications only go by subdomain; before issuance there is no verifiable domain. Acceptance became the post-connection public `/api/health` probe; the `proof_method` / `proof_at` columns are no longer written, and the application object does not return those two fields |

---

## 7. Mapping to the implementation

| Location | Actual approach |
|------|----------|
| `server/notify.mjs` | `TEMPLATES[event] = { audience, subject: {locale}, text: {locale} }`; placeholder `{name}`; `buildMail(event, application, options)` |
| `server/store/schema.mjs` + `server/store/mail-log.mjs` | `notify_log` + `unique(event, case_id, state_version)`; `state_version` +1 on every state transition; operational events (issue/handoff/live) pass no version, allowing resend |
| `server/app.mjs` | submit (auto-approval), case actions, handoff call `dispatchMail`; rate-limit hits record `throttled` |
| `server/pages.mjs` | the two pages are script-free and build-free; all variables go through `escapeHtml`; pages carry their own CSP and `no-store` |
| `server/admin-cli.mjs` | `notify` resends any event except `partner.handoff` (no link to give; use `handoff`); `handoff` issues the claim token, prints the claim address, and retires the previous link; `claims` / `claim-revoke` inspect and retire links without reissuing; `suspend` / `retire` only send mail, the manifest status still follows the ops manifest |
| `server/notify.test.mjs` | 11 events × 3 locales; asserts no leftover placeholder, no credential plaintext, internal notes not sent out |
| `ops/xknot.si.conf` | `/case/`, `/claim/`, `/api/claim`, `/api/case/` disable `access_log` |

The text-change flow: change this document first, then `server/notify.mjs`, bump `TEMPLATE_VERSION`, run `npm test`. Tests assert key elements (id, locale, closing sentence, tier), not verbatim full-text comparison, to avoid punctuation changes turning red.
