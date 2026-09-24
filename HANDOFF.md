# HANDOFF — 新电脑继续开发指引

> 给新机器上的 WorkBuddy / 开发者：先读完本文档再动手，所有决策背景都在里面。

## 项目是什么

「领星好仓库监控」：监控领星 ERP 创建 STA 后亚马逊分配的入库仓库（物流中心编码），
命中好仓白名单 ≥ 阈值（当前 5）即提醒（钉钉群机器人 + 浏览器通知）；
未达标则每 10 分钟「上一步 → 重新提交装箱」重摇分仓，直到达标。

**铁律：整个流程绝不点击「申报货件并提交配送服务」**——那才会真实申报货件。
监控只做到读取仓库分配为止。

## 目录结构

```
sta-monitor/
├── extension/          # Chrome 扩展（v0.4.0，核心交付物）
│   ├── manifest.json   # MV3
│   ├── background.js   # 调度：监控状态机/alarms 10分钟重试/钉钉webhook/设置存储
│   ├── content.js      # 页面自动化：选店铺/导入/提交装箱/提取编码（Element UI 适配）
│   ├── popup.html/js   # 弹窗 UI：监控面板/设置/历史/钉钉配置
│   ├── config.js       # 白名单与阈值默认值（实际设置以 chrome.storage 为准）
│   └── icon128.png
├── config/
│   └── dingtalk.json   # 钉钉 webhook 配置（本机 plugin 用 chrome.storage，此文件给脚本用）
├── scripts/
│   └── dingtalk-notify.py  # 独立钉钉通知脚本（加签），CDP 模式用
├── 启动领星登录浏览器.command  # macOS 启动器：独立 profile + CDP 9222
├── 安装说明.md          # 用户视角的安装使用文档
└── HANDOFF.md          # 本文件
```

另有两个 Agent 技能（在 github.com/lxfei1001/skills 仓库，装到 `~/.workbuddy/skills/`）：
- `lingxing-sta-monitor` — CDP 模式下助手亲自操作探测的标准流程
- `browser-takeover` — 通用浏览器接管（CDP 坑位大全）

## 当前版本与状态（2026-09-24）

- **v0.4.0**：UI 全面改版。监控面板 / 最近一轮结果 chips（命中好仓绿色高亮）/ 轮询历史列表 /
  可编辑设置（阈值 5、最大轮询 100 次、白名单 30 个，存 chrome.storage.lx_settings，
  下一轮生效）/ 钉钉通知（webhook+加签，存 lx_dingtalk）/ 旧「自动创建STA」流程折叠保留
- 实测已验证：选店铺→导入→提交装箱→读编码 全链路 CDP 走通；阈值 5 下探测 2 轮未达标

## 关键技术事实（省你半天踩坑）

1. 领星是 **Vue + Element UI**；按钮匹配用精确文本（先 `replace(/\s/g,'')`）
2. 店铺控件是自定义下拉（`.ak-seller-select .selected-section`），选中值在 span 不在 input.value
3. 导入弹窗内 `.el-dialog .el-upload input[type=file][accept=.xlsx]` 是全页唯一文件框；
   上传用 DataTransfer 塞 File + dispatch change
4. 点「创建」/「提交装箱并继续」后可能弹「自动提交装箱数据」确认框 → 点「确认」→
   约 20-60s 后步骤③页面文本出现「中部RFD2」等编码
5. 编码提取正则 `\b[A-Z]{2,4}\d\b`（单尾数字，天然排除 CCA072/B0HHHF8LJ）；
   IUSJ/IUSQ/IUSP 无数字需单独匹配
6. 「暂存」只存草稿不出仓库；「提交装箱并继续」「创建」才生成入库配置（≠真实申报）

## 在新电脑上跑起来

### macOS
1. `git clone` 本仓库到任意目录
2. Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`
3. 双击 `启动领星登录浏览器.command`（CDP 调试窗口，用于助手接管），在新窗口登录领星
4. 日常监控也可以只用插件（不需要调试窗口）：插件弹窗粘贴 localTaskId → 开始监控

### Windows（未实测，差异点）
- 启动器需改写为 .bat：`start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%USERPROFILE%\.webdebug-profile" --remote-debugging-port=9222 <url>`
- 其余（扩展加载、监控逻辑）跨平台一致

### 助手接管模式（可选）
1. 安装两个技能到 `~/.workbuddy/skills/`（本仓库 skills/ 下）
2. 用户说「监控领星 STA，localTaskId 是 xxx」→ 助手按技能流程操作

## 待办 / 已知问题

- [ ] 「提交装箱并继续」按钮的页面适配只用精确文本匹配验证过，领星改版需跟进
- [ ] 阈值 5 命中概率低，历史数据：#1 命中 3，#2 命中 2，#3 命中 3（每次 5~6 个仓库分配）
- [ ] 钉钉 webhook 未配置（config/dingtalk.json 和插件内都为空）
- [ ] Windows 启动器未实测
- [ ] 测试遗留：账号里有个测试草稿 STA（localTaskId=**********）

## 数据边界

- `chrome-profile/`（登录态）、`logs/`（运行日志）不入库（.gitignore 已排除）
- 领星登录态不可跨机器迁移（cookie 加密绑定系统），新机器需重新登录一次
- 钉钉 webhook/加签属于敏感凭据，不要提交到仓库
