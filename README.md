# CC-Bridge

通过 Telegram 远程控制多个 Claude Code 会话的桥接工具。

## 简介

CC-Bridge 是一个轻量级的桥接系统，让你可以通过 Telegram Bot 远程控制和管理多个 Claude Code CLI 会话。它使用 tmux 进行会话管理，通过 Claude Code 的 hooks 机制实现双向通信。

**核心特性**：
- 多会话并发管理
- 实时双向消息传递
- 智能权限处理（支持 y/a/n 快捷回复）
- 会话持久化与恢复
- 对话历史查看

## 快速开始

### 前置条件

- Node.js 18+
- tmux
- Claude Code CLI (`claude`)
- Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取）
- Chat ID（通过初始化向导自动获取，向 Bot 发送 /start 即可）

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd cc-bridge

# 安装依赖
npm install

# 运行初始化向导（配置 Bot Token、授权用户和 Claude hooks）
npm run init
```

### 运行

```bash
npm start
```

Bot 启动后会持续运行，监听 Telegram 消息。

### 手动配置 Hooks（可选）

如果 `npm run init` 未能自动配置 Claude Code hooks，可以手动编辑 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/cc-bridge/src/hook.js Notification"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/cc-bridge/src/hook.js Stop"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/cc-bridge/src/hook.js SessionStart"
          }
        ]
      }
    ]
  }
}
```

**注意**：
- 必须使用 `hook.js` 的绝对路径
- 可以用 `pwd` 命令在项目目录下获取完整路径
- 事件名称（Notification/Stop/SessionStart）使用大写开头
- 配置后重启 Claude Code 会话生效

## 基本使用

在 Telegram 中与 Bot 对话：

```
/new                    # 创建新会话
/list                   # 列出所有会话
/switch 2               # 切换到会话 #2
/status                 # 查看当前会话状态
/capture                # 捕获屏幕输出
/history 5              # 查看最近 5 条用户命令
/close                  # 关闭当前会话
直接发送文本              # 注入到当前活跃会话
回复 y/a/n              # 快速响应权限请求
```

## 详细文档

完整的架构说明、配置指南和故障排查请参考：
- [ARCHITECTURE.md](./ARCHITECTURE.md) - 系统架构和工作原理
- [CLAUDE.md](./CLAUDE.md) - 开发者指南

## License

MIT
