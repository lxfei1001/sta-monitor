#!/bin/bash
# 好仓库监控 · 领星登录浏览器启动器
# 双击本文件即可打开监控专用 Chrome 窗口（独立配置，不影响日常 Chrome）
# 登录领星后保持「5天内自动登录」勾选，登录态会保存在专用配置里供自动化复用

PROFILE="/Users/liuxiaofei/workspace/workbuddy/sta-monitor/chrome-profile"

# 清理上次异常退出的锁文件
rm -f "$PROFILE"/Singleton* 2>/dev/null

# 若 9222 调试端口已有实例在跑，直接复用，只开新标签页
if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    open -na "Google Chrome" --args --user-data-dir="$PROFILE" "https://erp.lingxing.com/"
else
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        --user-data-dir="$PROFILE" \
        --remote-debugging-port=9222 \
        --no-first-run \
        "https://erp.lingxing.com/" &
fi

echo ""
echo "✓ 领星登录浏览器已启动（窗口可能需要几秒出现）"
echo "  登录后这个终端窗口可以直接关掉，不影响浏览器"
