// 弹窗逻辑：监控控制、设置读写、历史渲染、旧自动创建流程
const $ = id => document.getElementById(id);
let pickedFile = null;

// ==================== 监控已有 STA ====================
$("monStart").addEventListener("click", () => {
  const id = $("taskId").value.trim();
  if (!id) { renderMonStatus("请先粘贴 localTaskId", "error"); return; }
  chrome.runtime.sendMessage({ type: "START_MONITOR", localTaskId: id }, res => {
    if (res && res.ok === false) renderMonStatus(res.error, "error");
  });
});

$("monStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_MONITOR" });
});

function renderMonStatus(text, cls) {
  $("monStatus").textContent = text;
  $("monStatus").className = "status " + (cls || "");
}

function renderMonitor(m) {
  if (!m) { renderMonStatus("未在监控"); return; }
  const map = {
    starting: ["🚀 启动中，正在打开 STA 页面…", ""],
    probing: [`🔄 第 ${m.attempts} 次探测进行中…`, "probing"],
    waiting: [`⏳ 已探测 ${m.attempts} 次，最高命中 ${maxHit(m)} 个，${RETRY_HINT}`, "waiting"],
    success: [`🎯 达标！命中 ${m.lastHitCount} 个好仓，已停止重试`, "success"],
    maxed: [`已达最大轮询次数（${m.attempts} 次），停止监控`, "maxed"],
    stopped: ["⏹ 已手动停止", ""],
    error: [`⚠️ 出错（将自动重试）：${m.lastError || ""}`, "error"]
  };
  const [text, cls] = map[m.status] || [m.status, ""];
  renderMonStatus(`STA ${m.localTaskId} ｜ ${text}`, cls);

  if (m.status === "success" || m.lastCodes) {
    $("monResult").style.display = "block";
    const pass = m.lastPass;
    $("monBig").textContent = pass
      ? `🎯 命中 ${m.lastHitCount} 个好仓（达标）`
      : `最近一轮命中 ${m.lastHitCount || 0} 个好仓`;
    $("monBig").className = "big " + (pass ? "ok" : "no");
    renderChips($("monChips"), m.lastDetails || [], m.lastHits || [], m.lastCodes || []);
  }
  $("monLog").value = (m.log || []).join("\n");
  renderHistory(m.history || []);
}

function maxHit(m) {
  const hs = (m.history || []).map(h => h.hitCount || 0);
  return Math.max(m.lastHitCount || 0, ...(hs.length ? hs : [0]));
}
const RETRY_HINT = "10 分钟后自动重摇";

function renderChips(box, details, hits, fallbackCodes) {
  const hitSet = new Set(hits || []);
  const items = (details && details.length)
    ? details.map(d => ({ code: d.code, region: d.region }))
    : (fallbackCodes || []).map(c => ({ code: c, region: "" }));
  box.innerHTML = items.length
    ? items.map(c => `<span class="chip ${hitSet.has(c.code) ? "hit" : "norm"}" title="${c.code}${hitSet.has(c.code) ? "（好仓）" : ""}">${c.region || ""}${c.code}</span>`).join("")
    : '<span class="chip norm">无</span>';
}

function renderHistory(history) {
  const box = $("history");
  if (!history.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
  box.innerHTML = [...history].reverse().map(h => {
    const hitSet = new Set(h.hits || []);
    const items = (h.details && h.details.length)
      ? h.details.map(d => ({ code: d.code, region: d.region }))
      : (h.codes || []).map(c => ({ code: c, region: "" }));
    const chipHtml = items.map(c =>
      `<span class="chip ${hitSet.has(c.code) ? "hit" : "norm"}">${c.region || ""}${c.code}</span>`).join("");
    const time = new Date(h.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `<div class="h-item">
      <div class="h-head"><b>#${h.attempt}</b><span class="h-time">${time}</span>
      <span class="h-count ${h.pass ? "ok" : ""}">命中 ${h.hitCount}</span></div>
      <div class="h-chips">${chipHtml}</div></div>`;
  }).join("");
}

// ==================== 监控设置 ====================
function renderSettings(s) {
  $("setThreshold").value = s.threshold;
  $("setMaxAttempts").value = s.maxAttempts;
  $("setWhitelist").value = (s.warehouses || []).join(", ");
  $("whCount").textContent = `当前 ${(s.warehouses || []).length} 个`;
}

$("saveSettings").addEventListener("click", () => {
  const warehouses = $("setWhitelist").value.split(/[\s,，、]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
  const threshold = parseInt($("setThreshold").value, 10) || 5;
  const maxAttempts = parseInt($("setMaxAttempts").value, 10) || 100;
  if (!warehouses.length) { $("setMsg").textContent = "白名单不能为空"; $("setMsg").style.color = "#dc2626"; return; }
  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { threshold, maxAttempts, warehouses } }, () => {
    renderSettings({ threshold, maxAttempts, warehouses });
    $("setMsg").textContent = "已保存 ✓";
    setTimeout(() => { $("setMsg").textContent = ""; }, 2000);
  });
});

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, s => { if (s) renderSettings(s); });

// ==================== 钉钉配置 ====================
function renderDing(cfg) {
  $("dingWebhook").value = cfg.webhook || "";
  $("dingSecret").value = cfg.secret || "";
}
$("dingSave").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SAVE_DING",
    webhook: $("dingWebhook").value.trim(),
    secret: $("dingSecret").value.trim()
  }, () => {
    $("dingStatus").textContent = "已保存 ✓";
    setTimeout(() => { $("dingStatus").textContent = ""; }, 2000);
  });
});
$("dingTest").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SAVE_DING",
    webhook: $("dingWebhook").value.trim(),
    secret: $("dingSecret").value.trim()
  }, () => {
    $("dingStatus").textContent = "发送中…";
    chrome.runtime.sendMessage({ type: "DING_TEST" }, res => {
      $("dingStatus").textContent = res && res.ok ? "测试消息已发出，请看钉钉群 ✓" : "失败：" + ((res && res.reason) || "未知");
    });
  });
});
chrome.runtime.sendMessage({ type: "GET_DING" }, cfg => { if (cfg) renderDing(cfg); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.lx_monitor) renderMonitor(changes.lx_monitor.newValue);
    if (changes.lx_settings) renderSettings(changes.lx_settings.newValue);
  }
});
chrome.runtime.sendMessage({ type: "GET_MONITOR" }, m => { if (m) renderMonitor(m); });

// ==================== 旧流程：自动创建 STA ====================
$("file").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  pickedFile = f;
  const label = $("fileLabel");
  label.textContent = "✓ " + f.name;
  label.style.borderColor = "#16a34a";
  label.style.color = "#16a34a";
  label.style.borderStyle = "solid";
  $("start").disabled = false;
});

$("start").addEventListener("click", () => {
  if (!pickedFile) return;
  $("err").style.display = "none";
  $("result").style.display = "none";
  $("start").disabled = true;
  $("start").textContent = "运行中…（请勿关闭领星页面）";
  renderSteps([{ name: "启动", status: "doing", detail: "正在打开领星页面…" }]);

  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result).split(",")[1];
    chrome.runtime.sendMessage({
      type: "START",
      payload: { fileB64: b64, fileName: pickedFile.name }
    }, () => { if (chrome.runtime.lastError) showError(chrome.runtime.lastError.message); });
  };
  reader.onerror = () => showError("读取文件失败");
  reader.readAsDataURL(pickedFile);
});

function showError(msg) {
  $("err").textContent = "出错：" + msg;
  $("err").style.display = "block";
  $("start").disabled = false;
  $("start").textContent = "开 始";
}

function render(st) {
  if (!st) return;
  renderSteps(st.steps || []);
  if (st.status === "done") {
    $("start").disabled = false;
    $("start").textContent = "再跑一次";
    const pass = st.hitCount >= (st.threshold || 5);
    $("result").style.display = "block";
    $("big").textContent = pass
      ? `🎯 命中 ${st.hitCount} 个好仓（达标）`
      : `最近一轮命中 ${st.hitCount} 个好仓`;
    $("big").className = "big " + (pass ? "ok" : "no");
    renderChips($("chips"), st.details || [], st.hits || [], st.allCodes || []);
    $("raw").value = st.rawText || "";
  } else if (st.status === "stopped") {
    $("start").disabled = false;
    $("start").textContent = "再跑一次";
  } else if (st.status === "error") {
    showError(st.error || "未知错误");
  }
}

function renderSteps(steps) {
  if (!steps || !steps.length) return;
  const map = { ok: "✓", doing: "…", warn: "!", fail: "✗", user: "✋", pending: "·" };
  $("steps").innerHTML = steps.map(s =>
    `<div style="display:flex;justify-content:space-between;padding:2px 0">` +
    `<span>${map[s.status] || "·"} ${escapeHtml(s.name)}</span>` +
    `<span style="color:${{ ok: "#16a34a", doing: "#2563eb", warn: "#d97706", fail: "#dc2626", user: "#d97706" }[s.status] || "#6b7280"}">` +
    `${escapeHtml(s.detail || "")}</span></div>`
  ).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

$("copy").addEventListener("click", async () => {
  const st = await new Promise(r => chrome.runtime.sendMessage({ type: "GET_STATE" }, r));
  const logs = await new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOGS" }, r));
  const text = JSON.stringify({ state: st, recentLogs: (logs || []).slice(0, 5) }, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    $("copy").textContent = "已复制到剪贴板";
    setTimeout(() => { $("copy").textContent = "复制结果与调试日志"; }, 2000);
  });
});

chrome.runtime.sendMessage({ type: "GET_STATE" }, st => { if (st) render(st); });
