// 内容脚本：在领星页面上执行界面自动化（选店铺→导入商品→创建→抓取编码）
// 设计原则：每一步先尝试全自动，失败则降级为「页面浮动条提示用户手动操作」，检测到完成自动继续
(() => {
  if (window.__LX_STA_HELPER__) return;
  window.__LX_STA_HELPER__ = true;

  const CFG = window.LX_CONFIG || {
    warehouses: [], threshold: 3,
    extraCodePattern: "\\b[A-Z]{4}\\b",
    staUrl: "https://erp.lingxing.com/erp/msupply/AddSendToAmazon"
  };

  let running = false;
  let stopRequested = false;
  let userAction = null; // {type:'ok'|'create'|'stop'} 由浮动条按钮设置

  function report(step, status, detail) {
    try { chrome.runtime.sendMessage({ type: "PROGRESS", step, status, detail }); } catch (e) {}
  }
  // 调试日志环形缓冲：每次探测把完整 trace 返回给后台，写入监控日志
  const dbgRing = [];
  function dbg(line) {
    dbgRing.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (dbgRing.length > 300) dbgRing.shift();
    console.log("[好仓监控]", line);
    try { chrome.runtime.sendMessage({ type: "DEBUG", line }); } catch (e) {}
  }

  // ---------- 页面浮动条 ----------
  let bar = null, barText = null, barBtns = null;
  function ensureBar() {
    if (bar && document.body.contains(bar)) return;
    bar = document.createElement("div");
    bar.id = "__lx_sta_bar__";
    bar.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1f2937;color:#fff;"
      + "padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;max-width:340px;"
      + "box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";
    barText = document.createElement("div");
    barBtns = document.createElement("div");
    barBtns.style.cssText = "margin-top:6px;display:none;gap:8px;";
    bar.appendChild(barText); bar.appendChild(barBtns);
    document.documentElement.appendChild(bar);
  }
  function setBar(text, showStop = true) {
    ensureBar();
    barText.textContent = "【好仓监控】" + text;
    barBtns.innerHTML = "";
    barBtns.style.display = showStop ? "flex" : "none";
    if (showStop) {
      const stop = document.createElement("button");
      stop.textContent = "停止";
      stop.style.cssText = "flex:1;background:#ef4444;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;";
      stop.onclick = () => { userAction = { type: "stop" }; };
      barBtns.appendChild(stop);
    }
  }
  function setBarWithButtons(text, buttons) {
    ensureBar();
    barText.textContent = "【好仓监控】" + text;
    barBtns.innerHTML = "";
    barBtns.style.display = "flex";
    buttons.forEach(b => {
      const el = document.createElement("button");
      el.textContent = b.label;
      el.style.cssText = "flex:1;background:" + (b.color || "#2563eb") + ";color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;";
      el.onclick = () => { userAction = { type: b.type }; barBtns.style.display = "none"; };
      barBtns.appendChild(el);
    });
  }
  function removeBar() { if (bar) bar.remove(); bar = null; }

  // ---------- 工具函数 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitUserAction(timeoutMs) {
    const t0 = Date.now();
    while (!userAction && Date.now() - t0 < timeoutMs) await sleep(500);
    const a = userAction; userAction = null;
    return a || { type: "timeout" };
  }

  function visibleText(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  // 在全页面找包含指定文本的可点击元素（按钮/链接/span）
  function findClickable(texts, root = document) {
    const sel = "button, a, .ant-btn, [role=button], span, div";
    const els = root.querySelectorAll(sel);
    for (const el of els) {
      if (!visibleText(el)) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 20) continue;
      for (const want of texts) {
        if (t === want || (t.includes(want) && t.length <= want.length + 4)) {
          // 取最内层可点击元素
          let target = el;
          while (target.children.length === 1 && target.children[0].tagName === "SPAN") target = target.children[0];
          return target;
        }
      }
    }
    return null;
  }

  // 轮询等待某文本出现在页面上
  async function waitForText(pattern, timeoutMs, pollMs = 800) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (stopRequested) return { found: false, stopped: true };
      if (userAction && userAction.type === "stop") { userAction = null; return { found: false, stopped: true }; }
      const m = (document.body.innerText || "").match(re);
      if (m) return { found: true };
      await sleep(pollMs);
    }
    return { found: false };
  }

  function b64ToUint8(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // ---------- 第1步：选择店铺（带校验：没真正选上绝不放行） ----------
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // 找「店铺」label 元素（精确定位：文本就是「店铺」或「店铺*」）
  function findShopLabel() {
    return [...document.querySelectorAll("label, span, div, dt")].find(el => {
      if (!visibleText(el)) return false;
      const t = (el.textContent || "").trim();
      return /^店铺\*?$/.test(t);
    });
  }

  // 找「店铺」输入框：按 placeholder 或相邻 label 文本定位
  function findShopInput() {
    const inputs = [...document.querySelectorAll("input")].filter(visibleText);
    for (const inp of inputs) {
      if (/店铺/.test(inp.placeholder || "")) return inp;
      let p = inp.closest(".ant-form-item, .el-form-item, [class*=form-item], .ant-row, .el-row, div");
      for (let i = 0; i < 4 && p; i++) {
        const lab = p.querySelector("label, .ant-form-item-label, [class*=label], [class*=label]");
        if (lab && /店铺/.test(lab.textContent || "")) return inp;
        p = p.parentElement;
      }
    }
    // 兜底：店铺 label 同行的 input
    const lab = findShopLabel();
    if (lab) {
      let row = lab.parentElement;
      for (let i = 0; i < 4 && row; i++) {
        const inp = row.querySelector("input");
        if (inp && visibleText(inp)) return inp;
        row = row.parentElement;
      }
    }
    return null;
  }

  // 店铺控件区域（自定义下拉组件，值显示在 span/div 里而非 input）
  function findShopControl() {
    const lab = findShopLabel();
    if (!lab) return null;
    let row = lab.parentElement;
    for (let i = 0; i < 5 && row; i++) {
      const t = (row.textContent || "").replace(/\s+/g, "");
      if (t.includes("店铺") && t.length > 3 && t.length < 150) {
        const ctrl = row.querySelector("[class*=select], [class*=picker], [class*=cascader], [class*=combobox], [class*=dropdown]");
        if (ctrl && visibleText(ctrl)) return ctrl;
      }
      row = row.parentElement;
    }
    return null;
  }

  // 读取店铺当前选中值：先读 input.value，读不到再解析控件显示文本
  function shopSelectedValue(shopRe) {
    const inp = findShopInput();
    if (inp && (inp.value || "").trim()) return inp.value.trim();
    // 文本路径：在店铺 label 所在行找匹配的显示文本
    const lab = findShopLabel();
    if (!lab) return null;
    let row = lab.parentElement;
    for (let i = 0; i < 5 && row; i++) {
      const rowText = (row.textContent || "").replace(/\s+/g, "");
      if (rowText.length > 3 && rowText.length < 200 && rowText.includes("店铺")) {
        const cands = [...row.querySelectorAll("span, div, em, b, p")]
          .map(e => (e.textContent || "").trim())
          .filter(t => t && t.length >= 2 && t.length <= 40 && !/^店铺\*?$/.test(t) && !/^(名称|备注|分仓方式|发货地址|自动)/.test(t));
        if (shopRe) {
          const hit = cands.find(t => shopRe.test(t));
          if (hit) return hit;
        } else if (cands.length) {
          return cands.sort((a, b) => b.length - a.length)[0];
        }
      }
      row = row.parentElement;
    }
    return null;
  }

  // 在全页面浮层里找匹配 shopKey 的下拉选项并点击
  function pickAnyDropdownItem(shopRe) {
    const els = document.querySelectorAll("li, span, div, p, td, [class*=option], [class*=item]");
    for (const el of els) {
      if (!visibleText(el)) continue;
      if (el.querySelector("input")) continue;          // 跳过容器
      const t = (el.textContent || "").trim();
      if (!t || t.length > 40) continue;                 // 选项文本不会太长
      if (!shopRe.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      // 点击最内层匹配节点
      let target = el;
      while (target.children.length === 1) target = target.children[0];
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.click();
      return t;
    }
    return null;
  }

  // 原生 <select> 下拉：直接找含目标店铺的 option
  function findShopSelect(shopRe) {
    for (const s of document.querySelectorAll("select")) {
      for (const o of s.options) {
        if (shopRe.test(o.text || "")) return { select: s, option: o };
      }
    }
    return null;
  }

  // 自动选店铺失败时收集控件信息（随调试日志带回，用于精准修复）
  function collectShopDiag() {
    dbg("---- 店铺控件诊断开始 ----");
    let n = 0;
    document.querySelectorAll("input").forEach(inp => {
      if (n > 12) return;
      const r = inp.getBoundingClientRect();
      if (r.width === 0) return;
      n++;
      dbg(`DIAG input type=${inp.type} ph="${(inp.placeholder || "").slice(0, 20)}" class="${(inp.className || "").slice(0, 60)}" value="${(inp.value || "").slice(0, 30)}"`);
    });
    document.querySelectorAll("select").forEach((s, i) => {
      if (i > 6) return;
      const opts = [...s.options].slice(0, 5).map(o => o.text).join("|");
      dbg(`DIAG select#${i} 选项数=${s.options.length} [${opts}]`);
    });
    dbg("---- 店铺控件诊断结束 ----");
  }

  async function selectShop(shopKey) {
    report("选择店铺", "doing", shopKey);
    const shopRe = new RegExp(escapeRe(shopKey), "i");

    // 已选中则直接放行（含自定义组件显示文本检测）
    const cur = shopSelectedValue(shopRe);
    if (cur && shopRe.test(cur)) {
      report("选择店铺", "ok", "已选中：" + cur);
      return true;
    }

    // 方式1：原生 <select> 下拉
    const ns = findShopSelect(shopRe);
    if (ns) {
      dbg("命中原生 select 下拉");
      ns.select.value = ns.option.value;
      ns.select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1200);
      report("选择店铺", "ok", "自动选中（原生下拉）：" + ns.option.text);
      return true;
    }

    // 方式1.5：点击型自定义下拉（无输入框，值显示在组件文本里）——点击展开再选项
    const ctrl = findShopControl();
    if (ctrl) {
      dbg("找到店铺自定义下拉控件，点击展开");
      try {
        ctrl.scrollIntoView({ block: "center" });
        ctrl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        ctrl.click();
        let picked = null;
        for (let t = 0; t < 5 && !picked; t++) {
          await sleep(1000);
          picked = pickAnyDropdownItem(shopRe);
        }
        dbg("自定义下拉匹配: " + (picked || "未命中"));
        if (picked) {
          await sleep(1200);
          report("选择店铺", "ok", "自动选中（自定义下拉）：" + picked);
          return true;
        }
        pressEscape();
      } catch (e) { dbg("自定义下拉选择异常: " + e.message); }
    }

    // 方式2：搜索型输入框 → 点开 → 输入关键字 → 轮询点击下拉选项
    const inp = findShopInput();
    if (inp) {
      dbg("找到店铺输入框，尝试自动搜索选择");
      try {
        inp.scrollIntoView({ block: "center" });
        inp.focus();
        inp.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        inp.click();
        await sleep(800);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, "");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(400);
        setter.call(inp, shopKey);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        // 轮询等下拉选项出现并点击（最长约6秒）
        let picked = null;
        for (let t = 0; t < 6 && !picked; t++) {
          await sleep(1000);
          picked = pickAnyDropdownItem(shopRe);
        }
        dbg("下拉匹配结果: " + (picked || "未命中"));
        if (!picked) {
          // 试回车触发搜索/选中
          inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
          await sleep(1200);
          picked = pickAnyDropdownItem(shopRe);
          dbg("回车后匹配: " + (picked || "仍未命中"));
        }
        if (picked) {
          await sleep(1200);
          report("选择店铺", "ok", "自动选中：" + picked);
          return true;
        }
        const v = shopSelectedValue(shopRe);
        if (v && shopRe.test(v)) {
          report("选择店铺", "ok", "自动选中：" + v);
          return true;
        }
        pressEscape();
      } catch (e) { dbg("自动选店铺异常: " + e.message); }
    } else {
      dbg("未定位到店铺输入框");
    }

    // 自动失败：收集诊断信息后转手动兜底
    collectShopDiag();
    setBar(`请在页面选择店铺「${shopKey}」（自动选择未成功），选好后我自动检测`, true);
    report("选择店铺", "user", "等待手动选择店铺（自动检测输入框）");
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      if (stopRequested) return { stopped: true };
      if (userAction && userAction.type === "stop") { userAction = null; return { stopped: true }; }
      const v = shopSelectedValue(shopRe);
      if (v && shopRe.test(v)) {
        setBar("店铺已选：" + v, false);
        report("选择店铺", "ok", "检测到已选：" + v);
        await sleep(600);
        return true;
      }
      await sleep(1000);
    }
    return { stopped: true };
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
  }

  // ---------- 第2步：导入商品（导入前强制校验店铺已选） ----------
  async function importProducts(fileB64, fileName, shopKey) {
    // 前置校验：店铺没选好绝不开导入（否则上传请求缺 sid 会报错）
    const re = new RegExp(escapeRe(shopKey), "i");
    let v = shopSelectedValue(re);
    if (!v || !re.test(v)) {
      report("导入商品", "warn", "店铺未选好，先回到选店铺环节");
      const r = await selectShop(shopKey);
      if (r && r.stopped) return { stopped: true };
      v = shopSelectedValue(re);
      if (!v || !re.test(v)) {
        setBar("店铺仍未选好，流程停止。请重跑并先完成店铺选择", false);
        return { stopped: true };
      }
    }
    dbg("导入前校验通过，店铺=" + v);
    report("导入商品", "doing", fileName);
    const before = document.body.innerText.length;
    let btn = findClickable(["导入商品", "导入"]);
    if (!btn) { await sleep(2000); btn = findClickable(["导入商品", "导入"]); }
    if (!btn) {
      setBarWithButtons("未找到「导入商品」按钮，请手动点击导入商品并选择文件，完成后自动继续",
        [{ label: "我已导入完成", type: "ok", color: "#16a34a" }]);
      report("导入商品", "user", "等待手动导入");
      const a1 = await waitUserAction(300000);
      if (a1.type === "stop") return { stopped: true };
      return { manual: true };
    }
    btn.click();
    dbg("已点击导入商品按钮");
    await sleep(1200);

    // 找到「导入商品」对话框容器——只在它内部找上传框，避免误触页面其他上传控件
    let dlg = null;
    let fileInput = null;
    for (let round = 0; round < 3 && !fileInput; round++) {
      await sleep(1200);
      dlg = findImportDialog();
      if (dlg) {
        fileInput = dlg.querySelector('input[type=file]');
        if (!fileInput) {
          // 对话框内没有 input，点一下「导入文件」按钮激活
          const upBtn = [...dlg.querySelectorAll("button, a, span, div")].find(el => {
            const t = (el.textContent || "").trim();
            return visibleText(el) && /^导入文件$/.test(t);
          });
          if (upBtn) { upBtn.click(); dbg("已点击对话框内「导入文件」按钮"); }
          await sleep(1500);
          fileInput = dlg.querySelector('input[type=file]');
        }
        dbg(`对话框内 input[type=file]: ${fileInput ? "找到" : "无"}`);
      } else {
        dbg("未定位到导入商品对话框容器");
      }
    }
    if (fileInput) {
      setBar("正在自动填入文件 " + fileName + " …", false);
      try {
        const bytes = b64ToUint8(fileB64);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        dbg("已通过 DataTransfer 填入文件");
      } catch (e) {
        dbg("DataTransfer 填文件失败: " + e.message);
        // 降级：高亮输入框让用户手动选
        fileInput.style.outline = "3px solid #f59e0b";
        setBarWithButtons("自动填入失败，请点击页面中高亮的文件框手动选择 " + fileName,
          [{ label: "我已选好文件", type: "ok", color: "#16a34a" }]);
        report("导入商品", "user", "等待手动选择文件");
        const a2 = await waitUserAction(300000);
        if (a2.type === "stop") return { stopped: true };
      }
    } else {
      // 找不到对话框内的上传框：不再借用页面其他 input（上次 sid 报错的教训），直接转手动
      setBarWithButtons("未在导入弹窗内找到上传控件，请手动点「导入文件」选择 " + fileName + "，完成后自动继续",
        [{ label: "我已选择文件", type: "ok", color: "#16a34a" }]);
      report("导入商品", "user", "等待手动选择文件");
      const a3 = await waitUserAction(300000);
      if (a3.type === "stop") return { stopped: true };
    }

    // 点击确认按钮（确定/上传/导入/下一步），直到对话框关闭
    for (let i = 0; i < 3; i++) {
      await sleep(1200);
      const confirmBtn = findClickable(["确定", "上 传", "上传", "导 入", "导入", "下一步", "确认"]);
      if (confirmBtn) { confirmBtn.click(); dbg("点击确认按钮 x" + (i + 1)); await sleep(1500); }
      // 对话框关闭（或页面出现成功提示）则跳出
      const txt = document.body.innerText || "";
      if (/导入成功|成功导入|解析成功/.test(txt)) { dbg("检测到导入成功提示"); break; }
    }
    // 等待商品列表出现（页面文本量明显增长作为信号）
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if ((document.body.innerText || "").length > before + 100) break;
      await sleep(1000);
    }
    report("导入商品", "ok", "导入流程已执行");
    return true;
  }

  // 定位「导入商品」对话框容器
  function findImportDialog() {
    const modals = document.querySelectorAll(".ant-modal, [class*=modal], [class*=dialog], [class*=popup], [class*=drawer]");
    for (const m of modals) {
      if (!visibleText(m)) continue;
      const t = m.textContent || "";
      if (/导入文件|下载导入模板/.test(t) && t.length < 5000) return m;
    }
    return null;
  }


  // ---------- 第3步：创建（生成入库配置） ----------
  // 实测流程：点「创建」→ 可能弹「自动提交装箱数据」确认框 → 点「确认」→ 进入步骤③显示入库配置
  // 注意：只到这一步为止，绝不点击「申报货件并提交配送服务」（那才是真正发货）
  async function createSta() {
    report("创建STA", "doing", "点击「创建」生成入库配置");
    const b = [...document.querySelectorAll("button")].find(x =>
      (x.textContent || "").trim() === "创建" && x.getBoundingClientRect().width > 0);
    if (b) {
      b.click();
      dbg("已点击创建");
    } else {
      setBarWithButtons("未找到「创建」按钮，请手动点击后自动继续",
        [{ label: "我已点击", type: "ok", color: "#16a34a" }]);
      report("创建STA", "user", "等待手动点击创建");
      const a0 = await waitUserAction(180000);
      if (a0.type === "stop") return { stopped: true };
    }
    // 处理中间确认弹窗（如「自动提交装箱数据」），最长约20秒
    for (let t = 0; t < 12; t++) {
      await sleep(1600);
      if (stopRequested) return { stopped: true };
      if (/入库配置选项/.test(document.body.innerText || "")) break;
      const confirmBtn = [...document.querySelectorAll("button")].find(x =>
        (x.textContent || "").trim() === "确认" && x.getBoundingClientRect().width > 0);
      if (confirmBtn) {
        confirmBtn.click();
        dbg("已点击中间确认弹窗（自动提交装箱数据）");
        report("创建STA", "ok", "已确认装箱弹窗，等待亚马逊返回仓库分配…");
        break;
      }
    }
    return true;
  }

  // ---------- 第4步：提取物流中心编码（步骤③页面） ----------
  // 实测：编码以「中部RFD2」「东部MEM1」等形式出现在页面文本中
  function scanCodes() {
    const t = (document.body.innerText || "").replace(/\s+/g, "");
    const set = new Set();
    (t.match(/\b[A-Z]{2,4}\d\b/g) || []).forEach(c => set.add(c));
    // 白名单中无数字的特殊码（IUSJ/IUSQ/IUSP）
    ["IUSJ", "IUSQ", "IUSP"].forEach(c => { if (t.includes(c)) set.add(c); });
    // 带地区标签的明细
    const details = [];
    const re = /([\u4e00-\u9fa5]{1,2})([A-Z]{2,4}\d)\b/g;
    let m; const seen = new Set();
    while ((m = re.exec(t)) !== null) {
      if (seen.has(m[2])) continue;
      seen.add(m[2]);
      details.push({ region: m[1], code: m[2] });
    }
    return { codes: [...set], details };
  }

  async function extractCodes() {
    report("提取物流中心编码", "doing", "等待亚马逊返回仓库分配（最长90秒）…");
    let codes = [], details = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      if (stopRequested) return { stopped: true };
      const r = scanCodes();
      if (r.codes.length) { codes = r.codes; details = r.details; break; }
      await sleep(2000);
    }
    if (!codes.length) {
      setBarWithButtons("未自动提取到仓库编码，若结果已显示请点重试",
        [{ label: "重试提取", type: "ok", color: "#2563eb" }]);
      report("提取物流中心编码", "user", "等待手动确认后重试");
      const a = await waitUserAction(120000);
      if (a.type === "stop") return { stopped: true };
      const r = scanCodes();
      codes = r.codes; details = r.details;
    }
    dbg("提取到编码: " + codes.join(",") + " 明细:" + JSON.stringify(details));
    return { allCodes: codes, details, rawText: (document.body.innerText || "").slice(0, 6000) };
  }

  // ---------- 主流程 ----------
  async function runFlow(msg) {
    if (running) return { error: "已有任务在运行" };
    running = true; stopRequested = false; userAction = null;
    const { shopKey, fileB64, fileName } = msg;
    try {
      setBar("开始执行：选择店铺 " + shopKey, true);

      const s1 = await selectShop(shopKey);
      if (s1 && s1.stopped) return finish("选择店铺");

      const s2 = await importProducts(fileB64, fileName, shopKey);
      if (s2 && s2.stopped) return finish("导入商品");

      const s3 = await createSta();
      if (s3 && s3.stopped) return finish("创建STA");

      const s4 = await extractCodes();
      if (s4 && s4.stopped) return finish("提取结果");

      setBar("完成！结果见插件弹窗", false);
      setTimeout(removeBar, 8000);
      return { allCodes: s4.allCodes, rawText: s4.rawText };
    } catch (e) {
      dbg("FLOW ERROR: " + (e && e.message));
      setBar("出错：" + (e && e.message), false);
      return { error: (e && e.message) || "未知错误" };
    } finally {
      running = false;
    }

    function finish(step) {
      setBar("已停止（" + step + "）", false);
      setTimeout(removeBar, 5000);
      return { stoppedAt: step, allCodes: [], rawText: "" };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.cmd === "RUN_FLOW") {
      runFlow(msg).then(sendResponse);
      return true;
    }
    if (msg.cmd === "RUN_PROBE") {
      runProbe(msg).then(sendResponse);
      return true;
    }
    if (msg.cmd === "PING") { sendResponse({ pong: true }); return true; }
  });

  // ============ 监控模式：单次探测 ============
  // 铁律：只允许点击「上一步」「提交装箱并继续」「创建」「确认」，
  //       绝不点击「申报货件并提交配送服务」（那才会真实申报货件）
  async function runProbe(msg) {
    if (running) return { error: "已有任务在运行" };
    running = true; stopRequested = false; userAction = null;
    const traceStart = dbgRing.length;
    const t0 = Date.now();
    try {
      setBar(`监控探测中（${msg.isFirst ? "首次提交" : "重试"}）…`, true);
      dbg(`── 探测开始（${msg.isFirst ? "首次提交" : "重试"}）`);

      // 非首次：先点「上一步」回到装箱步骤
      if (!msg.isFirst) {
        const back = [...document.querySelectorAll("button")].find(b =>
          (b.textContent || "").replace(/\s/g, "") === "上一步" && b.getBoundingClientRect().width > 0);
        if (back) {
          back.click();
          dbg("已点击上一步");
          report("返回装箱步骤", "ok", "已点上一步");
          await sleep(3000);
        } else {
          dbg("未找到「上一步」（可能已在装箱步骤）");
        }
      }

      // 找提交按钮：优先「提交装箱并继续」，退而求「创建」
      let btn = [...document.querySelectorAll("button")].find(b =>
        (b.textContent || "").replace(/\s/g, "") === "提交装箱并继续" && b.getBoundingClientRect().width > 0);
      let used = "提交装箱并继续";
      if (!btn) {
        btn = [...document.querySelectorAll("button")].find(b =>
          (b.textContent || "").trim() === "创建" && b.getBoundingClientRect().width > 0);
        used = "创建";
      }
      if (btn) {
        btn.click();
        dbg("已点击 " + used);
        report("提交装箱", "doing", "已点击「" + used + "」");
      } else {
        dbg("未找到提交按钮，转手动");
        setBarWithButtons("未找到「提交装箱并继续」按钮，请手动点击后自动继续",
          [{ label: "我已点击", type: "ok", color: "#16a34a" }]);
        report("提交装箱", "user", "等待手动点击");
        const a = await waitUserAction(300000);
        if (a.type === "stop") return { stopped: true };
      }

      // 处理中间确认弹窗（自动提交装箱数据等）
      for (let t = 0; t < 12; t++) {
        await sleep(1600);
        if (/入库配置选项/.test(document.body.innerText || "")) break;
        const confirmBtn = [...document.querySelectorAll("button")].find(x =>
          (x.textContent || "").trim() === "确认" && x.getBoundingClientRect().width > 0);
        if (confirmBtn) {
          confirmBtn.click();
          dbg("已点确认弹窗（自动提交装箱数据）");
          report("提交装箱", "ok", "已确认弹窗，等待仓库分配…");
          break;
        }
      }

      // 等待并提取仓库编码
      const r = await extractCodes();
      r.elapsedSec = Math.round((Date.now() - t0) / 1000);
      r.trace = dbgRing.slice(traceStart);
      dbg(`── 探测完成，编码: ${(r.allCodes || []).join(",") || "无"}，耗时 ${r.elapsedSec}s`);
      setBar(`本次探测完成：${(r.allCodes || []).join("、") || "未提取到编码"}`, false);
      setTimeout(removeBar, 10000);
      return r;
    } catch (e) {
      dbg("PROBE ERROR: " + (e && e.message));
      return { error: (e && e.message) || "未知错误", trace: dbgRing.slice(traceStart) };
    } finally {
      running = false;
    }
  }
})();
