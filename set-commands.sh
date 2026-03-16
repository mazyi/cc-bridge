#!/bin/bash

# 从配置文件读取 BOT_TOKEN
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/.env"

# 调用 Telegram API 设置 Bot Commands
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "new", "description": "创建新会话"},
      {"command": "status", "description": "当前会话状态"},
      {"command": "ls", "description": "列出所有会话"},
      {"command": "history", "description": "查看最近命令"},
      {"command": "capture", "description": "捕获屏幕"}
    ]
  }'

echo ""
echo "✅ Bot Commands 设置完成"
