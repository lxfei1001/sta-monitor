// 后台调度：接收弹窗指令，驱动内容脚本执行流程，收集结果与留痕
importScripts("config.js");

const STATE_KEY = "lx_state";      // 当前运行状态（弹窗实时渲染）
const LOGS_KEY = "lx_logs";        // 历史运行记录（供核查）

function initState(fileName) {
  return {
    status: "running",             // running | done | error | stopped
    fileName: fileName || "",
    steps: [],                     // {name, status: pending|doing|ok|warn|fail|user, detail}
    hits: [],
    hitCount: 0,
    allCodes: [],
    rawText: "",
    debug: [],
    startedAt: Date.now(),
    finishedAt: 0
  };
}

async function getState() {
  const o = await chrome.storage.local.get(STATE_KEY);
  return o[STATE_KEY] || null;
}
async function setState(st) {
  await chrome.storage.local.set({ [STATE_KEY]: st });
}
function patchState(patch) {
  return getState().then(st => {
    const next = Object.assign({}, st || {}, patch);
    return setState(next);
  });
}
function ensureStep(st, name) {
  let s = st.steps.find(x => x.name === name);
  if (!s) { s = { name, status: "pending", detail: "" }; st.steps.push(s); }
  return s;
}
async function setStep(name, status, detail) {
  const st = (await getState()) || initState("");
  const s = ensureStep(st, name);
  s.status = status;
  if (detail !== undefined) s.detail = detail;
  await setState(st);
}

function dbg(line) {
  return getState().then(st => {
    if (!st) return;
    st.debug.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (st.debug.length > 300) st.debug = st.debug.slice(-300);
    return setState(st);
  });
}

// 可编辑设置（阈值/最大轮询/白名单），首次从 config.js 默认值播种
const SETTINGS_KEY = "lx_settings";

async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  if (o[SETTINGS_KEY]) return o[SETTINGS_KEY];
  const def = { threshold: LX_CONFIG.threshold, maxAttempts: 100, warehouses: LX_CONFIG.warehouses };
  await chrome.storage.local.set({ [SETTINGS_KEY]: def });
  return def;
}

async function matchCodes(allCodes) {
  const st = await getSettings();
  const set = new Set(allCodes.map(c => c.toUpperCase()));
  const hits = st.warehouses.filter(w => set.has(String(w).toUpperCase()));
  return { hits, hitCount: hits.length, pass: hits.length >= st.threshold, threshold: st.threshold };
}

async function saveLog(entry) {
  const o = await chrome.storage.local.get(LOGS_KEY);
  const logs = o[LOGS_KEY] || [];
  logs.unshift(entry);
  if (logs.length > 200) logs.length = 200;
  await chrome.storage.local.set({ [LOGS_KEY]: logs });
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message,
      priority: 2
    });
  } catch (e) { /* 通知失败不影响主流程 */ }
}

// ============ 钉钉群机器人通知（webhook + 可选加签） ============
const DING_KEY = "lx_dingtalk";

async function dingtalkSend(title, text) {
  const o = await chrome.storage.local.get(DING_KEY);
  const cfg = o[DING_KEY] || {};
  const webhook = (cfg.webhook || "").trim();
  if (!webhook || !webhook.includes("access_token=")) {
    return { ok: false, reason: "未配置钉钉 webhook" };
  }
  let url = webhook;
  const secret = (cfg.secret || "").trim();
  if (secret) {
    const ts = Date.now();
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}\n${secret}`));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    url += `&timestamp=${ts}&sign=${encodeURIComponent(b64)}`;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { title, text: `### ${title}\n\n${text}` } })
  });
  const body = await resp.json();
  if (body.errcode === 0) return { ok: true };
  return { ok: false, reason: body.errmsg || JSON.stringify(body) };
}

// 网络请求记录仪：运行期间记录领星 POST 请求（排查 sid 之类的参数问题）
let reqLogging = false;
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!reqLogging || details.method !== "POST") return;
    let body = "";
    try {
      if (details.requestBody && details.requestBody.raw) {
        const dec = new TextDecoder();
        body = details.requestBody.raw.map(r => r.bytes ? dec.decode(r.bytes).slice(0, 200) : "").join("");
      } else if (details.requestBody && details.requestBody.formData) {
        body = Object.entries(details.requestBody.formData)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? v[0] : v}`.slice(0, 100)).join("&").slice(0, 300);
      }
    } catch (e) {}
    dbg(`REQ ${details.method} ${details.url.slice(0, 150)} ${body ? "body=" + body.slice(0, 250) : "(无body)"}`);
  },
  { urls: ["https://erp.lingxing.com/*"] },
  ["requestBody"]
);

// 等待标签页加载完成
function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") { clearInterval(timer); resolve(true); }
      } catch (e) { clearInterval(timer); resolve(false); }
      if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(false); }
    }, 500);
  });
}

// 给内容脚本发消息（带重试，SPA 脚本可能尚未就绪）
function sendToTab(tabId, msg, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const attempt = (left) => {
      chrome.tabs.sendMessage(tabId, msg, res => {
        if (chrome.runtime.lastError) {
          if (left > 0) return setTimeout(() => attempt(left - 1), 1000);
          if (!settled) { settled = true; reject(new Error(chrome.runtime.lastError.message)); }
          return;
        }
        if (!settled) { settled = true; resolve(res); }
      });
    };
    attempt(5);
    setTimeout(() => { if (!settled) { settled = true; reject(new Error("content script 响应超时")); } }, timeoutMs);
  });
}

async function runFlow(payload) {
  const { fileB64, fileName } = payload;
  await setState(initState(fileName));
  const shopKey = (fileName || "").replace(/\.(xlsx|xls|csv)$/i, "");
  reqLogging = true;

  try {
    await setStep("打开创建STA页面", "doing", shopKey);
    const tab = await chrome.tabs.create({ url: LX_CONFIG.staUrl, active: true });
    await waitTabComplete(tab.id);
    await new Promise(r => setTimeout(r, 2500)); // SPA 渲染余量
    await setStep("打开创建STA页面", "ok", "页面已加载");

    // 心跳：内容脚本运行期间定期 ping，防止 service worker 被回收
    const hb = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);

    const result = await sendToTab(tab.id, {
      cmd: "RUN_FLOW",
      shopKey,
      fileB64,
      fileName,
      threshold: LX_CONFIG.threshold
    });

    clearInterval(hb);
    reqLogging = false;

    if (!result) throw new Error("内容脚本无响应");
    if (result.error) throw new Error(result.error);

    const { allCodes, rawText, stoppedAt, details } = result;
    await setStep("提取物流中心编码", allCodes && allCodes.length ? "ok" : "fail",
      allCodes && allCodes.length ? `提取到 ${allCodes.length} 个编码` : "未提取到编码");
    await patchState({ allCodes: allCodes || [], rawText: rawText || "", details: details || [] });

    if (stoppedAt) {
      await patchState({ status: "stopped", finishedAt: Date.now() });
      await saveLog({ ts: Date.now(), shop: shopKey, stoppedAt, allCodes: allCodes || [], rawText: (rawText || "").slice(0, 2000) });
      notify("流程已停止", `在「${stoppedAt}」环节停止，详情见插件弹窗`);
      return;
    }

    const m = await matchCodes(allCodes || []);
    await patchState({
      status: "done",
      finishedAt: Date.now(),
      hits: m.hits,
      hitCount: m.hitCount
    });
    await setStep("匹配好仓库", "ok", m.pass
      ? `命中 ${m.hitCount} 个（≥${m.threshold} 达标）：${m.hits.join("、")}`
      : `仅命中 ${m.hitCount} 个（<${m.threshold} 未达标）`);

    await saveLog({
      ts: Date.now(), shop: shopKey, allCodes: allCodes || [],
      details: details || [], hits: m.hits, hitCount: m.hitCount, pass: m.pass,
      rawText: (rawText || "").slice(0, 4000)
    });

    notify(
      m.pass ? `好仓库达标：命中 ${m.hitCount} 个` : `未达标：仅命中 ${m.hitCount} 个好仓`,
      `${shopKey} ｜ ${m.pass ? m.hits.join("、") : (m.hits.join("、") || "无命中")}`
    );
  } catch (e) {
    await dbg("FLOW_ERROR: " + (e && e.message));
    await patchState({ status: "error", error: e && e.message, finishedAt: Date.now() });
    await setStep("流程", "fail", (e && e.message) || "未知错误");
    await saveLog({ ts: Date.now(), shop: shopKey, error: e && e.message });
    notify("流程出错", (e && e.message) || "未知错误");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START") {
    runFlow(msg.payload).finally(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "PROGRESS") { // 内容脚本步骤进度
    setStep(msg.step, msg.status, msg.detail).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "DEBUG") {
    dbg(msg.line).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_STATE") {
    getState().then(st => sendResponse(st));
    return true;
  }
  if (msg.type === "GET_LOGS") {
    chrome.storage.local.get(LOGS_KEY).then(o => sendResponse(o[LOGS_KEY] || []));
    return true;
  }
  if (msg.type === "START_MONITOR") {
    startMonitor(msg.localTaskId).then(r => sendResponse(r));
    return true;
  }
  if (msg.type === "STOP_MONITOR") {
    stopMonitor().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_MONITOR") {
    getMonitor().then(m => sendResponse(m));
    return true;
  }
  if (msg.type === "DING_TEST") {
    dingtalkSend("✅ 好仓库监控助手接入成功", "这是一条测试消息，收到即说明钉钉通知已打通。").then(sendResponse);
    return true;
  }
  if (msg.type === "SAVE_DING") {
    chrome.storage.local.set({ [DING_KEY]: { webhook: msg.webhook || "", secret: msg.secret || "" } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_DING") {
    chrome.storage.local.get(DING_KEY).then(o => sendResponse(o[DING_KEY] || {}));
    return true;
  }
  if (msg.type === "SAVE_SETTINGS") {
    chrome.storage.local.set({ [SETTINGS_KEY]: msg.settings }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_SETTINGS") {
    getSettings().then(s => sendResponse(s));
    return true;
  }
});

// ============ 监控已有 STA（循环重试直到出好仓） ============
// 流程：打开 editSendToAmazon → 点「提交装箱并继续」（或「创建」）→ 确认弹窗 → 读编码
//       好仓 ≥3 → 提醒并停止；<3 → 10 分钟后「上一步」→ 重新提交装箱，循环
// 铁律：绝不点击「申报货件并提交配送服务」——只读仓库分配，不真实申报

const MON_KEY = "lx_monitor";
const ALARM_NAME = "lx-sta-probe";
const RETRY_MINUTES = 10;

function editUrl(id) {
  return `https://erp.lingxing.com/erp/msupply/editSendToAmazon?localTaskId=${id}&regenerateShipment=false&openRestartDialog=false&positionType=1&next=0`;
}

async function getMonitor() {
  const o = await chrome.storage.local.get(MON_KEY);
  return o[MON_KEY] || null;
}
async function setMonitor(m) {
  await chrome.storage.local.set({ [MON_KEY]: m });
}

async function startMonitor(rawId) {
  const id = (String(rawId || "").match(/\d{6,}/) || [])[0];
  if (!id) return { ok: false, error: "localTaskId 无效（需要纯数字ID）" };
  await setMonitor({
    active: true, localTaskId: id, attempts: 0,
    status: "starting", startedAt: Date.now(), tabId: null
  });
  runProbeCycle(true); // 异步启动首次探测
  return { ok: true };
}

async function stopMonitor() {
  chrome.alarms.clear(ALARM_NAME);
  const m = await getMonitor();
  if (m) { m.active = false; m.status = "stopped"; await setMonitor(m); }
}

chrome.alarms.onAlarm.addListener(al => {
  if (al.name === ALARM_NAME) runProbeCycle(false);
});

async function scheduleRetry() {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: RETRY_MINUTES });
}

async function runProbeCycle(isFirst) {
  const mon = await getMonitor();
  if (!mon || !mon.active) return;
  const settings = await getSettings();
  if ((mon.attempts || 0) >= settings.maxAttempts) {
    mon.active = false; mon.status = "maxed";
    await setMonitor(mon);
    chrome.alarms.clear(ALARM_NAME);
    const best = Math.max(0, ...(mon.history || [{ hitCount: 0 }]).map(h => h.hitCount || 0));
    notify("监控已停止", `已达最大轮询次数（${settings.maxAttempts} 次），历史最高命中 ${best} 个好仓`);
    return;
  }
  mon.attempts = (mon.attempts || 0) + 1;
  mon.status = "probing";
  mon.lastProbeAt = Date.now();
  await setMonitor(mon);
  reqLogging = true;

  try {
    // 打开或复用标签页
    let tabId = mon.tabId;
    let tabOk = false;
    if (tabId) {
      try { const t = await chrome.tabs.get(tabId); tabOk = !!t; } catch (e) { tabOk = false; }
    }
    if (!tabOk) {
      const t = await chrome.tabs.create({ url: editUrl(mon.localTaskId), active: true });
      tabId = t.id;
      await waitTabComplete(tabId);
      await new Promise(r => setTimeout(r, 3000));
      mon.tabId = tabId;
      await setMonitor(mon);
    }

    const res = await sendToTab(tabId, { cmd: "RUN_PROBE", isFirst: !!isFirst });
    reqLogging = false;
    if (!res) throw new Error("页面无响应");
    if (res.error) throw new Error(res.error);
    if (res.stopped) {
      mon.active = false; mon.status = "stopped";
      await setMonitor(mon);
      return;
    }

    const m = await matchCodes(res.allCodes || []);
    mon.lastCodes = res.allCodes || [];
    mon.lastDetails = res.details || [];
    mon.lastHits = m.hits;
    mon.lastHitCount = m.hitCount;
    mon.lastPass = m.pass;
    mon.status = m.pass ? "success" : "waiting";
    mon.history = (mon.history || []).concat([{
      attempt: mon.attempts, ts: Date.now(),
      codes: res.allCodes || [], details: res.details || [],
      hits: m.hits, hitCount: m.hitCount, pass: m.pass
    }]);
    if (mon.history.length > 300) mon.history = mon.history.slice(-300);

    // 详细日志：本轮探测的完整轨迹 + 判定摘要
    const det = (res.details || []).map(d => (d.region || "") + d.code).join("、");
    const summary = [
      `━━━ 探测 #${mon.attempts} ━━━ ${new Date().toLocaleString()}`,
      `动作: ${isFirst ? "首次提交" : "上一步→重新提交"}（耗时 ${res.elapsedSec || "?"}s）`,
      `分配: ${det || (res.allCodes || []).join("、") || "无"}（共 ${(res.allCodes || []).length} 个）`,
      `命中: ${m.hitCount} 个好仓${m.hits.length ? "（" + m.hits.join("、") + "）" : ""} → ${m.pass ? "✅ 达标，停止重试" : "❌ 未达标"}`,
      m.pass ? "" : `下次: ${RETRY_MINUTES} 分钟后自动重试`
    ].filter(Boolean);
    mon.log = (mon.log || []).concat(summary, (res.trace || []).map(l => "  " + l));
    if (mon.log.length > 400) mon.log = mon.log.slice(-400);
    await setMonitor(mon);

    await saveLog({
      ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId,
      attempt: mon.attempts, allCodes: res.allCodes || [], details: res.details || [],
      hits: m.hits, hitCount: m.hitCount, pass: m.pass,
      rawText: (res.rawText || "").slice(0, 3000)
    });

    if (m.pass) {
      chrome.alarms.clear(ALARM_NAME);
      notify(`🎯 好仓库达标：命中 ${m.hitCount} 个`, `STA ${mon.localTaskId} ｜ ${m.hits.join("、")} ｜ 已停止重试`);
      const dingText = `**STA ${mon.localTaskId}**\n\n**命中 ${m.hitCount} 个好仓**：${m.hits.join("、")}\n\n**全部分配**：${(res.allCodes || []).join("、")}\n\n时间：${new Date().toLocaleString()}`;
      dingtalkSend(`🎯 好仓库达标：命中 ${m.hitCount} 个`, dingText)
        .then(r => dbg("钉钉推送: " + JSON.stringify(r)))
        .catch(e => dbg("钉钉推送异常: " + e.message));
    } else {
      await scheduleRetry();
      notify(`第 ${mon.attempts} 次探测未达标（${m.hitCount} 个好仓）`, `10 分钟后自动重试 ｜ 本次分配：${(res.allCodes || []).join("、") || "无"}`);
    }
  } catch (e) {
    reqLogging = false;
    mon.status = "error";
    mon.lastError = (e && e.message) || "未知错误";
    await setMonitor(mon);
    await saveLog({ ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId, attempt: mon.attempts, error: mon.lastError });
    await scheduleRetry();
    notify("监控出错，10分钟后自动重试", mon.lastError);
  }
}
