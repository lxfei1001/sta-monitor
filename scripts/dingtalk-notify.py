#!/usr/bin/env python3
"""钉钉群机器人通知：读取 config/dingtalk.json，支持加签。用法：
python3 dingtalk-notify.py "标题" "markdown正文"
"""
import json, sys, os, time, hmac, hashlib, base64, urllib.parse, urllib.request

CFG = os.path.join(os.path.dirname(__file__), "..", "config", "dingtalk.json")

def load_cfg():
    with open(CFG, encoding="utf-8") as f:
        return json.load(f)

def send(title, text):
    cfg = load_cfg()
    webhook = (cfg.get("webhook") or "").strip()
    if not webhook:
        print("SKIP: 未配置钉钉 webhook")
        return 2
    if "access_token=" not in webhook:
        print("ERROR: webhook 格式不对（应含 access_token=）")
        return 1
    secret = (cfg.get("secret") or "").strip()
    if secret:
        ts = str(round(time.time() * 1000))
        sign = base64.b64encode(hmac.new(secret.encode(), f"{ts}\n{secret}".encode(),
                                         hashlib.sha256).digest()).decode()
        webhook += f"&timestamp={ts}&sign={urllib.parse.quote(sign)}"
    payload = json.dumps({
        "msgtype": "markdown",
        "markdown": {"title": title, "text": f"### {title}\n\n{text}"}
    }).encode("utf-8")
    req = urllib.request.Request(webhook, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read().decode())
    if body.get("errcode") == 0:
        print("OK: 钉钉已推送")
        return 0
    print(f"ERROR: {body}")
    return 1

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    title = sys.argv[1]
    text = sys.argv[2] if len(sys.argv) > 2 else title
    sys.exit(send(title, text))
