const $ = (id) => document.getElementById(id);
let loginId = null;
let pollTimer = null;
let requestController = null;
let conversation = [];
let uiEpoch = 0;
let accountRequestToken = 0;
let modelRequestToken = 0;
let logListRequestToken = 0;
let logDetailRequestToken = 0;
let modelCapabilities = new Map();
let sessionProvider = null;
let sessionLogoutUrl = null;
let accessConfigRequestToken = 0;
let accessSaveToken = 0;

const ROUTES = ["overview", "account", "playground", "keys", "logs", "settings"];
const LOGIN_PATH = "/admin/login";
const ADMIN_PATH = "/admin/";
let activeRoute = null;
function routeFromHash() {
  try {
    const route = decodeURIComponent(location.hash.slice(1));
    return ROUTES.includes(route) ? route : null;
  } catch {
    return null;
  }
}
function renderRoute({ focus = true } = {}) {
  let route = routeFromHash();
  if (!route) {
    route = "overview";
    history.replaceState(null, "", "#overview");
  }
  document.querySelectorAll("[data-route-page]").forEach((page) => {
    page.classList.toggle("hidden", page.dataset.routePage !== route);
  });
  document.querySelectorAll("[data-route-link]").forEach((link) => {
    if (link.dataset.routeLink === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const routeChanged = activeRoute !== route;
  activeRoute = route;
  const authenticated = !$("console").classList.contains("hidden");
  if (routeChanged && route === "logs" && authenticated) void loadLogs();
  if (focus && authenticated) {
    const heading = document.querySelector(`[data-route-page="${route}"] h1`);
    requestAnimationFrame(() => heading?.focus());
  }
}
function navigateTo(route) {
  if (routeFromHash() === route) renderRoute();
  else location.hash = route;
}
function replacePage(path) {
  if (location.pathname === path && location.search === "") return false;
  const hash = routeFromHash() ? location.hash : "";
  location.replace(path + hash);
  return true;
}
function setStreamRouteStatus(running) {
  $("stream-route-status").classList.toggle("hidden", !running);
}
window.addEventListener("hashchange", () => renderRoute());

function setMessage(id, text) { $(id).textContent = text; }
function setBadge(id, text) { $(id).textContent = text; }
function value(id) { return $(id).value.trim(); }
function safeLogoutPath(url) { return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : null; }
function renderAccessConfig(config) {
  const enabled = config?.enabled === true;
  $("access-enabled").checked = enabled;
  $("access-team-domain").value = typeof config?.teamDomain === "string" ? config.teamDomain : "";
  $("access-application-aud").value = typeof config?.applicationAud === "string" ? config.applicationAud : "";
  setBadge("access-state", enabled ? "已启用" : "未启用");
}
function clearAccessConfig() {
  accessConfigRequestToken += 1;
  $("access-enabled").checked = false;
  $("access-team-domain").value = "";
  $("access-application-aud").value = "";
  setBadge("access-state", "未读取");
  setMessage("access-message", "");
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
    const error = new Error(body.error?.message || `HTTP ${response.status}`);
    error.code = body.error?.code;
    error.status = response.status;
    throw error;
  }
  return response;
}

function showAuthenticated(expiresAt, session = {}) {
  uiEpoch += 1;
  sessionProvider = session.provider || "session";
  sessionLogoutUrl = safeLogoutPath(session.logoutUrl);
  if (replacePage(ADMIN_PATH)) return true;
  $("login-view").classList.add("hidden");
  $("login-panel").classList.add("hidden");
  $("console").classList.remove("hidden");
  renderRoute({ focus: false });
  $("session-expiry").textContent = sessionProvider === "access"
    ? "已通过 Cloudflare Access 验证"
    : expiresAt
      ? "本次登录有效至 " + new Date(expiresAt).toLocaleString()
      : "管理员已登录";
  return false;
}

function showLogin(message = "", navigate = true) {
  uiEpoch += 1;
  accountRequestToken += 1;
  modelRequestToken += 1;
  logListRequestToken += 1;
  logDetailRequestToken += 1;
  clearTimeout(pollTimer);
  loginId = null;
  sessionProvider = null;
  sessionLogoutUrl = null;
  requestController?.abort();
  requestController = null;
  conversation = [];
  setStreamRouteStatus(false);
  $("transcript").textContent = "";
  $("prompt").value = "";
  $("created-key").textContent = "";
  $("created-key-panel").classList.add("hidden");
  $("api-key-list").replaceChildren();
  $("api-key-form").reset();
  $("key-allowlist-wrap").classList.add("hidden");
  $("base-url-message").textContent = "";
  clearAccountOverview();
  clearModels();
  $("logs-list").replaceChildren();
  $("log-detail-meta").replaceChildren();
  $("log-detail-bodies").replaceChildren();
  $("log-detail").classList.add("hidden");
  ["logs-key-id", "logs-model", "logs-status", "logs-from", "logs-to"].forEach((id) => { $(id).value = ""; });
  $("logs-key-label").textContent = "全部 key";
  logKeyId = null;
  logCursor = null;
  logNextCursor = null;
  logCursorStack = [];
  logPage = 1;
  $("logs-page-label").textContent = "第 1 页";
  $("logs-prev").disabled = true;
  $("logs-next").disabled = true;
  $("key-edit-form").reset();
  if ($("key-edit-dialog").open) $("key-edit-dialog").close();
  clearAccessConfig();
  $("device-panel").classList.add("hidden");
  $("verification-link").removeAttribute("href");
  $("verification-link").textContent = "";
  $("user-code").textContent = "";
  $("device-login-status").textContent = "";
  setBadge("account-badge", "未检查");
  setBadge("call-badge", "尚未测试");
  setMessage("account-message", "");
  setMessage("api-key-message", "");
  setMessage("logs-message", "");
  setMessage("session-message", "");
  $("stop-button").disabled = true;
  $("send-button").disabled = false;
  $("console").classList.add("hidden");
  if (navigate && replacePage(LOGIN_PATH)) return true;
  $("login-view").classList.remove("hidden");
  $("login-panel").classList.remove("hidden");
  renderRoute({ focus: false });
  $("admin-password").value = "";
  $("save-access-button").disabled = false;
  setMessage("login-message", message);
  return false;
}

async function login(event) {
  event.preventDefault();
  const epoch = ++uiEpoch;
  setMessage("login-message", "");
  const password = $("admin-password").value;
  try {
    const session = await (await api("/admin/session", {
      method: "POST",
      body: JSON.stringify({ password })
    })).json();
    if (epoch !== uiEpoch) return;
    $("admin-password").value = "";
    if (showAuthenticated(session.expiresAt, session)) return;
    await Promise.all([checkStatus(), loadApiKeys(), loadLogSettings(), loadAccessConfig()]);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    $("admin-password").value = "";
    setMessage("login-message", error.message);
  }
}

async function logout() {
  const epoch = uiEpoch;
  const provider = sessionProvider;
  const logoutUrl = sessionLogoutUrl;
  try {
    await adminCall("/admin/session", { method: "DELETE", body: "{}" });
    if (epoch !== uiEpoch) return;
    const accessLogout = provider === "access" && logoutUrl;
    showLogin("已退出后台。Codex 连接和 API 密钥未改变。", !accessLogout);
    if (accessLogout) window.location.assign(logoutUrl);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    if (error.status !== 401) setMessage("session-message", error.message);
  }
}

async function adminCall(path, init = {}) {
  const requestEpoch = uiEpoch;
  try {
    return await api(path, init);
  } catch (error) {
    if (error.status === 401 && requestEpoch === uiEpoch) showLogin("登录已失效，请重新登录。");
    throw error;
  }
}

function showDeviceLogin(login) {
  loginId = login.id;
  $("device-panel").classList.remove("hidden");
  $("verification-link").href = login.verificationUrl;
  $("verification-link").textContent = login.verificationUrl;
  $("user-code").textContent = login.userCode;
  $("device-login-status").textContent = "等待你在官方页面完成授权…";
  schedulePoll(Math.max(0, login.nextPollAt - Date.now()));
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLogin, Math.max(100, delay));
}

async function startDeviceLogin() {
  const epoch = uiEpoch;
  setMessage("account-message", "");
  try {
    const loginState = await (await adminCall("/admin/device/start", { method: "POST", body: "{}" })).json();
    if (epoch !== uiEpoch) return;
    showDeviceLogin(loginState);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("account-message", error.message);
  }
}

async function pollLogin() {
  if (!loginId) return;
  const epoch = uiEpoch;
  try {
    const loginState = await (await adminCall("/admin/device/poll", {
      method: "POST",
      body: JSON.stringify({ login_id: loginId })
    })).json();
    if (epoch !== uiEpoch) return;
    if (loginState.status === "connected") {
      $("device-login-status").textContent = "Codex 已连接并安全保存。";
      setBadge("account-badge", "已连接");
      loginId = null;
      clearTimeout(pollTimer);
      $("device-panel").classList.add("hidden");
      $("verification-link").removeAttribute("href");
      $("verification-link").textContent = "";
      $("user-code").textContent = "";
      return;
    }
    if (loginState.status !== "pending") {
      $("device-login-status").textContent = loginState.error?.message || loginState.status;
      loginId = null;
      return;
    }
    schedulePoll(Math.max(loginState.intervalMs, loginState.nextPollAt - Date.now()));
  } catch (error) {
    if (epoch !== uiEpoch) return;
    if (error.code === "poll_too_soon") schedulePoll(1000);
    else {
      $("device-login-status").textContent = error.message;
      loginId = null;
    }
  }
}

async function cancelDeviceLogin() {
  if (!loginId) return;
  const epoch = uiEpoch;
  try {
    await adminCall("/admin/device/cancel", {
      method: "POST",
      body: JSON.stringify({ login_id: loginId })
    });
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("account-message", error.message);
  }
  if (epoch !== uiEpoch) return;
  loginId = null;
  clearTimeout(pollTimer);
  $("device-panel").classList.add("hidden");
}

async function disconnectCodex() {
  const epoch = uiEpoch;
  try {
    await adminCall("/admin/disconnect", { method: "POST", body: "{}" });
    if (epoch !== uiEpoch) return;
    accountRequestToken += 1;
    modelRequestToken += 1;
    loginId = null;
    clearTimeout(pollTimer);
    conversation = [];
    $("device-panel").classList.add("hidden");
    clearAccountOverview();
    clearModels();
    setBadge("account-badge", "未连接");
    setBadge("call-badge", "尚未测试");
    setMessage("account-message", "Codex 连接和本地账户凭据已清除。后台登录和 API 密钥未改变。");
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("account-message", error.message);
  }
}

async function loadModels() {
  const epoch = uiEpoch;
  const requestToken = ++modelRequestToken;
  setMessage("models-message", "正在读取账户模型目录…");
  try {
    const body = await (await adminCall("/admin/test/models")).json();
    if (epoch !== uiEpoch || requestToken !== modelRequestToken) return;
    modelCapabilities = new Map(body.data.map((model) => [model.id, model.capabilities?.reasoning ?? null]));
    $("models").replaceChildren(...body.data.map((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      return option;
    }));
    if (!value("model") && body.data[0]) $("model").value = body.data[0].id;
    updateReasoningOptions();
    setMessage("models-message", body.data.length ? `账户目录返回 ${body.data.length} 个模型：${body.data.map((model) => model.id).join("、")}` : "账户目录暂未返回可选模型。");
  } catch (error) {
    if (epoch !== uiEpoch || requestToken !== modelRequestToken) return;
    clearModels();
    $("transcript").textContent += `
[模型目录] ${error.message}
`;
  }
}

async function sendTest() {
  const epoch = uiEpoch;
  const prompt = value("prompt");
  const model = value("model");
  if (!prompt || !model) {
    $("transcript").textContent += "\n请填写模型和消息。\n";
    return;
  }
  setBadge("call-badge", "测试中");
  conversation.push({ role: "user", content: prompt });
  $("transcript").textContent += `\n你：${prompt}\n助手：`;
  $("prompt").value = "";
  requestController = new AbortController();
  setStreamRouteStatus(true);
  $("stop-button").disabled = false;
  $("send-button").disabled = true;
  let answer = "";
  let completed = false;
  try {
    const requestBody = { model, input: conversation, stream: true, store: false };
    const effort = value("reasoning-effort");
    if (effort) requestBody.reasoning = { effort };
    const response = await adminCall("/admin/test/responses", {
      method: "POST",
      signal: requestController.signal,
      body: JSON.stringify(requestBody)
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (epoch !== uiEpoch) return;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        const eventType = eventLine?.slice(6).trim() || payload.type;
        if (eventType === "response.output_text.delta") {
          answer += payload.delta;
          $("transcript").textContent += payload.delta;
        }
        if (eventType === "response.completed") completed = true;
        if (eventType === "response.failed" || eventType === "response.incomplete") {
          throw new Error(payload.response?.error?.message || `上游以 ${eventType} 终止`);
        }
        if (eventType === "error") throw new Error(payload.error?.message || "流式请求失败");
      }
    }
    if (!completed) throw new Error("响应流在完成事件前断开");
    conversation.push({ role: "assistant", content: answer });
    $("transcript").textContent += "\n";
    setBadge("call-badge", "测试通过");
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setBadge("call-badge", error.name === "AbortError" ? "已停止" : "测试失败");
    $("transcript").textContent += error.name === "AbortError" ? "\n[已停止]\n" : `\n[错误] ${error.message}\n`;
  } finally {
    if (epoch !== uiEpoch) return;
    requestController = null;
    setStreamRouteStatus(false);
    $("stop-button").disabled = true;
    $("send-button").disabled = false;
  }
}

async function revokeApiKey(id) {
  const epoch = uiEpoch;
  try {
    await adminCall(`/admin/api-keys/${id}`, { method: "DELETE", body: "{}" });
    if (epoch !== uiEpoch) return;
    await loadApiKeys();
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("api-key-message", error.message);
  }
}

async function copyText(text, messageId) {
  try {
    await navigator.clipboard.writeText(text);
    setMessage(messageId, "已复制。");
  } catch {
    setMessage(messageId, "浏览器未允许自动复制，请手动选择文本。");
  }
}

$("login-form").addEventListener("submit", login);
$("access-form").addEventListener("submit", saveAccessConfig);
$("logout-button").addEventListener("click", logout);
$("status-button").addEventListener("click", checkStatus);
$("connect-button").addEventListener("click", startDeviceLogin);
$("disconnect-button").addEventListener("click", disconnectCodex);
$("cancel-login-button").addEventListener("click", cancelDeviceLogin);
$("models-button").addEventListener("click", loadModels);
$("model").addEventListener("input", updateReasoningOptions);
$("model").addEventListener("change", updateReasoningOptions);
$("send-button").addEventListener("click", sendTest);
$("stop-button").addEventListener("click", () => requestController?.abort());
$("clear-button").addEventListener("click", () => { conversation = []; $("transcript").textContent = ""; });
$("api-key-form").addEventListener("submit", createApiKey);
$("copy-key-button").addEventListener("click", () => copyText($("created-key").textContent, "api-key-message"));
$("dismiss-key-button").addEventListener("click", () => {
  $("created-key").textContent = "";
  $("created-key-panel").classList.add("hidden");
});
$("copy-base-url-button").addEventListener("click", () => copyText($("base-url").textContent, "base-url-message"));

restoreSession();

/* Phase-01 admin extensions */
const fmtTime = (ms) => ms == null ? "未知" : new Date(ms).toLocaleString();
const unknown = (v) => v == null || v === "" ? "未知" : String(v);
const jsonBody = async (response) => response.json().catch(() => ({}));
function parseList(text) { return String(text || "").split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean); }
function numericOrNull(id) { const raw = value(id); return raw === "" ? null : Number(raw); }
function keyPayload(prefix = "") {
  const all = $(`${prefix}key-models-all`).checked;
  const models = all ? [] : parseList($( `${prefix}key-allowlist`).value);
  return {
    name: value(prefix ? "edit-key-name" : "api-key-name"),
    expiresAt: $(`${prefix}key-expires`).value ? new Date($(`${prefix}key-expires`).value).getTime() : null,
    modelAccess: { mode: all ? "all" : "allowlist", models },
    rateLimitPerMinute: numericOrNull(`${prefix}key-rpm`),
    concurrencyLimit: numericOrNull(`${prefix}key-concurrency`)
  };
}
function setQuota(card, win) {
  const remaining = card.querySelector("[data-quota-remaining]");
  const meta = card.querySelector("[data-quota-meta]");
  const reset = card.querySelector("[data-quota-reset]");
  const status = card.querySelector("[data-quota-status]");
  if (!win) { remaining.textContent = "未知"; meta.textContent = "未返回此额度窗口"; reset.textContent = "重置时间：未知"; status.textContent = "未知"; return; }
  remaining.textContent = win.remainingPercent == null ? "未知" : `${win.remainingPercent}%`;
  meta.textContent = win.usedPercent == null ? "已用：未知" : `已用 ${win.usedPercent}%`;
  reset.textContent = `重置时间：${fmtTime(win.resetsAt)}`;
  status.textContent = win.remainingPercent == null ? "未知" : "已获取";
}
function clearAccountOverview() {
  $("account-email").textContent = "未知";
  $("account-plan").textContent = "未知";
  $("account-identity").textContent = "未知";
  $("account-updated").textContent = "未知";
  setQuota(document.querySelector('[data-window="5h"]'), null);
  setQuota(document.querySelector('[data-window="7d"]'), null);
  $("additional-quotas").replaceChildren();
  setMessage("account-overview-message", "");
}
function setDefaultReasoningOption(label = "上游默认") {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = label;
  $("reasoning-effort").replaceChildren(option);
}
function updateReasoningOptions() {
  const modelId = value("model");
  const previous = value("reasoning-effort");
  if (!modelId || !modelCapabilities.has(modelId)) {
    setDefaultReasoningOption();
    setMessage("reasoning-message", modelId ? "未获取此模型的思考程度能力；将使用上游默认。" : "加载目录并选择模型后显示可用档位。");
    return;
  }
  const reasoning = modelCapabilities.get(modelId);
  const supported = reasoning?.supported_efforts;
  if (!Array.isArray(supported)) {
    setDefaultReasoningOption();
    setMessage("reasoning-message", "模型目录未提供此模型的思考程度能力；将使用上游默认。");
    return;
  }
  const efforts = [...new Set(supported.filter((effort) => typeof effort === "string" && effort.length > 0))];
  const defaultEffort = typeof reasoning?.default_effort === "string" && efforts.includes(reasoning.default_effort)
    ? reasoning.default_effort
    : null;
  setDefaultReasoningOption(defaultEffort ? `上游默认（${defaultEffort}）` : "上游默认");
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    $("reasoning-effort").append(option);
  }
  if (efforts.includes(previous)) $("reasoning-effort").value = previous;
  setMessage("reasoning-message", efforts.length
    ? `此模型支持：${efforts.join("、")}。${defaultEffort ? "上游默认是 " + defaultEffort + "。" : "默认档位由上游决定。"}`
    : "模型目录明确未提供可选思考档位；将使用上游默认。");
}
function clearModels() {
  modelCapabilities.clear();
  $("models").replaceChildren();
  $("model").value = "";
  setDefaultReasoningOption();
  $("reasoning-effort").value = "";
  setMessage("models-message", "");
  setMessage("reasoning-message", "");
}

async function loadAccountOverview(force = false, inheritedToken = null) {
  const epoch = uiEpoch;
  const requestToken = inheritedToken ?? ++accountRequestToken;
  try {
    const status = await (await adminCall("/admin/status")).json();
    if (epoch !== uiEpoch || requestToken !== accountRequestToken) return;
    const account = status.account;
    $("account-email").textContent = unknown(account?.email);
    $("account-plan").textContent = unknown(account?.plan);
    $("account-identity").textContent = unknown(account?.id || account?.idHint);
    $("account-updated").textContent = fmtTime(account?.lastRefreshAt);
    const usage = await (await adminCall(`/admin/usage${force ? "?refresh=true" : ""}`)).json();
    if (epoch !== uiEpoch || requestToken !== accountRequestToken) return;
    setQuota(document.querySelector('[data-window="5h"]'), usage.windows?.fiveHour);
    setQuota(document.querySelector('[data-window="7d"]'), usage.windows?.sevenDay);
    const extra = $("additional-quotas");
    extra.replaceChildren();
    for (const win of usage.additional || []) {
      const card = document.createElement("article"); card.className = "quota-card additional-quota";
      const title = document.createElement("strong"); title.textContent = win.label || win.limitId || "其他窗口";
      const amount = document.createElement("div"); amount.className = "quota-number"; amount.textContent = win.remainingPercent == null ? "未知" : `${win.remainingPercent}%`;
      const detail = document.createElement("p"); detail.textContent = `已用：${win.usedPercent == null ? "未知" : win.usedPercent + "%"} · 重置：${fmtTime(win.resetsAt)}`;
      card.append(title, amount, detail); extra.append(card);
    }
    setMessage("account-overview-message", usage.available === false ? (usage.error?.message || "额度暂时未获取，稍后可重试。") : `额度数据更新于 ${fmtTime(usage.fetchedAt)}`);
  } catch (error) {
    if (epoch !== uiEpoch || requestToken !== accountRequestToken) return;
    setMessage("account-overview-message", "账户或额度读取失败：" + error.message);
  }
}
async function checkStatus() {
  const epoch = uiEpoch;
  const requestToken = ++accountRequestToken;
  try {
    const body = await (await adminCall("/admin/status")).json();
    if (epoch !== uiEpoch || requestToken !== accountRequestToken) return;
    setBadge("account-badge", body.connected ? "已连接" : body.reauthenticationRequired ? "需要重新连接" : "未连接");
    setMessage("account-message", body.connected ? `账户 ${body.account?.idHint || "已连接"} 已保存。` : "当前没有可用的 Codex 连接。");
    if (body.login?.status === "pending") showDeviceLogin(body.login);
    await loadAccountOverview(false, requestToken);
  } catch (error) {
    if (epoch === uiEpoch && requestToken === accountRequestToken) setMessage("account-message", error.message);
  }
}

async function loadAccessConfig() {
  const epoch = uiEpoch;
  const requestToken = ++accessConfigRequestToken;
  try {
    const body = await (await adminCall("/admin/access")).json();
    if (epoch !== uiEpoch || requestToken !== accessConfigRequestToken) return;
    renderAccessConfig(body);
    setMessage("access-message", body?.updatedAt ? "上次更新：" + fmtTime(body.updatedAt) : "配置已读取。");
  } catch (error) {
    if (epoch === uiEpoch && requestToken === accessConfigRequestToken) setMessage("access-message", error.message);
  }
}
async function saveAccessConfig(event) {
  event.preventDefault();
  const epoch = uiEpoch;
  const requestToken = ++accessSaveToken;
  accessConfigRequestToken += 1;
  const button = $("save-access-button");
  button.disabled = true;
  setMessage("access-message", "正在保存…");
  try {
    const body = await (await adminCall("/admin/access", {
      method: "PATCH",
      body: JSON.stringify({ enabled: $("access-enabled").checked, teamDomain: value("access-team-domain"), applicationAud: value("access-application-aud") })
    })).json();
    if (epoch !== uiEpoch || requestToken !== accessSaveToken) return;
    renderAccessConfig(body);
    setMessage("access-message", body?.updatedAt ? "已保存：" + fmtTime(body.updatedAt) : "Access 配置已保存。");
  } catch (error) {
    if (epoch === uiEpoch && requestToken === accessSaveToken) setMessage("access-message", error.message);
  } finally {
    if (epoch === uiEpoch && requestToken === accessSaveToken) button.disabled = false;
  }
}
async function restoreSession() {
  const epoch = uiEpoch; $("base-url").textContent = location.origin + "/v1";
  try {
    const session = await (await api("/admin/session")).json();
    if (epoch !== uiEpoch) return;
    if (!session.authenticated) return showLogin();
    if (showAuthenticated(session.expiresAt, session)) return;
    await Promise.all([checkStatus(), loadApiKeys(), loadLogSettings(), loadAccessConfig()]);
  } catch (error) { if (epoch === uiEpoch) showLogin(error.message); }
}
function renderKey(key) {
  const row = document.createElement("article"); row.className = "key-row";
  const detail = document.createElement("div"); detail.className = "key-detail";
  const name = document.createElement("strong"); name.textContent = key.name || "未命名 key";
  const tag = document.createElement("span"); const expired = key.expiresAt != null && key.expiresAt <= Date.now(); tag.className = key.enabled === false || expired ? "key-state disabled-state" : "key-state"; tag.textContent = key.enabled === false ? "已停用" : expired ? "已过期" : "可用";
  if (key.id === "legacy") { const legacy = document.createElement("span"); legacy.className = "legacy-tag"; legacy.textContent = "legacykey"; detail.append(name, legacy, tag); } else detail.append(name, tag);
  const meta = document.createElement("span"); meta.textContent = `${key.masked || "无掩码"} · 创建于 ${key.createdAt ? fmtTime(key.createdAt) : "内置"} · 到期：${key.expiresAt == null ? "不过期" : fmtTime(key.expiresAt)}`;
  const policy = document.createElement("span"); const access = key.modelAccess?.mode === "allowlist" ? `白名单：${(key.modelAccess.models || []).join(", ") || "未知"}` : "全部模型";
  policy.textContent = `${access} · RPM：${key.rateLimitPerMinute ?? "不限制"} · 并发：${key.concurrencyLimit ?? "不限制"}`;
  detail.append(meta, policy);
  const actions = document.createElement("div"); actions.className = "key-actions";
  const logs = document.createElement("button"); logs.type = "button"; logs.className = "secondary"; logs.textContent = "查看日志"; logs.addEventListener("click", () => openLogs(key));
  const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary"; edit.textContent = "编辑"; edit.disabled = false; edit.addEventListener("click", () => openKeyEditor(key));
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = key.enabled === false ? "" : "danger"; toggle.textContent = key.enabled === false ? "恢复" : "停用"; toggle.disabled = false; toggle.addEventListener("click", () => toggleKey(key));
  if (key.id !== "legacy") { const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "danger"; revoke.textContent = "撤销"; revoke.addEventListener("click", () => revokeApiKey(key.id)); actions.append(revoke); } actions.append(logs, edit, toggle); row.append(detail, actions); return row;
}
async function loadApiKeys() {
  const epoch = uiEpoch;
  try {
    const body = await (await adminCall("/admin/api-keys")).json(); if (epoch !== uiEpoch) return;
    const list = $("api-key-list"); list.replaceChildren();
    if (!body.data?.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "还没有 API 密钥。"; list.append(empty); return; }
    body.data.forEach((key) => list.append(renderKey(key)));
  } catch (error) { if (epoch === uiEpoch) setMessage("api-key-message", error.message); }
}
async function createApiKey(event) {
  event.preventDefault(); const epoch = uiEpoch; setMessage("api-key-message", "");
  try {
    const created = await (await adminCall("/admin/api-keys", { method: "POST", body: JSON.stringify(keyPayload()) })).json();
    if (epoch !== uiEpoch) return;
    $("api-key-name").value = ""; $("key-allowlist").value = ""; $("key-expires").value = ""; $("key-rpm").value = ""; $("key-concurrency").value = "";
    $("created-key").textContent = created.key || ""; $("created-key-panel").classList.remove("hidden");
    await loadApiKeys();
  } catch (error) { if (epoch === uiEpoch) setMessage("api-key-message", error.message); }
}
async function toggleKey(key) {
  try { await (await adminCall(`/admin/api-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: key.enabled === false }) })).json(); await loadApiKeys(); }
  catch (error) { setMessage("api-key-message", error.message); }
}
function toLocalInput(ms) { return ms == null ? "" : new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function fillEditAllowlist() { $("edit-key-allowlist-wrap").classList.toggle("hidden", $("edit-key-models-all").checked); }
function openKeyEditor(key) { editKeyIsLegacy = key.id === "legacy";
  $("edit-key-name").disabled = editKeyIsLegacy;
  $("edit-key-id").value = key.id; $("edit-key-name").value = key.name || ""; $("edit-key-models-all").checked = key.modelAccess?.mode !== "allowlist"; $("edit-key-models-allowlist").checked = key.modelAccess?.mode === "allowlist"; $("edit-key-allowlist").value = (key.modelAccess?.models || []).join(", "); $("edit-key-expires").value = toLocalInput(key.expiresAt); $("edit-key-rpm").value = key.rateLimitPerMinute ?? ""; $("edit-key-concurrency").value = key.concurrencyLimit ?? ""; fillEditAllowlist(); $("key-edit-message").textContent = ""; $("key-edit-dialog").showModal();
}
async function saveKeyEditor() {
  try { const payload = keyPayload("edit-"); delete payload.name; const patch = editKeyIsLegacy ? payload : { name: value("edit-key-name"), ...payload }; await (await adminCall(`/admin/api-keys/${encodeURIComponent($("edit-key-id").value)}`, { method: "PATCH", body: JSON.stringify(patch) })).json(); $("key-edit-dialog").close(); await loadApiKeys(); }
  catch (error) { $("key-edit-message").textContent = error.message; }
}
let editKeyIsLegacy = false; let logKeyId = null, logCursor = null, logNextCursor = null, logCursorStack = [], logPage = 1;
function openLogs(key) { const alreadyInLogs = routeFromHash() === "logs"; logKeyId = key.id; $("logs-key-id").value = key.id; $("logs-key-label").textContent = `${key.name || "key"} · ${key.masked || key.id}`; logCursor = null; logNextCursor = null; logCursorStack = []; logPage = 1; navigateTo("logs"); if (alreadyInLogs) loadLogs(); }
function closeLogs() { logListRequestToken += 1; logDetailRequestToken += 1; $("log-detail").classList.add("hidden"); navigateTo("keys"); }

function logValue(obj, ...names) { for (const n of names) if (obj?.[n] != null) return obj[n]; return null; }
function bodyIsExpired(log) { return log?.bodyExpired === true || (log?.bodyExpired === undefined && log?.bodyExpiresAt != null && log.bodyExpiresAt <= Date.now()); }
function filterLogsToKey(keyId, keyName) {
  logKeyId = keyId;
  $("logs-key-id").value = keyId;
  $("logs-key-label").textContent = `${unknown(keyName)} · ${keyId}`;
  logCursor = null;
  logNextCursor = null;
  logCursorStack = [];
  logPage = 1;
  loadLogs();
}
function renderLog(log) {
  const row = document.createElement("article");
  row.className = "log-row";
  const main = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${unknown(logValue(log, "model", "modelId"))} · ${unknown(logValue(log, "outcome", "status"))}`;
  const keyMeta = document.createElement("span");
  const keyId = logValue(log, "keyId");
  const keyName = logValue(log, "keyName");
  keyMeta.textContent = `key：${unknown(keyName)} · ${unknown(keyId)}`;
  const meta = document.createElement("span");
  meta.textContent = `${fmtTime(logValue(log, "startedAt", "createdAt"))} · ${unknown(logValue(log, "requestId", "id"))} · ${logValue(log, "durationMs", "latencyMs", "elapsedMs") == null ? "耗时：未知" : "耗时：" + logValue(log, "durationMs", "latencyMs", "elapsedMs") + " ms"}`;
  const usage = log.usage || {};
  const tokens = logValue(log, "tokenUsage", "tokens", "usage") || usage;
  const tok = typeof tokens === "object" ? `输入 ${tokens.inputTokens ?? tokens.promptTokens ?? "未知"} / 输出 ${tokens.outputTokens ?? tokens.completionTokens ?? "未知"} / 总计 ${tokens.totalTokens ?? "未知"}` : unknown(tokens);
  const sub = document.createElement("span");
  sub.textContent = `token usage：${tok}`;
  const ignored = document.createElement("span");
  ignored.textContent = `未生效参数：${Array.isArray(log.ignoredParameters) && log.ignoredParameters.length > 0 ? log.ignoredParameters.join(", ") : "无"}`;
  const bodyState = document.createElement("span");
  const bodyFlags = [];
  if (bodyIsExpired(log)) {
    bodyFlags.push("正文已过期");
  } else {
    if (log.bodyCaptured === false) bodyFlags.push("未记录正文");
    if (log.requestTruncated) bodyFlags.push("请求正文已截断");
    if (log.responseTruncated) bodyFlags.push("响应正文已截断");
  }
  bodyState.textContent = bodyFlags.length ? bodyFlags.join(" · ") : "正文状态：未截断";
  main.append(title, keyMeta, meta, sub, ignored, bodyState);
  const actions = document.createElement("div");
  actions.className = "key-actions";
  const view = document.createElement("button");
  view.type = "button";
  view.className = "secondary";
  view.textContent = "查看详情";
  view.addEventListener("click", () => loadLogDetail(log.id));
  const filter = document.createElement("button");
  filter.type = "button";
  filter.className = "secondary";
  filter.textContent = "筛选此 key";
  filter.disabled = keyId == null || keyId === "";
  filter.addEventListener("click", () => filterLogsToKey(String(keyId), keyName));
  actions.append(view, filter);
  row.append(main, actions);
  return row;
}
async function loadLogs() {
  const epoch = uiEpoch;
  const requestToken = ++logListRequestToken;
  const params = new URLSearchParams();
  const key = value("logs-key-id");
  logKeyId = key || null;
  $("logs-key-label").textContent = key || "全部 key";
  if (key) params.set("keyId", key);
  if (value("logs-model")) params.set("model", value("logs-model"));
  if (value("logs-status")) params.set("outcome", value("logs-status"));
  if (value("logs-from")) params.set("from", String(new Date(value("logs-from")).getTime()));
  if (value("logs-to")) params.set("to", String(new Date(value("logs-to")).getTime()));
  if (logCursor) params.set("cursor", logCursor);
  params.set("limit", "50");
  setMessage("logs-message", "正在读取日志…");
  try {
    const body = await (await adminCall(`/admin/logs?${params}`)).json();
    if (epoch !== uiEpoch || requestToken !== logListRequestToken) return;
    const list = $("logs-list");
    list.dataset.nextCursor = body.nextCursor || "";
    logNextCursor = body.nextCursor || null;
    list.replaceChildren();
    if (!body.data?.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "没有符合条件的日志。";
      list.append(empty);
    } else {
      body.data.forEach((log) => list.append(renderLog(log)));
    }
    $("logs-next").disabled = !logNextCursor;
    $("logs-prev").disabled = logCursorStack.length === 0;
    $("logs-page-label").textContent = `第 ${logPage} 页`;
    setMessage("logs-message", body.data?.length ? `显示 ${body.data.length} 条日志。` : "没有符合条件的日志。");
  } catch (error) {
    if (epoch === uiEpoch && requestToken === logListRequestToken) setMessage("logs-message", error.message);
  }
}

async function loadLogDetail(id) {
  const epoch = uiEpoch;
  const requestToken = ++logDetailRequestToken;
  try {
    const detail = await (await adminCall(`/admin/logs/${encodeURIComponent(id)}`)).json();
    if (epoch !== uiEpoch || requestToken !== logDetailRequestToken) return;
    $("log-detail").classList.remove("hidden");
    $("log-detail-status").textContent = unknown(logValue(detail, "outcome", "status"));
    const meta = $("log-detail-meta");
    meta.replaceChildren();
    const bodyExpired = bodyIsExpired(detail);
    const bodyStatus = bodyExpired
      ? "正文已过期"
      : detail.bodyCaptured === false
        ? "本次请求未开启正文记录"
        : "正文已记录";
    const fields = [
      ["请求 ID", logValue(detail, "requestId", "id")],
      ["key 名称", detail.keyName],
      ["key ID", detail.keyId],
      ["协议", detail.protocol],
      ["模型", logValue(detail, "model", "modelId")],
      ["状态", logValue(detail, "outcome", "status")],
      ["HTTP 状态", detail.httpStatus],
      ["开始", fmtTime(detail.startedAt)],
      ["完成", fmtTime(detail.completedAt)],
      ["耗时", detail.durationMs == null ? "未知" : detail.durationMs + " ms"],
      ["token usage", JSON.stringify(detail.usage || detail.tokenUsage || null)],
      ["未生效参数", Array.isArray(detail.ignoredParameters) && detail.ignoredParameters.length > 0 ? detail.ignoredParameters.join(", ") : "无"],
      ["正文状态", bodyStatus],
      ["正文到期", detail.bodyExpiresAt == null ? "不适用" : fmtTime(detail.bodyExpiresAt)]
    ];
    for (const [label, val] of fields) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = unknown(val);
      meta.append(dt, dd);
    }
    const bodies = $("log-detail-bodies");
    bodies.replaceChildren();
    const addBody = (label, body, truncated) => {
      const wrap = document.createElement("div");
      const h = document.createElement("h4");
      h.textContent = label;
      const status = document.createElement("p");
      status.className = "muted";
      if (bodyExpired) status.textContent = "正文已过期并清理，无法恢复。";
      else if (truncated) status.textContent = "正文超过采集上限，已截断；下面仅显示保留片段。";
      else if (body == null && detail.bodyCaptured === false) status.textContent = "本次请求未开启正文记录。";
      else if (body == null) status.textContent = "正文未完成或不可用。";
      else status.textContent = detail.bodyExpiresAt == null ? "正文已记录。" : `正文保留至 ${fmtTime(detail.bodyExpiresAt)}。`;
      const pre = document.createElement("pre");
      pre.className = "body-preview";
      pre.textContent = body == null ? "无可显示正文。" : typeof body === "string" ? body : JSON.stringify(body, null, 2);
      wrap.append(h, status, pre);
      bodies.append(wrap);
    };
    addBody("请求正文", detail.requestBody, Boolean(detail.requestTruncated));
    addBody("响应正文", detail.responseBody, Boolean(detail.responseTruncated));
    if (detail.requestBody != null || detail.responseBody != null) {
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "secondary";
      exportButton.textContent = "下载正文";
      exportButton.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `oneapi-log-${id}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
      bodies.append(exportButton);
    }
  } catch (error) {
    if (epoch === uiEpoch && requestToken === logDetailRequestToken) setMessage("logs-message", error.message);
  }
}
async function loadLogSettings() { const epoch = uiEpoch;
  try { const s = await (await adminCall("/admin/log-settings")).json(); if (epoch !== uiEpoch) return; $("log-body-enabled").checked = Boolean(s.captureBodies); $("log-retention-days").value = s.summaryRetentionDays ?? 30; $("body-retention-days").value = s.bodyRetentionDays ?? 7; $("log-settings-state").textContent = s.captureBodies ? "正文已开启" : "正文已关闭"; }
  catch (error) { setMessage("log-settings-message", error.message); }
}
async function saveLogSettings() { const epoch = uiEpoch;
  try { const body = await (await adminCall("/admin/log-settings", { method: "PATCH", body: JSON.stringify({ captureBodies: $("log-body-enabled").checked, summaryRetentionDays: Number($("log-retention-days").value), bodyRetentionDays: Number($("body-retention-days").value) }) })).json(); if (epoch !== uiEpoch) return; $("log-settings-state").textContent = body.captureBodies ? "正文已开启" : "正文已关闭"; setMessage("log-settings-message", "日志设置已保存。"); }
  catch (error) { setMessage("log-settings-message", error.message); }
}
$("refresh-account-button").addEventListener("click", () => loadAccountOverview(true));
$("key-models-all").addEventListener("change", () => $("key-allowlist-wrap").classList.add("hidden"));
$("key-models-allowlist").addEventListener("change", () => $("key-allowlist-wrap").classList.remove("hidden"));
$("edit-key-models-all").addEventListener("change", fillEditAllowlist); $("edit-key-models-allowlist").addEventListener("change", fillEditAllowlist);
$("key-edit-save").addEventListener("click", saveKeyEditor);
$("logs-filter-button").addEventListener("click", () => { logCursor = null; logNextCursor = null; logCursorStack = []; logPage = 1; loadLogs(); });
$("logs-close-button").addEventListener("click", closeLogs); $("logs-next").addEventListener("click", () => { if (!logNextCursor) return; logCursorStack.push(logCursor); logCursor = logNextCursor; logPage += 1; loadLogs(); }); $("logs-prev").addEventListener("click", () => { if (!logCursorStack.length) return; logCursor = logCursorStack.pop(); logPage = Math.max(1, logPage - 1); loadLogs(); }); $("save-log-settings-button").addEventListener("click", saveLogSettings);


$("all-logs-button").addEventListener("click", () => { const alreadyInLogs = routeFromHash() === "logs"; logKeyId = null; $("logs-key-id").value = ""; $("logs-key-label").textContent = "全部 key"; logCursor = null; logNextCursor = null; logCursorStack = []; logPage = 1; navigateTo("logs"); if (alreadyInLogs) loadLogs(); });
