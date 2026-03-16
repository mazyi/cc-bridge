# 添加新渠道指南

本文档说明如何为 CC-Bridge 添加新的消息渠道（如 Discord、WeChat、Slack 等）。

## 目录

1. [架构概述](#架构概述)
2. [快速开始](#快速开始)
3. [完整示例](#完整示例)
4. [测试指南](#测试指南)
5. [已支持渠道](#已支持渠道)

## 架构概述

CC-Bridge 使用渠道抽象层来支持多种消息平台：

```
┌─────────────────────────────────────────────────────────────┐
│                        User Interface                         │
│  (Telegram, Feishu, Discord, WeChat, Slack, ...)           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Channel Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │   Telegram   │  │    Feishu    │  │   Your Channel   │ │
│  │   Channel    │  │   Channel    │  │                  │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Command Handlers                            │
│              (/new, /list, /close, ...)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Session / tmux                            │
│              (Claude Code 会话管理)                         │
└─────────────────────────────────────────────────────────────┘
```

### 核心文件

- `src/channels/base.js` - 基础渠道接口
- `src/channels/format.js` - 消息格式化工具
- `src/channels/manager.js` - 渠道管理器
- `src/channels/telegram.js` - Telegram 渠道实现（参考）
- `src/channels/feishu.js` - 飞书渠道实现（参考）
- `src/commands.js` - 与渠道无关的命令逻辑

## 已支持渠道

### Telegram

```env
# 方式一：简化配置（向后兼容）
BOT_TOKEN=your_bot_token
CHAT_IDS=chat_id_1,chat_id_2

# 方式二：多渠道配置
CHANNELS=telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_IDS=chat_id_1,chat_id_2
```

获取方式：
1. 在 https://t.me/BotFather 创建 Bot 获取 BOT_TOKEN
2. 向 Bot 发送消息后，可通过 API 或第三方工具获取 CHAT_IDS

### 飞书 (Feishu) - WebSocket 长连接模式

```env
CHANNELS=feishu
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_RECEIVE_IDS=ou_xxxxxxxxxxxx,oc_xxxxxxxxxxxx
```

获取方式：
1. 在 https://open.feishu.cn 创建企业自建应用
2. 获取 App ID 和 App Secret
3. 配置应用权限:
   - `im:message:send_as_bot` - 以应用身份发送消息
   - `im:message` - 获取消息
4. **事件订阅**: 选择 "使用长连接接收事件" (无需配置 Webhook 服务器)
5. 发布应用版本并启用
6. 获取用户的 open_id 或群的 chat_id 作为 RECEIVE_IDS

**工作原理**: 使用 WebSocket 长连接主动连接飞书服务器，实时接收消息事件，无需公网 IP 或 Webhook 配置。

## 快速开始
