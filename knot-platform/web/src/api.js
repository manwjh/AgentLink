// 跨境链路上，一次请求可能永远不回来：TCP 重传会拖到几分钟，而首屏正等它。
// 给每条请求一个上限；超时按一次「这次没问到」处理，不让会话停在「正在进入」。
const REQUEST_TIMEOUT_MS = 15000;

function requestOptions(options) {
  return {
    // 先摊开 options 再写 headers：反过来的话调用方一旦传 headers，就会把这里合并出的
    // Content-Type 整个顶掉，JSON 请求会缺头。
    ...options,
    credentials: "include",
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) },
  };
}

async function send(path, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, { ...requestOptions(options), signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      error.code = data.error || "request_failed";
      error.status = res.status;
      // 429 告诉你还要等多少秒；其它响应没有这个头，就是 0。
      error.retryAfter = Number(res.headers.get("Retry-After")) || 0;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : REQUEST_TIMEOUT_MS;
  try {
    return await send(path, options, timeout);
  } catch (error) {
    // 只重试一次读请求：网络抖动、隧道换连接都不该让一次页面打开失败。
    // 写请求不重试——重发一次可能变成两条记录、两笔扣款。
    if (method === "GET" && !options.retried && (error.name === "AbortError" || error instanceof TypeError)) {
      return send(path, { ...options, retried: true }, timeout);
    }
    if (error.name === "AbortError") {
      const timeoutError = new Error("timeout");
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    throw error;
  }
}

export function getSession() {
  return request("/api/web/session");
}

// 首页的会话层：会话、Agent、未读数，以及当前公开快照上属于我的状态，一次取回。
// 信息流本身来自入口磁盘上的 /discover.json，不走这里。
export function getHome() {
  return request("/api/web/home");
}

export function requestLoginKey(email, inviteCode) {
  const body = { email };
  const code = String(inviteCode || "").trim();
  if (code) body.inviteCode = code;
  return request("/api/web/login", { method: "POST", body: JSON.stringify(body) });
}

export function confirmLoginKey(email, key) {
  return request("/api/web/login/key", { method: "POST", body: JSON.stringify({ email, key }) });
}

export function endSession() {
  return request("/api/web/session", { method: "DELETE" });
}

export function updateProfile(profile) {
  return request("/api/web/profile", { method: "PATCH", body: JSON.stringify(profile) });
}

// 管理后台的一次性入口：主理人在站点域名上换一枚 5 分钟的票据，
// 由内网那一侧的 /admin 兑换成 30 天凭据。票据不含身份信息，主令牌不经过浏览器。
export function requestAdminHandoff() {
  return request("/api/web/admin-handoff", { method: "POST" });
}

function uploadForm(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    xhr.open("POST", path);
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onerror = () => {
      const error = new Error("upload_failed");
      error.code = "upload_failed";
      reject(error);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = new Error(data.error || "upload_failed");
        error.code = data.error || "upload_failed";
        error.status = xhr.status;
        reject(error);
        return;
      }
      resolve(data);
    };
    xhr.send(form);
  });
}

export function uploadImage(file, onProgress) {
  return uploadForm("/api/web/uploads", file, onProgress);
}

export function listInformation(author, before, filters = {}) {
  const id = String(author || "").trim();
  const cursor = String(before || "").trim();
  const query = new URLSearchParams();
  if (id) query.set("author", id);
  if (cursor) query.set("before", cursor);
  const category = String(filters.category || "").trim();
  if (category) query.set("category", category);
  const topic = String(filters.topic || "").trim();
  if (topic) query.set("topic", topic);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/web/information${suffix}`);
}

// 所有 /intel/:id 的路径都从这里拼：id 来自服务端 UUID，但拼路径的地方一旦漏了编码，
// 带 `/`、`?`、`#` 的值就会打到别的路由上，所以统一编码。
function intelPath(id, suffix = "") {
  return `/api/web/intel/${encodeURIComponent(String(id ?? "").trim())}${suffix}`;
}

export function getInformation(id) {
  return request(intelPath(id));
}

export function discoverSelf(ids) {
  return request("/api/web/discover-self", { method: "POST", body: JSON.stringify({ ids }) });
}

export function listSponsors() {
  return request("/api/web/sponsors");
}

export function getEconomy() {
  return request("/api/web/economy");
}

export function dismissInformation(id) {
  return request(intelPath(id, "/dismiss"), { method: "POST", body: "{}" });
}

export function closeInformation(id, reason = "") {
  return request(intelPath(id, "/close"), { method: "POST", body: JSON.stringify({ reason }) });
}

export function reopenInformation(id) {
  return request(intelPath(id, "/reopen"), { method: "POST", body: "{}" });
}

export function listStars() {
  return request("/api/web/stars");
}

export function starInformation(id) {
  return request(intelPath(id, "/star"), { method: "POST", body: "{}" });
}

export function unstarInformation(id) {
  return request(intelPath(id, "/star"), { method: "DELETE" });
}

// 打赏：摘要公开，打赏要会话。金额上限与「不能打赏自己」在后端判。
export function getTips(id) {
  return request(intelPath(id, "/tips"));
}

export function tipInformation(id, amount) {
  return request(intelPath(id, "/tip"), {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
}

export function listFriends() {
  return request("/api/web/friends");
}

export function removeFriend(id) {
  return request(`/api/web/friends/${encodeURIComponent(String(id ?? "").trim())}`, { method: "DELETE" });
}

export function addCardFriend(id) {
  return request(intelPath(id, "/friend"), { method: "POST", body: "{}" });
}

export function removeCardFriend(id) {
  return request(intelPath(id, "/friend"), { method: "DELETE" });
}

export function listPeople() {
  return request("/api/web/people");
}

// ---- Knot Store ------------------------------------------------------------
// 货架只在实例上。未登录也能逛，购买、挂出、撤下都要会话。

function storePath(id, suffix = "") {
  return `/api/web/store/${encodeURIComponent(String(id ?? "").trim())}${suffix}`;
}

export function listStore(before) {
  const cursor = String(before || "").trim();
  return request(cursor ? `/api/web/store?before=${encodeURIComponent(cursor)}` : "/api/web/store");
}

export function listMyStore() {
  return request("/api/web/store/mine");
}

export function listStoreOrders() {
  return request("/api/web/store/orders");
}

export function createStoreItem(body, imageIds = [], fileIds = [], extra = {}) {
  return request("/api/web/store", {
    method: "POST",
    body: JSON.stringify({ body, imageIds, fileIds, ...extra }),
  });
}

export function buyStoreItem(id) {
  return request(storePath(id, "/buy"), { method: "POST", body: "{}" });
}

export function withdrawStoreItem(id) {
  return request(storePath(id, "/withdraw"), { method: "POST", body: "{}" });
}

export function relistStoreItem(id) {
  return request(storePath(id, "/relist"), { method: "POST", body: "{}" });
}

export function searchInformation(q, filters = {}) {
  const query = new URLSearchParams({ q: String(q || "") });
  const category = String(filters.category || "").trim();
  if (category) query.set("category", category);
  const topic = String(filters.topic || "").trim();
  if (topic) query.set("topic", topic);
  return request(`/api/web/search?${query.toString()}`);
}

export function fetchFacets() {
  return request("/api/web/facets");
}

export function createIntel(body, imageIds = [], fileIds = [], extra = {}) {
  return request("/api/web/intel", {
    method: "POST",
    body: JSON.stringify({ body, imageIds, fileIds, ...extra }),
  });
}

function downloadName(header, fallback) {
  const named = /filename\*=UTF-8''([^;]+)/i.exec(header || "");
  if (named) {
    try {
      return decodeURIComponent(named[1]);
    } catch {
      /* use the plain name below */
    }
  }
  const plain = /filename="([^"]*)"/.exec(header || "");
  return plain?.[1] || fallback;
}

function saveResponseFile(res, fallback) {
  return res.blob().then((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName(res.headers.get("content-disposition"), fallback);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

export async function downloadInformation(id) {
  const res = await fetch(intelPath(id, "/download"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("json")) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.error || res.statusText);
    error.code = data.error || "request_failed";
    error.status = res.status;
    throw error;
  }
  await saveResponseFile(res, "packet.zip");
}

export async function downloadShare(id) {
  const res = await fetch(intelPath(id, "/share"), { credentials: "include" });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("json")) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.error || res.statusText);
    error.code = data.error || "request_failed";
    error.status = res.status;
    throw error;
  }
  await saveResponseFile(res, "knot.jpg");
}


export function uploadAudio(file, onProgress) {
  return uploadForm("/api/web/audio", file, onProgress);
}

export function uploadAttachment(file, onProgress) {
  return uploadForm("/api/web/files", file, onProgress);
}

export function listSubmissions() {
  return request("/api/web/submissions");
}

export function listNotifications() {
  return request("/api/web/notifications");
}

// 顶栏轮询只要一个数字，不要把整箱通知每次都拖过来。
export function pollNotifications() {
  return request("/api/web/notifications?count=1");
}

// 同一件事用在「今日」上：一条只有计数的小 JSON，不为了一个数字把整份信息流拖过来。
// 没有公开快照时服务端回 `{ counts: null }`（与「取失败」分开处理）。
export function getToday() {
  return request("/api/web/today");
}

export function readNotifications() {
  return request("/api/web/notifications/read", { method: "POST", body: "{}" });
}

export function getAgent() {
  return request("/api/web/agent");
}

export function issueAgent() {
  return request("/api/web/agent", { method: "POST", body: "{}" });
}

export function retireAgent() {
  return request("/api/web/agent", { method: "DELETE" });
}
