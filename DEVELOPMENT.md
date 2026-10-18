# 领星好仓库监控助手 · 开发文档

> 面向后续维护/优化。用户使用文档见 `安装说明.md`，新机器迁移指引见 `HANDOFF.md`。
> 当前版本：**v0.1.0**（阈值默认 3，轮询 10 分钟）

---

## 1. 项目背景

领星 ERP 创建 STA（亚马逊发货计划）后，亚马逊会分配入库仓库（物流中心编码，如 `中部RFD2`、`西部SCK4`）。
用户只关心**好仓库**（成本更优的西部/部分中部仓）分配得够不够多。

**核心诉求**：达标（好仓 ≥ 阈值）就提醒；不达标就按**随机间隔**（默认 10–20 分钟，可在设置里改区间）重新提交装箱，让亚马逊**重新分仓**，直到出好仓。间隔随机化是为了避免固定周期被风控识别。

**铁律（最高优先级）**：**绝不点击「申报货件并提交配送服务」**——那才是真实申报货件。
插件只做到「读取仓库分配」为止，全程只读不提交。

---

## 2. 整体架构

Chrome 扩展（Manifest V3），三个运行环境：

```
┌────────────────────────────────────────────────────────────┐
│ Service Worker (background.js)                              │
│  · 监控状态机（尝试次数/达标判定/是否继续）                 │
│  · chrome.alarms 调度 10 分钟重试                           │
│  · 标签页挑选与导航、内容脚本失效时重新注入                 │
│  · 钉钉 webhook（含加签）                                   │
│  · 设置/日志持久化（chrome.storage.local）                  │
└───────────────┬────────────────────────────────────────────┘
                │ chrome.tabs.sendMessage
                ▼
┌────────────────────────────────────────────────────────────┐
│ Content Script (content.js + config.js)                     │
│  运行在 erp.lingxing.com 页面上下文                          │
│  · 登录态检测 · 按钮定位与点击 · 文件上传                    │
│  · 编码提取（区域切片 + 正则）                               │
│  · 调试日志（环形缓冲 → 随结果返回）                         │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ 侧边栏控制面板 (popup.html + popup.js)                      │
│  · 常驻显示（Chrome Side Panel，页面跳转不消失）            │
│  · 启动/停止监控 · 最近一轮结果 · 轮询历史 · 设置 · 钉钉     │
└────────────────────────────────────────────────────────────┘
```

**为什么用侧边栏而不是 popup**：Chrome 的 popup 在失去焦点（页面激活/跳转）时会被强制关闭，
用户看不到实时日志。Side Panel（`chrome.sidePanel`）常驻浏览器右侧，页面怎么跳都在。

---

## 3. 文件结构

```
extension/
├── manifest.json       # MV3 清单：权限、content_scripts、action、background
├── background.js       # Service Worker：调度 + 状态机 + 钉钉 + 存储
├── content.js          # 页面自动化（注入 erp.lingxing.com）
├── config.js           # 默认值：30 个好仓白名单、阈值 3
├── popup.html / popup.js   # 侧边栏控制面板 UI 与逻辑
├── icon128.png         # 通知图标
└── 安装说明.md          # 用户文档
```

**manifest 关键配置**：

```json
{
  "permissions": ["tabs", "storage", "scripting", "notifications", "webRequest", "alarms", "sidePanel"],
  "host_permissions": ["https://erp.lingxing.com/*", "https://oapi.dingtalk.com/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{ "matches": ["https://erp.lingxing.com/*"], "js": ["config.js", "content.js"] }]
}
```

---

## 4. 数据模型（chrome.storage.local）

| Key | 内容 | 说明 |
|---|---|---|
| `lx_settings` | `{ threshold, maxAttempts, warehouses[], retryMin, retryMax, migrated010 }` | 用户可编辑设置；首次用 `config.js` 播种 |
| `lx_monitor` | `{ active, localTaskId, attempts, status, tabId, lastCodes, lastDetails, lastHits, lastHitCount, lastPass, nextProbeAt, nextDelayMin, retryRange[], history[], log[] }` | 监控运行状态；`nextProbeAt` 供面板显示下次轮询时刻 |
| `lx_logs` | 历史运行记录（最多 200 条） | 供核查 |
| `lx_dingtalk` | `{ webhook, secret }` | 钉钉群机器人配置 |
| `lx_state` | 旧「自动创建STA」流程状态 | 遗留模式 |

**monitor.status 流转**：

```
starting → probing → waiting ─┬─→ success（达标，停止）
                             └─→ waiting → probing（10 分钟后重试）
                             → maxed（达到最大轮询次数，停止）
                             → stopped（用户手动停止）→ error（自动重试）
```

---

## 5. 监控主流程（单次探测）

`background.runProbeCycle(isFirst)` → `content.runProbe(msg)`

```
1. 标签页挑选（background）
   ① 当前激活的领星页且是向导页(SendToAmazon) → 原地探测，不跳转
   ② 其他向导页 → 用那个
   ③ 其他领星页 → 导航到目标 STA
   ④ 都没有 → 新开标签页

2. 发指令前先 PING 内容脚本；无响应 → chrome.scripting.executeScript 重新注入
   （插件刷新后旧页面脚本失效，这是必踩的坑）

3. content.runProbe
   a. 登录检测：页面出现「账号登录」→ 提示登录并轮询等待（最长 10 分钟）
   a2. **拟人停顿**：随机等 3–15 秒再动手；此后每次点按钮前再随机等 1–5 秒
       （`jitter()`，区间取自 `config.js` 的 `jitterMs`，实际停顿写进 trace）
   b. 若页面有「申报货件并提交配送服务」= 第③步 → 先点「上一步」回第②步
      （非首次探测同理；点了上一步后轮询等「提交装箱」出现，最长 10 秒）
   c. 找提交按钮：精确「提交装箱并继续」→ 模糊包含「提交装箱」→ 退而求「创建」
      找不到：把页面可见按钮名写进日志，转手动兜底
   d. 处理确认弹窗（如「自动提交装箱数据」）→ 点可见的「确认」
   e. 等待仓库分配（最长 90 秒，2 秒轮询）
      20 秒仍无编码且页面有「下一步」→ 点它进入第③步（部分任务不会自动跳转）

4. 编码提取 → 返回 { allCodes, details, rawText, elapsedSec, trace }

5. background 判定：命中 ≥ threshold → 钉钉 + 浏览器通知 + 停止
   否则 → 写历史、写日志、**按随机区间（默认 10–20 分钟）排下一次 alarm** 重试
   （`scheduleRetry()` 在设置区间内取随机分钟数，保留 1 位小数不取整；
    同时把 `nextProbeAt` 写进 `lx_monitor`，侧边栏据此显示倒计时）
```

---

## 6. 关键实现细节

### 6.1 领星页面特性（Vue + Element UI）

- 按钮文本匹配要先 `replace(/\s+/g, '')` 再比较（Element UI 会在文字间插空格）
- 合成事件对 Vue 有效：`el.click()` 即可；展开下拉/浮层再点选项
- 店铺控件是自定义下拉（`.ak-seller-select .selected-section`），**选中值在 span 文本里，不在 `input.value`**
- 导入弹窗内的文件框：`.el-dialog .el-upload input[type=file][accept=.xlsx]`（全页常驻唯一一个）
- 上传用 `DataTransfer` 构造 File 再 `dispatchEvent(new Event('change'))`，等价于真实选文件

### 6.2 编码提取（scanCodes）

```js
const full = document.body.innerText.replace(/\s+/g, "");
const idx  = full.indexOf("入库配置选项");
const t    = idx >= 0 ? full.slice(idx) : "";   // ← 只扫配置区
```

**为什么要先切片**：向导页标题「创建STA」＋步骤序号「1」在去除空白后会被拼成 `STA1`，
正则会当作仓库码，导致探测 2 秒“假完成”。必须先切出「入库配置选项」之后的文本。

- 主正则：`/\b[A-Z]{2,4}\d\b/g`（单个尾数字，天然排除 MSKU `CCA072`、ASIN `B0HHHF8LJ`）
- 无数字特殊码 `IUSJ/IUSQ/IUSP` 单独匹配
- 明细带地区标签：`/([\u4e00-\u9fa5]{1,2})([A-Z]{2,4}\d)\b/g` → `中部RFD2`

### 6.3 消息协议

后台 → 页面：

| cmd | 用途 |
|---|---|
| `RUN_PROBE { isFirst }` | 执行一次监控探测 |
| `RUN_FLOW { shopKey, fileB64, fileName }` | 旧模式：自动创建 STA |
| `STOP_PROBE` | 立即中止进行中的探测 |
| `PING` | 检测内容脚本存活 |

页面 → 后台：

| type | 用途 |
|---|---|
| `PROGRESS { step, status, detail }` | 步骤进度（同时起心跳作用，防止 SW 被回收） |
| `DEBUG { line }` | 调试日志 |

侧边栏 → 后台：`START_MONITOR` / `STOP_MONITOR` / `GET_MONITOR` / `GET_SETTINGS` /
`SAVE_SETTINGS` / `SAVE_DING` / `GET_DING` / `DING_TEST` / `GET_LOGS`

### 6.4 钉钉通知

- 群机器人 webhook（不需连接器），加签用 `crypto.subtle` 算 HMAC-SHA256 + base64
- 未配置 webhook 时静默跳过（返回 `{ok:false, reason:'未配置'}`）
- 达标时推送 markdown：命中仓 + 全部分配 + 时间

### 6.5 Service Worker 保活

SW 空闲 30 秒可能被回收。探测最长约 2-3 分钟，靠 **内容脚本在等待循环中持续上报
`PROGRESS` 消息**重置空闲计时器；长等待（10 分钟）由 `chrome.alarms` 驱动而非 SW 常驻。

---

## 7. 已知坑位与修复历史

| 版本 | 问题 | 修复 |
|---|---|---|
| 0.1.1 | 弹窗文件选择框点了没反应 | label 加 `for="file"` 绑定 |
| 0.1.2 | 文件上传报 `sid is not present` | 导入前强制校验店铺已选（sid = 店铺 ID） |
| 0.1.4 | 店铺明明选了却检测不到 | 领星是自定义下拉，值在 span 文本而非 `input.value` |
| 0.2.0 | 暂存不出仓库分配 | 实测确认：暂存只存草稿，必须「创建/提交装箱并继续」才生成配置 |
| 0.4.2 | 探测不生效 | 检测到「申报货件并提交配送服务」在场=第③步，需先点上一步 |
| 0.4.3 | 提交装箱后卡住不出编码 | 部分任务不自动跳转，20 秒后自动点「下一步」 |
| 0.5.0 | 每次监控跳新标签页 | 优先复用当前向导页原地探测 |
| 0.6.0 | 弹窗一闪就消失 | 改用 Chrome Side Panel |
| 0.6.1 | `Receiving end does not exist` | 插件刷新后旧页面脚本失效 → PING + 自动重新注入 |
| 0.6.2 | 提取到假编码 `STA1` | 编码提取只扫「入库配置选项」之后的文本段 |
| 0.1.3 | 固定 10 分钟轮询有风控风险 | 改为随机区间轮询（默认 10–20 分钟，不取整）；设置面板可改区间，两端相等即固定间隔 |
| 0.1.4 | 间隔随机了，但动作节奏仍规整 | 增加动作级拟人随机停顿（探测前 3–15s、点击前 1–5s、弹窗轮询 1.2–2.6s、下一步前 0.8–3s）；面板新增「下次轮询时刻」预告 |
| 0.1.5 | **串台**：随便填一个 localTaskId 也能跑，实际探测的是当前打开页面的货件 | 旧逻辑复用向导页只看「域名 + SendToAmazon」，不看 localTaskId。改为 `isTargetWizard()` 严格比对 ID；发现当前页是别的货件向导页时另开标签页（不劫持用户正在编辑的页）；动手前再加一道硬校验；`startMonitor` 增加位数校验（也支持直接粘贴整条 URL） |
| 0.1.9 | 输入「真ID+杂字符」（如 `231749430119949312x`）仍能启动，尾部 x 被静默丢弃 | 旧逻辑用 `/\d{18,20}/` 从任意文本提取数字串再校验，等于"自动修复"了错误输入。改为严格校验：只接受 ①18–20 位纯数字 ②领星 STA 页面 URL（取 localTaskId=），其余一律拒绝并提示是否含非数字字符 |
| 0.1.8 | 0.1.7 自查发现四处隐患 | ① 三条提前 return 路径（invalidTask/emptyRounds/stopped）漏了 `reqLogging=false`，webRequest 记录仪会一直开着；② 自检正则含「操作失败/加载失败」，正常重摇失败弹 toast 会错停整场监控——已收窄；③ 严格模式用「货件」判定向导页，但领星全局导航就有该词——改为只认向导特有词；④ RUN_PROBE 超时 360s < 手动等待 300s+提取 90s+拟人停顿，最坏会误报超时——提到 600s |
| 0.1.7 | 任务不存在时仍会 10–20 分钟一轮地空转轮询 | 内容脚本增加 `detectInvalidTask()`：页面出现「任务不存在/已删除/无权限」或连一个 STA 按钮都没有时，直接返回 `invalidTask`；后台收到后**只通知、不重试**。另加兜底：连续 2 轮读不到任何仓库编码也停止（避免页面异常时空转） |
| 0.1.6 | 改完仍能跑错任务 / 无法判断「改动是否生效」 | ① 位数收紧到 18–20 位（19 位为准），瞎编的长 ID 直接拒绝；② 探测**结束后**再复检一次页面 localTaskId，被 SPA 重定向就丢弃结果；③ 不匹配时**直接停止监控**而不是无限重试；④ 面板标题显示 `v0.1.6`，并显示「本轮页面任务 vs 监控任务」，串台一眼可见 |

**环境坑（WorkBuddy 侧）**：沙箱会杀进程树、Chrome 自身 sandbox 初始化失败、
`launchctl`/`open -na` 不可靠、agent-browser 的 `connect` 会话会漂移到无头实例
（正确姿势：`close --all` 后每条命令带 `--cdp 9222`）——详见 `browser-takeover` 技能。

---

## 8. 调试方法

1. **侧边栏日志**：最直接的入口，每轮探测摘要 + 完整 trace
2. **页面控制台**：内容脚本日志前缀 `[好仓监控]`
3. **后台日志**：`chrome://extensions` → 插件卡片 → Service Worker 链接 → DevTools
4. **CDP 接管**（助手可用）：用户双击 `启动领星登录浏览器.command` 并登录后，
   助手用 `agent-browser close --all` + `agent-browser --cdp 9222 eval ...` 实时查看页面 DOM
5. **一键导出**：侧边栏「复制结果与调试日志」把 state + 最近日志拷到剪贴板

---

## 9. 后续优化方向

- [ ] **独立钉钉机器人**（企业内部应用，可私聊推送）替代群机器人 webhook
- [ ] **新高提醒**：命中数破纪录就推一条，不必等凑满阈值
- [ ] 编码提取可考虑从**页面内部接口**拿结构化数据（当前靠文本正则）
- [ ] Windows 启动器（.bat 版）未实测
- [ ] 领星前端改版后按钮文本可能变化 → 保持「精确匹配 + 模糊兜底 + 诊断日志」三层策略

---

## 10. 开发约定

- 每次改动**必须**同步版本号（`manifest.json`）并在本节记录
- 涉及页面操作的新逻辑，一律加：精确匹配 → 模糊匹配 → 手动兜底 → 写诊断日志
- 任何点击动作都要先确认不在「铁律」禁止清单内
- 改完跑一次 `node --check *.js` 再提交；提交信息写清「问题 → 修复」
