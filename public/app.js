const $ = (id) => document.getElementById(id);
let loginId = null;
let pollTimer = null;
let requestController = null;
let conversation = [];
let uiEpoch = 0;

function setMessage(id, text) { $(id).textContent = text; }
function setBadge(id, text) { $(id).textContent = text; }
function value(id) { return $(id).value.trim(); }

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

function showAuthenticated(expiresAt) {
  uiEpoch += 1;
  $("login-panel").classList.add("hidden");
  $("console").classList.remove("hidden");
  $("session-expiry").textContent = expiresAt
    ? `本次登录有效至 ${new Date(expiresAt).toLocaleString()}`
    : "管理员已登录";
}

function showLogin(message = "") {
  uiEpoch += 1;
  clearTimeout(pollTimer);
  loginId = null;
  requestController?.abort();
  requestController = null;
  conversation = [];
  $("transcript").textContent = "";
  $("prompt").value = "";
  $("created-key").textContent = "";
  $("created-key-panel").classList.add("hidden");
  $("api-key-list").replaceChildren();
  $("models").replaceChildren();
  setMessage("models-message", "");
  $("device-panel").classList.add("hidden");
  $("verification-link").removeAttribute("href");
  $("verification-link").textContent = "";
  $("user-code").textContent = "";
  $("device-login-status").textContent = "";
  $("stop-button").disabled = true;
  $("send-button").disabled = false;
  $("console").classList.add("hidden");
  $("login-panel").classList.remove("hidden");
  $("admin-password").value = "";
  setMessage("login-message", message);
}

async function restoreSession() {
  const epoch = uiEpoch;
  $("base-url").textContent = `${location.origin}/v1`;
  try {
    const session = await (await api("/admin/session")).json();
    if (epoch !== uiEpoch) return;
    if (!session.authenticated) return showLogin();
    showAuthenticated(session.expiresAt);
    await Promise.all([checkStatus(), loadApiKeys()]);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    showLogin(error.message);
  }
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
    showAuthenticated(session.expiresAt);
    await Promise.all([checkStatus(), loadApiKeys()]);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    $("admin-password").value = "";
    setMessage("login-message", error.message);
  }
}

async function logout() {
  const epoch = uiEpoch;
  try {
    await adminCall("/admin/session", { method: "DELETE", body: "{}" });
    if (epoch !== uiEpoch) return;
    showLogin("已退出后台。Codex 连接和 API 密钥未改变。");
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

async function checkStatus() {
  const epoch = uiEpoch;
  try {
    const body = await (await adminCall("/admin/status")).json();
    if (epoch !== uiEpoch) return;
    setBadge("account-badge", body.connected ? "已连接" : body.reauthenticationRequired ? "需要重新连接" : "未连接");
    setMessage("account-message", body.connected ? `账户 ${body.account.idHint} 已保存。` : "当前没有可用的 Codex 连接。");
    if (body.login?.status === "pending") showDeviceLogin(body.login);
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("account-message", error.message);
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
    loginId = null;
    clearTimeout(pollTimer);
    conversation = [];
    $("device-panel").classList.add("hidden");
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
  setMessage("models-message", "正在读取账户模型目录…");
  try {
    const body = await (await adminCall("/admin/test/models")).json();
    if (epoch !== uiEpoch) return;
    $("models").replaceChildren(...body.data.map((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      return option;
    }));
    if (!value("model") && body.data[0]) $("model").value = body.data[0].id;
    setMessage("models-message", body.data.length ? `账户目录返回 ${body.data.length} 个模型：${body.data.map(model => model.id).join("、")}` : "账户目录暂未返回可选模型。");
  } catch (error) {
    if (epoch !== uiEpoch) return;
    $("models").replaceChildren();
    setMessage("models-message", "模型目录读取失败。");
    $("transcript").textContent += `\n[模型目录] ${error.message}\n`;
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
  $("stop-button").disabled = false;
  $("send-button").disabled = true;
  let answer = "";
  let completed = false;
  try {
    const response = await adminCall("/admin/test/responses", {
      method: "POST",
      signal: requestController.signal,
      body: JSON.stringify({ model, input: conversation, stream: true, store: false })
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
    $("stop-button").disabled = true;
    $("send-button").disabled = false;
  }
}

async function loadApiKeys() {
  const epoch = uiEpoch;
  try {
    const body = await (await adminCall("/admin/api-keys")).json();
    if (epoch !== uiEpoch) return;
    const list = $("api-key-list");
    list.replaceChildren();
    if (body.data.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "还没有 API 密钥。";
      list.append(empty);
      return;
    }
    for (const key of body.data) {
      const row = document.createElement("div");
      row.className = "key-row";
      const detail = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = key.name;
      const metadata = document.createElement("span");
      metadata.textContent = `${key.masked} · ${new Date(key.createdAt).toLocaleString()}`;
      detail.append(name, metadata);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "撤销";
      revoke.addEventListener("click", () => revokeApiKey(key.id));
      row.append(detail, revoke);
      list.append(row);
    }
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("api-key-message", error.message);
  }
}

async function createApiKey(event) {
  event.preventDefault();
  const epoch = uiEpoch;
  setMessage("api-key-message", "");
  try {
    const created = await (await adminCall("/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: value("api-key-name") })
    })).json();
    if (epoch !== uiEpoch) return;
    $("api-key-name").value = "";
    $("created-key").textContent = created.key;
    $("created-key-panel").classList.remove("hidden");
    await loadApiKeys();
  } catch (error) {
    if (epoch !== uiEpoch) return;
    setMessage("api-key-message", error.message);
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
$("logout-button").addEventListener("click", logout);
$("status-button").addEventListener("click", checkStatus);
$("connect-button").addEventListener("click", startDeviceLogin);
$("disconnect-button").addEventListener("click", disconnectCodex);
$("cancel-login-button").addEventListener("click", cancelDeviceLogin);
$("models-button").addEventListener("click", loadModels);
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
