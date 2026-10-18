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

// 随机轮询区间归一化：至少 1 分钟；非法值回落到默认区间；max < min 时自动交换
function normalizeInterval(s) {
  let min = Number(s && s.retryMin);
  let max = Number(s && s.retryMax);
  const dMin = LX_CONFIG.retryMinMinutes || 10;
  const dMax = LX_CONFIG.retryMaxMinutes || 20;
  if (!isFinite(min) || min < 1) min = dMin;
  if (!isFinite(max) || max < 1) max = dMax;
  if (max < min) { const t = min; min = max; max = t; }
  return { min, max };
}

// 在区间内取随机分钟数（不取整，进一步削弱规律性）
function pickIntervalMinutes(s) {
  const { min, max } = normalizeInterval(s);
  return min + Math.random() * (max - min);
}

async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  if (o[SETTINGS_KEY]) {
    const saved = o[SETTINGS_KEY];
    let dirty = false;
    if (!saved.migrated010) {  // v0.1.0：阈值默认回归 3，只迁移一次
      saved.threshold = 3;
      saved.migrated010 = true;
      dirty = true;
    }
    // v0.1.3：随机轮询区间（默认 10–20 分钟），老配置补默认值
    if (typeof saved.retryMin !== "number" || typeof saved.retryMax !== "number") {
      const n = normalizeInterval({ retryMin: LX_CONFIG.retryMinMinutes, retryMax: LX_CONFIG.retryMaxMinutes });
      saved.retryMin = n.min;
      saved.retryMax = n.max;
      dirty = true;
    }
    if (dirty) await chrome.storage.local.set({ [SETTINGS_KEY]: saved });
    return saved;
  }
  const n = normalizeInterval({ retryMin: LX_CONFIG.retryMinMinutes, retryMax: LX_CONFIG.retryMaxMinutes });
  const def = {
    threshold: LX_CONFIG.threshold, maxAttempts: 100, warehouses: LX_CONFIG.warehouses,
    retryMin: n.min, retryMax: n.max
  };
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

// 图标点击打开侧边栏（控制面板常驻，不随页面跳转消失）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.sidePanel.setOptions({ path: "popup.html" }).catch(() => {});
});

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
function sendToTab(tabId, msg, timeoutMs = 360000) {
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
    // 先探测内容脚本是否存活（插件刷新后旧页面脚本会失效）
    chrome.tabs.sendMessage(tabId, { cmd: "PING" }, pong => {
      if (chrome.runtime.lastError || !pong) {
        // 死了：现场重新注入（config.js + content.js），免去用户刷新页面
        dbg("内容脚本未响应，重新注入…");
        chrome.scripting.executeScript({
          target: { tabId },
          files: ["config.js", "content.js"]
        }).then(() => setTimeout(() => attempt(3), 800))
          .catch(e => { if (!settled) { settled = true; reject(new Error("注入失败: " + e.message)); } });
      } else {
        attempt(0);
      }
    });
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
    const s = Object.assign({}, msg.settings || {});
    const n = normalizeInterval(s);   // 区间非法时自动纠正/交换
    s.retryMin = n.min;
    s.retryMax = n.max;
    s.migrated010 = true;             // 已按新结构保存，避免再次触发默认值迁移
    chrome.storage.local.set({ [SETTINGS_KEY]: s }).then(() => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg.type === "GET_SETTINGS") {
    getSettings().then(s => sendResponse(s));
    return true;
  }
});

// ============ 监控已有 STA（循环重试直到出好仓） ============
// 流程：打开 editSendToAmazon → 点「提交装箱并继续」（或「创建」）→ 确认弹窗 → 读编码
//       好仓 ≥阈值 → 提醒并停止；<阈值 → 随机间隔（默认 10–20 分钟）后
//       「上一步」→ 重新提交装箱，循环
// 铁律：绝不点击「申报货件并提交配送服务」——只读仓库分配，不真实申报

const MON_KEY = "lx_monitor";
const ALARM_NAME = "lx-sta-probe";

// 时间戳 → HH:MM（日志与通知里展示「预计几点触发」）
function hhmm(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function editUrl(id) {
  return `https://erp.lingxing.com/erp/msupply/editSendToAmazon?localTaskId=${id}&regenerateShipment=false&openRestartDialog=false&positionType=1&next=0`;
}

// 从页面 URL 里取 localTaskId
function taskIdFromUrl(u) {
  const m = String(u || "").match(/localTaskId=(\d+)/);
  return m ? m[1] : "";
}

// 这个 URL 是否「目标任务」的 STA 向导页（必须 ID 一致，防止串台到别的货件）
function isTargetWizard(url, id) {
  const u = String(url || "");
  if (!u.includes("erp.lingxing.com") || !u.includes("SendToAmazon")) return false;
  const tid = taskIdFromUrl(u);
  return !!tid && tid === String(id);
}

async function getMonitor() {
  const o = await chrome.storage.local.get(MON_KEY);
  return o[MON_KEY] || null;
}
async function setMonitor(m) {
  await chrome.storage.local.set({ [MON_KEY]: m });
}

async function startMonitor(rawId) {
  const raw = String(rawId || "").trim();
  // 严格校验，只接受两种输入（旧逻辑"从任意文本里提取数字串"会把
  // 「真ID+杂字符」静默修好再启动，掩盖了用户的输入错误）：
  //   ① 18–20 位纯数字 ID
  //   ② 领星 STA 页面 URL（取 localTaskId= 后面的数字）
  if (/^\d{18,20}$/.test(raw)) {
    return beginMonitor(raw);
  }
  const fromUrl = taskIdFromUrl(raw);
  if (fromUrl && /^https?:\/\//.test(raw)) {
    if (fromUrl.length < 18 || fromUrl.length > 20) {
      return { ok: false, error: `URL 里的 localTaskId 位数不对（${fromUrl.length} 位，应为 18–19 位），请核对` };
    }
    return beginMonitor(fromUrl);
  }
  const hint = /[^\d]/.test(raw) ? "（含非数字字符，请检查是否误粘了多余内容）" : "";
  return { ok: false, error: `localTaskId 无效：应为 18–19 位纯数字或领星 STA 页面 URL，当前「${raw.slice(0, 30)}」${hint}` };
}

async function beginMonitor(id) {
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
  if (m) {
    if (m.tabId) {
      try { chrome.tabs.sendMessage(m.tabId, { cmd: "STOP_PROBE" }, () => void chrome.runtime.lastError); } catch (e) {}
    }
    m.active = false; m.status = "stopped";
    await setMonitor(m);
  }
}

chrome.alarms.onAlarm.addListener(al => {
  if (al.name === ALARM_NAME) runProbeCycle(false);
});

// 安排下一次重试：在设置区间内随机取延迟（分钟，保留 1 位小数，最小 1 分钟）
async function scheduleRetry() {
  const s = await getSettings();
  const raw = pickIntervalMinutes(s);
  const delay = Math.max(1, Math.round(raw * 10) / 10);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
  return { delay, min: normalizeInterval(s).min, max: normalizeInterval(s).max };
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
    // 标签页选择：只复用「目标任务」的向导页（URL 里 localTaskId 必须一致，
    // 否则会串台到用户正开着的别的货件——旧逻辑只看域名 + SendToAmazon）
    const target = editUrl(mon.localTaskId);
    let tabId = mon.tabId;
    let tabOk = false;
    if (tabId) {
      try {
        const t = await chrome.tabs.get(tabId);
        tabOk = isTargetWizard(t && t.url, mon.localTaskId);
      } catch (e) { tabOk = false; }
    }
    if (!tabOk) {
      let cand = null, needNav = true, openNew = false;
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const activeUrl = String((active && active.url) || "");
      const activeIsLx = activeUrl.includes("erp.lingxing.com");

      // ① 当前激活的标签页正好是目标 STA → 原地探测
      if (activeIsLx && isTargetWizard(activeUrl, mon.localTaskId)) {
        cand = active; needNav = false;
        dbg("当前标签页就是目标 STA 向导页，原地探测不跳转");
      }

      if (!cand) {
        const lxTabs = await chrome.tabs.query({ url: "https://erp.lingxing.com/*" });
        // ② 任意已打开的目标 STA 向导页
        const hit = lxTabs.find(t => isTargetWizard(t.url, mon.localTaskId));
        if (hit) {
          cand = hit; needNav = false;
          dbg("复用已打开的目标 STA 标签页");
        } else if (activeIsLx && activeUrl.includes("SendToAmazon")) {
          // ③ 当前是「别的货件」的向导页：可能正在编辑，不动它，另开一个标签页
          openNew = true;
          dbg(`当前页是其它货件的向导页（localTaskId=${taskIdFromUrl(activeUrl) || "?"}），另开标签页，不串台`);
        } else if (activeIsLx) {
          // ④ 当前是领星其它页面（列表页等）：直接导航过去
          cand = active;
        } else if (lxTabs.length) {
          cand = lxTabs[0];
        }
      }

      let created = false;
      if (openNew || !cand) {
        if (!cand) dbg("未找到领星标签页，新开一个");
        cand = await chrome.tabs.create({ url: target, active: true });
        needNav = false;
        created = true;
      }
      tabId = cand.id;
      if (needNav) {
        dbg("导航当前标签页到目标 STA");
        await chrome.tabs.update(tabId, { url: target, active: true });
        await waitTabComplete(tabId);
        await new Promise(r => setTimeout(r, 3000));
      } else if (created) {
        // 新开的标签页要等页面加载完再发指令（否则注入的脚本会被导航清掉）
        await waitTabComplete(tabId);
        await new Promise(r => setTimeout(r, 3000));
      }
      mon.tabId = tabId;
      await setMonitor(mon);
    }

    // 硬校验：动手前再确认一次页面确实属于目标任务
    // （宁可报错，也不要把别的货件的分仓结果记到当前任务头上）
    let probedUrl = "";
    try {
      const t = await chrome.tabs.get(tabId);
      probedUrl = (t && t.url) || "";
      const tid = taskIdFromUrl(probedUrl);
      mon.probedUrl = probedUrl;
      mon.probedTaskId = tid;
      if (!tid) {
        // 取不到 ID：多半是登录页/中转页，交给内容脚本自检（登录过期会等重登）
        dbg("当前页 URL 未带 localTaskId，交给页面自检：" + String(probedUrl).slice(0, 80));
      } else if (tid !== String(mon.localTaskId)) {
        throw new Error(`页面任务不匹配：当前页 localTaskId=${tid}，监控目标 ${mon.localTaskId}`);
      }
    } catch (e) {
      if (/任务不匹配/.test(e.message)) throw e;   // 校验失败要中断
      /* 取不到标签页信息则交给后续流程报错 */
    }
    await setMonitor(mon);

    // 超时给足 600s：最坏情况 = 拟人停顿 + 手动兜底等待(300s) + 提取编码(90s)，
    // 默认 360s 会在内容脚本还在干活时就误报超时
    const res = await sendToTab(tabId, { cmd: "RUN_PROBE", isFirst: !!isFirst }, 600000);
    reqLogging = false;

    // 复检：探测过程中页面可能被 SPA 重定向（领星遇到无效 ID 会跳走），
    // 此时结果不属于目标任务，必须丢弃，绝不记账
    try {
      const t2 = await chrome.tabs.get(tabId);
      const tid2 = taskIdFromUrl(t2 && t2.url);
      if (tid2 && tid2 !== String(mon.localTaskId)) {
        throw new Error(`页面任务不匹配：探测后页面跳到 localTaskId=${tid2}（目标 ${mon.localTaskId}），本轮结果已丢弃`);
      }
    } catch (e) {
      if (/任务不匹配/.test(e.message)) throw e;
    }

    if (!res) throw new Error("页面无响应");
    // 任务不存在/无权限/页面不对：只提醒，不重试、不轮询
    if (res.invalidTask) {
      reqLogging = false;
      mon.active = false;
      mon.status = "error";
      mon.lastError = res.error || "任务不可用";
      mon.nextProbeAt = 0;
      mon.nextDelayMin = 0;
      chrome.alarms.clear(ALARM_NAME);
      await setMonitor(mon);
      await saveLog({ ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId, attempt: mon.attempts, error: mon.lastError });
      notify("⛔ 监控未启动：任务不可用", `${mon.lastError} ｜ STA ${mon.localTaskId} ｜ 请核对后重新开始`);
      return;
    }
    if (res.error) throw new Error(res.error);
    if (res.stopped) {
      reqLogging = false;
      mon.active = false; mon.status = "stopped";
      await setMonitor(mon);
      return;
    }

    const m = await matchCodes(res.allCodes || []);
    const empty = !(res.allCodes && res.allCodes.length);
    mon.emptyRounds = empty ? (mon.emptyRounds || 0) + 1 : 0;
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

    // 连续两轮一个编码都没读到 = 页面/任务本身有问题（不是"分仓不好"），
    // 直接停掉，别再 10–20 分钟一轮地空转
    if (!m.pass && mon.emptyRounds >= 2) {
      reqLogging = false;
      mon.active = false;
      mon.status = "error";
      mon.lastError = `连续 ${mon.emptyRounds} 轮未读到任何仓库分配（任务可能不存在/页面异常/需人工处理）`;
      mon.nextProbeAt = 0;
      mon.nextDelayMin = 0;
      chrome.alarms.clear(ALARM_NAME);
      await setMonitor(mon);
      await saveLog({ ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId, attempt: mon.attempts, error: mon.lastError });
      notify("⛔ 监控已停止：读不到仓库分配", `${mon.lastError} ｜ STA ${mon.localTaskId}`);
      return;
    }

    // 未达标：先按随机区间排好下一轮，好把真实间隔写进本轮日志
    let next = null;
    if (!m.pass) {
      next = await scheduleRetry();
      mon.nextDelayMin = next.delay;
      mon.nextProbeAt = Date.now() + next.delay * 60000;
      mon.retryRange = [next.min, next.max];
    } else {
      mon.nextDelayMin = 0;
      mon.nextProbeAt = 0;
    }

    // 详细日志：本轮探测的完整轨迹 + 判定摘要
    const det = (res.details || []).map(d => (d.region || "") + d.code).join("、");
    const summary = [
      `━━━ 探测 #${mon.attempts} ━━━ ${new Date().toLocaleString()}`,
      `页面: localTaskId=${taskIdFromUrl(mon.probedUrl) || "?"}`,
      `动作: ${isFirst ? "首次提交" : "上一步→重新提交"}（耗时 ${res.elapsedSec || "?"}s）`,
      `分配: ${det || (res.allCodes || []).join("、") || "无"}（共 ${(res.allCodes || []).length} 个）`,
      `命中: ${m.hitCount} 个好仓${m.hits.length ? "（" + m.hits.join("、") + "）" : ""} → ${m.pass ? "✅ 达标，停止重试" : "❌ 未达标"}`,
      m.pass ? "" : `下次: 约 ${next.delay} 分钟后（${hhmm(mon.nextProbeAt)}）重试（${next.min}–${next.max} 分钟随机）`
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
      notify(`第 ${mon.attempts} 次探测未达标（${m.hitCount} 个好仓）`,
        `预计 ${hhmm(mon.nextProbeAt)}（约 ${next.delay} 分钟后）重试 ｜ 本次分配：${(res.allCodes || []).join("、") || "无"}`);
    }
  } catch (e) {
    reqLogging = false;
    mon.status = "error";
    mon.lastError = (e && e.message) || "未知错误";

    // 任务不匹配属于配置错误：重试也只会继续操作错页面 → 直接停掉
    if (/任务不匹配/.test(mon.lastError)) {
      mon.active = false;
      mon.nextProbeAt = 0;
      mon.nextDelayMin = 0;
      chrome.alarms.clear(ALARM_NAME);
      await setMonitor(mon);
      await saveLog({ ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId, attempt: mon.attempts, error: mon.lastError });
      notify("⛔ 监控已停止：任务 ID 不匹配", mon.lastError + " ｜ 请核对 localTaskId 后重新开始");
      return;
    }

    const next = await scheduleRetry();
    mon.nextDelayMin = next.delay;
    mon.nextProbeAt = Date.now() + next.delay * 60000;
    mon.retryRange = [next.min, next.max];
    await setMonitor(mon);
    await saveLog({ ts: Date.now(), kind: "monitor", localTaskId: mon.localTaskId, attempt: mon.attempts, error: mon.lastError });
    notify("监控出错，预计 " + hhmm(mon.nextProbeAt) + " 自动重试", mon.lastError);
  }
}
