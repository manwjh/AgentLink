// 发给伙伴与运营方的邮件正文。
//
// 这里是运行时的唯一真源：事件名、收件人、主题与正文都在 TEMPLATES 里。
// 可读版本（含每个事件的触发条件与变量表）见 docs/PARTNER-MAIL.md，
// 改文案要两边一起改，并升 TEMPLATE_VERSION。
//
// 两条硬规则：
//  1. 发信人恒为中枢的 MAIL_FROM，Reply-To 用 no-reply；正文一律写明「不接收回复」。
//     因此所有需要申请人动作的事都必须给链接，不能写「请回复本邮件」。
//  2. 正文只放事实：不放内部备注、审核人、IP、哈希，也不放任何凭据明文。

export const TEMPLATE_VERSION = "2.3.0";

const LOCALES = ["zh-CN", "zh-TW", "en"];

export function normalizeLocale(value) {
  const locale = String(value || "").trim().toLowerCase();
  if (locale.startsWith("zh-tw") || locale.startsWith("zh-hk") || locale.startsWith("zh-hant")) {
    return "zh-TW";
  }
  if (locale.startsWith("zh")) return "zh-CN";
  return "en";
}

const CLOSING = {
  "zh-CN": "本邮件由系统发出，不接收回复。",
  "zh-TW": "本郵件由系統發出，不接收回覆。",
  en: "This message was sent automatically; replies are not monitored.",
};

const SIGN = {
  "zh-CN": "—— XKnot 联邦",
  "zh-TW": "—— XKnot 聯邦",
  en: "— XKnot Federation",
};

const HELLO = {
  "zh-CN": "{operator} 你好：",
  "zh-TW": "{operator} 你好：",
  en: "Hello {operator},",
};

/**
 * 模板：subject / text 按语种分键，占位符用 {name}。
 * companion: 该事件是否需要案例页（没有案例页就不发，避免给死链）。
 */
export const TEMPLATES = {
  // 提交即通过：这封信既是回执也是结果，不再有确认邮箱与等待审核的下一步。
  "partner.approved": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已通过，地址已签发",
      "zh-TW": "[XKnot] {id} 已通過，位址已簽發",
      en: "[XKnot] {id} is approved and the address is issued",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

你提交的 XKnot 联邦加入申请（{id}）已通过。平台在收到申请时自动核对，通过即生效，不需要再等回信。

站点：{name}
地址：{url}
当前档位：免费

接下来由运营方把实例写进联邦清单并接通入口。收录当天，门户的实例目录里会出现这个条目：状态先是「待验收」，公网 /api/health 通过后转为在线。

收录不包含入口主机与 SSH 反向隧道，需要时另行确认。

委托发信默认由中枢代发：要用它，请运营方签发一次接入件（一次性领取），里面带发信凭据；不必自己配 SMTP。

申请状态与公钥提交：
{caseUrl}

{supportLine}

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

你提交的 XKnot 聯邦加入申請（{id}）已通過。平台在收到申請時自動核對，通過即生效，不需要再等回信。

站點：{name}
位址：{url}
目前檔位：免費

接下來由營運方把實例寫進聯邦清單並接通入口。收錄當天，入口的實例目錄裡會出現這個條目：狀態先是「待驗收」，公網 /api/health 通過後轉為上線。

收錄不包含入口主機與 SSH 反向隧道，需要時另行確認。

委託發信預設由中樞代發：要用它，請營運方簽發一次接入件（一次性領取），裡面帶發信憑證；不必自己設 SMTP。

申請狀態與公鑰提交：
{caseUrl}

{supportLine}

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Your application to join the XKnot Federation ({id}) is approved. The hub checks every application as it arrives, so approval takes effect immediately and no further reply is needed.

Site: {name}
URL: {url}
Current tier: free

The operator will now add the instance to the federation manifest and connect the entry. The entry appears in the portal's instance directory on the day it is listed: first as pending, then as online once the public /api/health check passes.

Listing does not include the entry host and SSH reverse tunnel, which are confirmed separately.

Delegated mail is on by default: when you want it, ask the operator to issue an access material (one-time claim), which carries a relay token; you need no SMTP setup of your own.

Application status and public key:
{caseUrl}

{supportLine}

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.issuance": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 的接入信息已确定",
      "zh-TW": "[XKnot] {id} 的接入資訊已確定",
      en: "[XKnot] access details for {id} are set",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

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

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

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

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

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

${CLOSING.en}

${SIGN.en}`,
    },
  },

  // 交付信只说「去哪里领」，不说「领什么」：领取页里放的是哪个 payload 由
  // 运营方这一次交付的东西决定，模板写死一份清单就会替他承诺没放进去的项。
  "partner.handoff": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 的接入资料已就绪",
      "zh-TW": "[XKnot] {id} 的接入資料已就緒",
      en: "[XKnot] access material for {id} is ready",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

实例 {id}（{name}）的接入资料已就绪。

请在 {claimTtl}内领取：
{claimUrl}

领取页只显示一次，领取后请立即写进实例配置；不要转发、截图或存进版本库。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

實例 {id}（{name}）的接入資料已就緒。

請在 {claimTtl}內領取：
{claimUrl}

領取頁只顯示一次，領取後請立即寫進實例設定；不要轉發、截圖或存進版本庫。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Access material for instance {id} ({name}) is ready.

Claim it within {claimTtl}:
{claimUrl}

The claim page is shown once. Write it into the instance configuration right away; do not forward, screenshot, or commit it.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.live": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已在联邦上线",
      "zh-TW": "[XKnot] {id} 已在聯邦上線",
      en: "[XKnot] {id} is live on the federation",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

实例 {id}（{name}）已接入 XKnot 联邦。

公网地址：{url}
门户条目：{portalUrl}
运行状态：{statusLabel}

之后中枢会定期探测 {healthUrl}。连续不可达时运行状态会变成中断，条目保留，不自动删除。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

實例 {id}（{name}）已接入 XKnot 聯邦。

公網位址：{url}
入口條目：{portalUrl}
運行狀態：{statusLabel}

之後中樞會定期探測 {healthUrl}。連續不可達時運行狀態會變成中斷，條目保留，不自動刪除。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Instance {id} ({name}) is now part of the XKnot Federation.

Public URL: {url}
Portal entry: {portalUrl}
Runtime status: {statusLabel}

The hub probes {healthUrl} periodically. If the instance stays unreachable, its runtime status becomes down; the entry stays and is not removed automatically.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.contact_revalidate": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] 请确认 {id} 的联系人",
      "zh-TW": "[XKnot] 請確認 {id} 的聯絡人",
      en: "[XKnot] please confirm the contact for {id}",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

我们每 180 天确认一次成员的联系人是否有效。

实例：{id}（{name}）
请确认这个邮箱仍然可用：{contactMasked}
{confirmUrl}

{confirmTtl} 内未确认，我们会把实例标记为联系人待确认，并暂停向该地址发送运营通知。站点本身、收录与运行状态都不受影响。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

我們每 180 天確認一次成員的聯絡人是否有效。

實例：{id}（{name}）
請確認這個信箱仍然可用：{contactMasked}
{confirmUrl}

{confirmTtl} 內未確認，我們會把實例標記為聯絡人待確認，並暫停向該位址發送營運通知。站點本身、收錄與運行狀態都不受影響。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

We confirm member contacts every 180 days.

Instance: {id} ({name})
Please confirm that this address still works: {contactMasked}
{confirmUrl}

If it is not confirmed within {confirmTtl}, we mark the instance contact as stale and stop sending operational notices to that address. The site, its listing, and its runtime status are unaffected.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.suspended": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已暂停收录",
      "zh-TW": "[XKnot] {id} 已暫停收錄",
      en: "[XKnot] {id} is suspended",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

实例 {id}（{name}）已在联邦中暂停收录。

生效时间：{effectiveAt}

影响：

- 门户不再展示该条目的站点档案与热点橱窗
- 委托发信暂停（凭据保留，恢复收录后继续可用）
- 隧道账号暂停

不受影响：

- 实例自己的库、账号、内容与积分

恢复条件：{resumeCondition}

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

實例 {id}（{name}）已在聯邦中暫停收錄。

生效時間：{effectiveAt}

影響：

- 入口不再展示該條目的站點檔案與熱點櫥窗
- 委託發信暫停（憑證保留，恢復收錄後繼續可用）
- 隧道帳號暫停

不受影響：

- 實例自己的庫、帳號、內容與積分

恢復條件：{resumeCondition}

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Instance {id} ({name}) is suspended from the federation.

Effective: {effectiveAt}

Affected:

- the portal no longer shows this entry's site profile or showcase
- relay sending is paused (the credential stays and works again once the listing resumes)
- the tunnel account is disabled

Not affected:

- the instance's own database, accounts, content, and points

To resume: {resumeCondition}

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.retired": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已退出联邦",
      "zh-TW": "[XKnot] {id} 已退出聯邦",
      en: "[XKnot] {id} has left the federation",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

实例 {id}（{name}）已退出 XKnot 联邦。

生效时间：{effectiveAt}
子域回收：{reclaimAt}
运行状态与橱窗缓存：已删除

你的实例、内容与用户数据仍在自己的机器上，中枢不保留副本。
需要导出中枢侧与该实例相关的记录（申请单、审计事件），请在 {exportUntil} 前提出。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

實例 {id}（{name}）已退出 XKnot 聯邦。

生效時間：{effectiveAt}
子網域回收：{reclaimAt}
運行狀態與櫥窗快取：已刪除

你的實例、內容與使用者資料仍在自己的機器上，中樞不保留副本。
需要匯出中樞側與該實例相關的紀錄（申請單、稽核事件），請在 {exportUntil} 前提出。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Instance {id} ({name}) has left the XKnot Federation.

Effective: {effectiveAt}
Subdomain reclaimed: {reclaimAt}
Runtime status and showcase cache: deleted

Your instance, content, and user data remain on your own machine. The hub keeps no copy.
If you need an export of hub-side records for this instance (application, audit events), ask before {exportUntil}.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  // ---- 运行状态通知：由 ops/watch-health.mjs 发出，不是审核动作。 ----

  "partner.unreachable_24h": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已连续 24 小时无法访问",
      "zh-TW": "[XKnot] {id} 已連續 24 小時無法存取",
      en: "[XKnot] {id} has been unreachable for 24 hours",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

中枢探测不到实例 {id}（{name}）。

公网地址：{url}
健康检查：{url}/api/health
首次失败：{firstSeenAt}
最近一次探测：{checkedAt}

门户上现在显示为中断。若 7 天内仍未恢复，该条目会从联邦列表中暂时关闭；
恢复探测后自动回到列表，不需要重新申请。

先在本机确认实例在运行，再确认公网地址与隧道是否通。
需要变更地址或请人协助，请写信给 {outbox}。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

中樞探測不到實例 {id}（{name}）。

公網位址：{url}
健康檢查：{url}/api/health
首次失敗：{firstSeenAt}
最近一次探測：{checkedAt}

入口現在顯示為中斷。若 7 天內仍未恢復，該條目會從聯邦清單中暫時關閉；
恢復探測後自動回到清單，不需要重新申請。

先在本地確認實例在執行，再確認公網位址與通道是否通。
需要變更落點或請人協助，請寫信給 {outbox}。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

The hub cannot reach instance {id} ({name}).

Public URL: {url}
Health check: {url}/api/health
First failure: {firstSeenAt}
Last probe: {checkedAt}

The portal now shows it as down. If it is still down after 7 days, the entry is hidden
from the federation list until a probe succeeds again; no new application is needed.

Check that the instance is running locally, then that the public address and tunnel are up.
To change the landing setup or ask for help, write to {outbox}.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  "partner.hidden_7d": {
    audience: "partner",
    subject: {
      "zh-CN": "[XKnot] {id} 已从联邦列表暂时关闭",
      "zh-TW": "[XKnot] {id} 已從聯邦清單暫時關閉",
      en: "[XKnot] {id} is temporarily hidden from the federation list",
    },
    text: {
      "zh-CN": `${HELLO["zh-CN"]}

实例 {id}（{name}）已连续 7 天不可达，条目已从联邦列表暂时关闭。

公网地址：{url}
首次失败：{firstSeenAt}
最近一次探测：{checkedAt}

这不影响你的实例、内容、账号与数据。清单条目仍然保留，
探测恢复后会自动重新出现在列表里；也可以写信给 {outbox} 请人核对。

${CLOSING["zh-CN"]}

${SIGN["zh-CN"]}`,
      "zh-TW": `${HELLO["zh-TW"]}

實例 {id}（{name}）已連續 7 天不可達，條目已從聯邦清單暫時關閉。

公網位址：{url}
首次失敗：{firstSeenAt}
最近一次探測：{checkedAt}

這不影響你的實例、內容、帳號與資料。清單條目仍然保留，
探測恢復後會自動重新出現在清單裡；也可以寫信給 {outbox} 請人核對。

${CLOSING["zh-TW"]}

${SIGN["zh-TW"]}`,
      en: `${HELLO.en}

Instance {id} ({name}) has been unreachable for 7 days, so the entry is now hidden
from the federation list.

Public URL: {url}
First failure: {firstSeenAt}
Last probe: {checkedAt}

Your instance, content, accounts, and data are unaffected. The manifest entry is kept;
once a probe succeeds the entry returns to the list automatically. You can also write
to {outbox} if you want a human to check.

${CLOSING.en}

${SIGN.en}`,
    },
  },

  // ---- 内部信：发给运营方。只有这一类允许 Reply-To 指向真人。 ----

  "internal.application_new": {
    audience: "operator",
    subject: {
      "zh-CN": "[XKnot] 新成员 {id} · {name} 已自动通过",
      "zh-TW": "[XKnot] 新成員 {id} · {name} 已自動通過",
      en: "[XKnot] new member {id} · {name} approved automatically",
    },
    text: {
      "zh-CN": `有一条新的加入申请，已按提交即通过自动结案。

编号：{id}
站点：{name}
地址：{url}
运营方：{operator}
联系邮箱：{email}
区域 / 时区：{region} / {timezone}
简介：{intro}
标签：{tags}

下一步是写清单、接通入口；收录后的档位默认免费，要改收费在实例配置里改：
{origin}/admin/`,
      "zh-TW": `有一條新的加入申請，已按提交即通過自動結案。

編號：{id}
站點：{name}
位址：{url}
營運方：{operator}
聯絡信箱：{email}
區域 / 時區：{region} / {timezone}
簡介：{intro}
標籤：{tags}

下一步是寫清單、接通入口；收錄後的檔位預設免費，要改收費在實例設定裡改：
{origin}/admin/`,
      en: `A new application has arrived and was closed as approved on submission.

Reference: {id}
Site: {name}
URL: {url}
Operator: {operator}
Contact: {email}
Region / timezone: {region} / {timezone}
Intro: {intro}
Tags: {tags}

Next: write the manifest entry and connect the entry. New listings default to the
free tier; switch to paid in the instance settings:
{origin}/admin/`,
    },
  },

  "internal.instance_alert": {
    audience: "operator",
    subject: {
      "zh-CN": "[XKnot] {id} 运行状态异常",
      "zh-TW": "[XKnot] {id} 運行狀態異常",
      en: "[XKnot] {id} needs attention",
    },
    text: {
      "zh-CN": `实例 {id}（{name}）需要关注。

现象：{alertLabel}
首次出现：{firstSeenAt}
最近一次探测：{checkedAt}（{httpStatus}，{latencyMs} ms）
公网地址：{url}

处置面板：{origin}/admin/`,
      "zh-TW": `實例 {id}（{name}）需要關注。

現象：{alertLabel}
首次出現：{firstSeenAt}
最近一次探測：{checkedAt}（{httpStatus}，{latencyMs} ms）
公網位址：{url}

處置面板：{origin}/admin/`,
      en: `Instance {id} ({name}) needs attention.

Signal: {alertLabel}
First seen: {firstSeenAt}
Last probe: {checkedAt} ({httpStatus}, {latencyMs} ms)
Public URL: {url}

Console: {origin}/admin/`,
    },
  },
};

export const PARTNER_EVENTS = Object.keys(TEMPLATES).filter((name) => TEMPLATES[name].audience === "partner");
export const INTERNAL_EVENTS = Object.keys(TEMPLATES).filter((name) => TEMPLATES[name].audience === "operator");
export const ALL_EVENTS = Object.keys(TEMPLATES);

export const ALERT_LABELS = {
  down_24h: {
    "zh-CN": "连续 24 小时不可达",
    "zh-TW": "連續 24 小時不可達",
    en: "unreachable for 24 hours",
  },
  down_7d: {
    "zh-CN": "连续 7 天不可达，已暂时关闭",
    "zh-TW": "連續 7 天不可達，已暫時關閉",
    en: "unreachable for 7 days, temporarily hidden",
  },
  never_14d: {
    "zh-CN": "收录后 14 天仍未验收",
    "zh-TW": "收錄後 14 天仍未驗收",
    en: "not verified 14 days after listing",
  },
  never_30d: {
    "zh-CN": "收录后 30 天仍未验收，已暂时关闭",
    "zh-TW": "收錄後 30 天仍未驗收，已暫時關閉",
    en: "not verified 30 days after listing, temporarily hidden",
  },
  relay_quota_80: {
    "zh-CN": "委托发信额度已用掉 80%",
    "zh-TW": "委託發信額度已用掉 80%",
    en: "relay quota is 80% used",
  },
  cert_expiring_14d: {
    "zh-CN": "入口主机证书 14 天内到期",
    "zh-TW": "入口憑證 14 天內到期",
    en: "the entry certificate expires within 14 days",
  },
};

// 占位符替换。缺值一律替换成空串，避免把 {foo} 原样寄给伙伴。
export function render(template, vars) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key) =>
    vars[key] == null ? "" : String(vars[key])
  );
}

function pick(copy, locale) {
  return copy[locale] ?? copy.en;
}

export function maskEmail(address) {
  const raw = String(address || "");
  const at = raw.indexOf("@");
  if (at <= 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * 补齐所有变量的默认值。调用方只需要给 links 与少量覆盖项。
 */
// 领取有效期由签发方给（1–168 小时），不是固定 72：`handoff --ttl 24` 的
// 交付信里写着「72 小时」就是在骗伙伴，链接其实隔天就失效了。
function claimTtlText(locale, hours) {
  const value = Math.round(Number(hours));
  if (!Number.isFinite(value) || value <= 0) {
    return { "zh-CN": "72 小时", "zh-TW": "72 小時", en: "72 hours" }[locale];
  }
  if (locale === "en") return `${value} ${value === 1 ? "hour" : "hours"}`;
  return locale === "zh-TW" ? `${value} 小時` : `${value} 小时`;
}

export function buildVars(application, options = {}) {
  const locale = normalizeLocale(application.locale);
  const origin = String(options.origin || "https://xknot.si").replace(/\/+$/, "");
  const links = options.links || {};
  const caseUrl = links.caseUrl || `${origin}/case/${application.caseKey || ""}`;

  return {
    id: application.id,
    name: application.name,
    url: application.url,
    operator: application.operator,
    email: application.email,
    region: application.region,
    timezone: application.timezone,
    intro: application.intro,
    tags: Array.isArray(application.tags) && application.tags.length ? application.tags.join(", ") : "—",
    locale,
    origin,
    caseUrl,
    claimUrl: links.claimUrl || "",
    confirmUrl: links.confirmUrl || caseUrl,
    portalUrl: links.portalUrl || `${origin}/${locale === "en" ? "en" : locale}/`,
    supportUrl: options.supportUrl || "",
    // 伙伴来信的回复地址：运营方地址。申请阶段的提醒都指向它。
    outbox: options.outbox || options.adminEmail || "",
    // 没有支持入口时整行省略，别在信尾留一个空的「可选的联系入口：」。
    supportLine: options.supportUrl
      ? `${pick({ "zh-CN": "可选的联系入口：", "zh-TW": "可選的聯絡入口：", en: "Optional contact: " }, locale)}${options.supportUrl}`
      : "",
    confirmTtl: { "zh-CN": "30 天", "zh-TW": "30 天", en: "30 days" }[locale],
    claimTtl: claimTtlText(locale, options.claimTtlHours),
    entryHost: options.entryHost || "—",
    account: options.account || "—",
    port: options.port || "—",
    healthUrl: `${application.url}/api/health`,
    statusLabel: options.statusLabel || "up",
    contactMasked: maskEmail(application.email),
    effectiveAt: options.effectiveAt || new Date().toISOString().slice(0, 10),
    reclaimAt: options.reclaimAt || "",
    exportUntil: options.exportUntil || "",
    resumeCondition: options.resumeCondition || "—",
    alertLabel: options.alertLabel || "",
    firstSeenAt: options.firstSeenAt || "",
    checkedAt: options.checkedAt || "",
    httpStatus: options.httpStatus ?? "",
    latencyMs: options.latencyMs ?? "",
  };
}

/**
 * 组装一封可以交给 mailer.send 的信。
 *
 * @returns {{ event, audience, to, replyTo, subject, text, templateVersion, locale } | null}
 */
export function buildMail(eventName, application, options = {}) {
  const template = TEMPLATES[eventName];
  if (!template) throw new Error(`unknown_mail_event:${eventName}`);
  const vars = buildVars(application, options);
  const locale = vars.locale;

  const subject = render(pick(template.subject, locale), vars);
  // 可选行没填时会留下一个空行；段落间距是空行，收掉多余的那一处。
  const text = render(pick(template.text, locale), vars).replace(/\n{3,}/g, "\n\n");

  if (template.audience === "operator") {
    const adminEmail = String(options.adminEmail || "").trim();
    if (!adminEmail) return null;
    return {
      event: eventName,
      audience: "operator",
      to: adminEmail,
      // 内部信要能直接回给申请人，这是唯一允许真人 Reply-To 的地方。
      replyTo: options.adminReplyTo || application.email,
      subject,
      text,
      templateVersion: TEMPLATE_VERSION,
      locale,
    };
  }

  return {
    event: eventName,
    audience: "partner",
    to: application.email,
    // 对外一律 no-reply：xknot.si 的 MX 只发信，回信会退。
    replyTo: options.replyTo || "",
    subject,
    text,
    templateVersion: TEMPLATE_VERSION,
    locale,
  };
}

export { LOCALES };
