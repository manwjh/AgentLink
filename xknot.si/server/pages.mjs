// 伙伴侧页面：申请案例页与一次性领取页。
//
// 案例页只渲染表单，撤回与提交公钥都是 POST；领取页同样 GET 只给按钮，
// 消费令牌必须是 POST。邮箱安全网关会预取链接，GET 一消费就等于替用户点掉了。
//
// 没有构建步骤、没有前端脚本：只发内联样式的 HTML 和普通表单。
// 所有用户数据都经过 escapeHtml，申请内容不会当 HTML 执行。

import { normalizeLocale } from "./notify.mjs";

const PAGE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #F0F2F5; color: #050505;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .card { background: #fff; border-radius: 8px; padding: 1.75rem; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  h1 { margin: 0 0 .5rem; font-size: 1.375rem; line-height: 1.35; }
  p { margin: 0 0 .85rem; }
  .muted { color: #65676B; font-size: .9rem; }
  dl { display: grid; grid-template-columns: 7.5rem 1fr; gap: .35rem .75rem; margin: 1.25rem 0; }
  dt { color: #65676B; }
  dd { margin: 0; word-break: break-word; }
  .button, button { appearance: none; border: 0; border-radius: 6px; background: #0866FF; color: #fff;
    font: inherit; font-weight: 600; padding: .7rem 1.25rem; min-height: 44px; cursor: pointer; }
  .button:hover, button:hover { background: #0056d6; }
  .secondary { background: #E4E6EB; color: #050505; }
  .secondary:hover { background: #D8DADF; }
  form { margin: 0; display: inline-block; }
  .actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.25rem; }
  textarea { width: 100%; min-height: 7rem; font: .9rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: .6rem; border: 1px solid #CED0D4; border-radius: 6px; }
  pre { background: #F0F2F5; border-radius: 6px; padding: 1rem; overflow-x: auto;
        font: .85rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .banner { border-radius: 6px; padding: .85rem 1rem; margin-bottom: 1.25rem; background: #FFF4E5; color: #6b4700; }
  .banner.ok { background: #E7F5EA; color: #14532d; }
  .banner.bad { background: #FDECEC; color: #7f1d1d; }
  .items { margin: .35rem 0 1rem; padding-left: 1.2rem; }
  footer { margin-top: 2rem; color: #65676B; font-size: .8rem; }
`;

const TEXT = {
  "zh-CN": {
    caseTitle: "申请状态 · XKnot 联邦",
    caseHeading: "申请 {id}",
    caseWithdraw: "撤回这份申请",
    caseWithdrawn: "申请已撤回。",
    casePublicKey: "提交公钥",
    casePublicKeyHint: "只粘贴 .pub 的内容。私钥留在你自己的机器上。",
    casePublicKeySaved: "公钥已保存。",
    caseClosed: "这份申请已经结束，只能查看，不能再操作。",
    caseFooter: "本页面只对持有链接的人可见，不要转发。",
    claimTitle: "领取接入资料 · XKnot 联邦",
    claimHeading: "领取接入资料",
    claimBody: "点下面的按钮显示一次。内容包含凭据，请立即写进实例配置，不要转发或截图。",
    claimButton: "显示接入资料",
    claimUsed: "这份资料已经被领取过。需要重新签发请联系运营方。",
    claimExpired: "这个领取链接已过期。请联系运营方重新签发。",
    claimRevoked: "这个领取链接已被作废，通常是因为运营方重发了交付信。请用最新一封邮件里的链接。",
    claimMissing: "这个链接无效。",
    claimWarning: "关闭本页后不会再显示。",
    tooMany: "请求过多，请稍后再试。",
    casePublicKeyInvalid: "公钥没存上：只接受一整行 ssh-ed25519 / ssh-rsa / ecdsa 公钥。",
    status: "状态",
    site: "站点",
    url: "地址",
    submitted: "提交时间",
    close: "关闭",
    footer: "—— XKnot 联邦",
  },
  "zh-TW": {
    caseTitle: "申請狀態 · XKnot 聯邦",
    caseHeading: "申請 {id}",
    caseWithdraw: "撤回這份申請",
    caseWithdrawn: "申請已撤回。",
    casePublicKey: "提交公鑰",
    casePublicKeyHint: "只貼上 .pub 的內容。私鑰留在你自己的機器上。",
    casePublicKeySaved: "公鑰已儲存。",
    caseClosed: "這份申請已經結束，只能查看，不能再操作。",
    caseFooter: "本頁面只對持有連結的人可見，不要轉發。",
    claimTitle: "領取接入資料 · XKnot 聯邦",
    claimHeading: "領取接入資料",
    claimBody: "點下面的按鈕顯示一次。內容包含憑證，請立即寫進實例設定，不要轉發或截圖。",
    claimButton: "顯示接入資料",
    claimUsed: "這份資料已經被領取過。需要重新簽發請聯絡營運方。",
    claimExpired: "這個領取連結已過期。請聯絡營運方重新簽發。",
    claimRevoked: "這個領取連結已被作廢，通常是因為營運方重發了交付信。請用最新一封郵件裡的連結。",
    claimMissing: "這個連結無效。",
    claimWarning: "關閉本頁後不會再顯示。",
    tooMany: "請求過多，請稍後再試。",
    casePublicKeyInvalid: "公鑰沒存上：只接受一整行 ssh-ed25519 / ssh-rsa / ecdsa 公鑰。",
    status: "狀態",
    site: "站點",
    url: "位址",
    submitted: "提交時間",
    close: "關閉",
    footer: "—— XKnot 聯邦",
  },
  en: {
    caseTitle: "Application status · XKnot Federation",
    caseHeading: "Application {id}",
    caseWithdraw: "Withdraw this application",
    caseWithdrawn: "Application withdrawn.",
    casePublicKey: "Submit public key",
    casePublicKeyHint: "Paste only the .pub content. Keep the private key on your own machine.",
    casePublicKeySaved: "Public key saved.",
    caseClosed: "This application is closed. It can be viewed but no longer changed.",
    caseFooter: "This page is visible only to whoever holds the link. Do not forward it.",
    claimTitle: "Claim access material · XKnot Federation",
    claimHeading: "Claim access material",
    claimBody: "The button below reveals the material once. It contains credentials; write it into the instance configuration immediately and do not forward or screenshot it.",
    claimButton: "Reveal access material",
    claimUsed: "This material was already claimed. Ask the operator to issue it again.",
    claimExpired: "This claim link has expired. Ask the operator to issue it again.",
    claimRevoked: "This claim link was revoked, usually because a newer handoff mail was sent. Use the link in the latest mail.",
    claimMissing: "This link is not valid.",
    claimWarning: "It will not be shown again after you close this page.",
    tooMany: "Too many requests. Try again in a moment.",
    casePublicKeyInvalid: "The key was not saved: paste one single ssh-ed25519 / ssh-rsa / ecdsa line.",
    status: "Status",
    site: "Site",
    url: "URL",
    submitted: "Submitted",
    close: "Close",
    footer: "— XKnot Federation",
  },
};

const STATUS_LABEL = {
  approved: { "zh-CN": "已通过", "zh-TW": "已通過", en: "approved" },
  withdrawn: { "zh-CN": "已撤回", "zh-TW": "已撤回", en: "withdrawn" },
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function t(locale, key) {
  const table = TEXT[normalizeLocale(locale)] || TEXT.en;
  return table[key] ?? TEXT.en[key] ?? key;
}

function statusLabel(status, locale) {
  const entry = STATUS_LABEL[status];
  // 状态机只产出这两个值；表里没有的原样显示，不硬翻成别的状态。
  if (!entry) return String(status || "");
  return entry[normalizeLocale(locale)] || entry.en;
}

function shell(locale, title, body) {
  return `<!doctype html>
<html lang="${escapeHtml(normalizeLocale(locale))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${body}
<footer>${escapeHtml(t(locale, "footer"))}</footer>
</main>
</body>
</html>`;
}

function banner(kind, text) {
  return `<p class="banner${kind ? ` ${kind}` : ""}">${escapeHtml(text)}</p>`;
}

/**
 * 案例页：状态与当前状态下允许的动作。已撤回的申请只读。
 */
export function renderCasePage(application, options = {}) {
  if (options.rateLimited) {
    return shell("en", "Application", `<section class="card">${banner("bad", t("en", "tooMany"))}</section>`);
  }
  if (!application) {
    return shell("en", "Application", `<section class="card">${banner("bad", "This link is not valid.")}</section>`);
  }
  const locale = normalizeLocale(application.locale);
  const status = application.status;
  const open = status === "approved";
  const key = encodeURIComponent(application.caseKey || "");

  const rows = [
    [t(locale, "status"), statusLabel(status, locale)],
    [t(locale, "site"), application.name],
    [t(locale, "url"), application.url],
    [t(locale, "submitted"), String(application.createdAt || "").slice(0, 10)],
  ];

  const notices = [];
  if (options.withdrawn === 1) notices.push(banner("ok", t(locale, "caseWithdrawn")));
  if (options.publicKey === "saved") notices.push(banner("ok", t(locale, "casePublicKeySaved")));
  else if (options.publicKey === "invalid") notices.push(banner("bad", t(locale, "casePublicKeyInvalid")));
  else if (options.publicKey === "closed") notices.push(banner("bad", t(locale, "caseClosed")));

  const actions = [];
  if (open) {
    actions.push(`<form method="post" action="/api/case/${key}/withdraw"><button class="secondary" type="submit">${escapeHtml(
      t(locale, "caseWithdraw")
    )}</button></form>`);
  }

  // 归属验证已取消：申请时站点还不存在，子域由中枢签发。
  // 案例页只留公钥这一件事。
  const caseForms = open
    ? `<h2>${escapeHtml(t(locale, "casePublicKey"))}</h2>
<p class="muted">${escapeHtml(t(locale, "casePublicKeyHint"))}</p>
<form method="post" action="/api/case/${key}/public-key">
  <textarea name="publicKey" spellcheck="false" autocomplete="off" placeholder="ssh-ed25519 AAAA..."></textarea>
  <p class="actions"><button type="submit">${escapeHtml(t(locale, "casePublicKey"))}</button></p>
</form>`
    : `<p class="muted">${escapeHtml(t(locale, "caseClosed"))}</p>`;

  const body = `<section class="card">
  <h1>${escapeHtml(t(locale, "caseHeading").replace("{id}", application.id))}</h1>
  ${notices.join("")}
  <dl>${rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("")}</dl>
  ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
  ${caseForms}
  <p class="muted" style="margin-top:1.5rem">${escapeHtml(t(locale, "caseFooter"))}</p>
</section>`;
  return shell(locale, t(locale, "caseTitle"), body);
}

export function renderClaimPage(token, application, locale) {
  const useLocale = normalizeLocale(application?.locale || locale);
  const body = `<section class="card">
  <h1>${escapeHtml(t(useLocale, "claimHeading"))}</h1>
  <p>${escapeHtml(t(useLocale, "claimBody"))}</p>
  <form method="post" action="/api/claim">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">${escapeHtml(t(useLocale, "claimButton"))}</button>
  </form>
  <p class="muted">${escapeHtml(t(useLocale, "claimWarning"))}</p>
</section>`;
  return shell(useLocale, t(useLocale, "claimTitle"), body);
}

export function renderClaimResult(outcome, payload, locale) {
  const useLocale = normalizeLocale(locale);
  if (outcome !== "ok") {
    const message = {
      used: t(useLocale, "claimUsed"),
      revoked: t(useLocale, "claimRevoked"),
      expired: t(useLocale, "claimExpired"),
      missing: t(useLocale, "claimMissing"),
      rate_limited: t(useLocale, "tooMany"),
    }[outcome] || t(useLocale, "claimMissing");
    return shell(
      useLocale,
      t(useLocale, "claimTitle"),
      `<section class="card"><h1>${escapeHtml(t(useLocale, "claimHeading"))}</h1>${banner(
        "bad",
        message
      )}</section>`
    );
  }
  const body = `<section class="card">
  <h1>${escapeHtml(t(useLocale, "claimHeading"))}</h1>
  ${banner("ok", t(useLocale, "claimWarning"))}
  <pre>${escapeHtml(payload)}</pre>
</section>`;
  return shell(useLocale, t(useLocale, "claimTitle"), body);
}
