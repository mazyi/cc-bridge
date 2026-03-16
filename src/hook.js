#!/usr/bin/env node
/**
 * hook.js — Claude Code hooks 处理器 (多渠道版本)
 *
 * 独立运行（Claude Code hooks）：node src/hook.js <notification|stop|SessionStart>
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  loadState,
  findSessionByClaudeId,
  findSessionByTmuxName,
  updateSession,
  associateClaudeSession,
  getActiveSession,
  getActiveChannel,
} from "./session.js";
import { loadConfig } from "./config.js";
import { tmuxCapture, tmuxSessionExists, getCurrentTmuxSession } from "./tmux.js";
import { parseLatestAssistantReply, parsePendingToolUse } from "./transcript.js";
import { ChannelManager } from "./channels/manager.js";
import { MessageFormatter, escapeHtml, escapeMarkdownV2, unescapeJson, sendTelegramMessageRaw, sendFeishuMessage } from "./channels/index.js";

function logHookEvent(eventType, input) {
  try {
    const claudeSessionId = input.session_id;
    if (!claudeSessionId) {
      return;
    }

    const session = findSessionByClaudeId(claudeSessionId);
    if (!session) {
      return;
    }

    if (!session.enableHookLog) {
      return;
    }

    const logDir = join(process.cwd(), "log");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const dateStr = now.toISOString().split('T')[0];
    const logFile = join(logDir, `hook-${dateStr}.log`);

    const logEntry = {
      timestamp,
      event: eventType,
      sessionId: session.id,
      input: input
    };

    appendFileSync(logFile, JSON.stringify(logEntry) + "\n", "utf-8");
  } catch (err) {
    console.error("Failed to write hook log:", err);
  }
}

function tryAssociate(claudeSessionId, cwd) {
  let session = findSessionByClaudeId(claudeSessionId);

  if (!session) {
    const tmuxName = getCurrentTmuxSession();

    if (tmuxName) {
      session = findSessionByTmuxName(tmuxName);

      if (session && claudeSessionId) {
        associateClaudeSession(session.id, claudeSessionId);
      }
    }
  }

  return session || undefined;
}

function formatLabel(session, cwd) {
  if (session?.name) {
    return session.name;
  }

  let projectName;
  if (session?.projectPath && session.projectPath !== "unknown") {
    const parts = session.projectPath.split(/[\\/]/).filter(Boolean);
    projectName = parts[parts.length - 1] || "未知位置";
  } else if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    projectName = parts[parts.length - 1] || "未知位置";
  } else {
    projectName = "未知位置";
  }

  if (session) {
    return `#${session.id} /${projectName}`;
  } else {
    return `/${projectName}`;
  }
}

function extractLastAssistantReply(captured) {
  const lines = captured.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^-+$/.test(trimmed);
  });

  if (lines.length === 0) return "";

  let lastBlock = [];
  let foundContent = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (line.length === 0) {
      if (foundContent) break;
      continue;
    }

    const isPrompt =
      line.startsWith(">") ||
      line.startsWith("USER>") ||
      line.startsWith("You:") ||
      line.startsWith("Human:") ||
      line === "✓" ||
      line.startsWith("✓") ||
      line.includes("Claude Code") ||
      line.includes("@claude") ||
      line.includes("claude");

    if (isPrompt) {
      if (foundContent) break;
      continue;
    }

    lastBlock.unshift(lines[i]);
    foundContent = true;
  }

  if (lastBlock.length === 0) {
    return lines.slice(-10).join("\n");
  }

  return lastBlock.join("\n");
}

/**
 * 通过 ChannelManager 广播消息（只发送到活跃渠道）
 */
async function broadcastThroughChannelManager(message, options = {}) {
  try {
    const config = loadConfig();

    // 获取活跃渠道
    const activeChannel = getActiveChannel();

    // 如果没有设置活跃渠道，默认使用第一个渠道
    let targetChannel = activeChannel;
    if (!targetChannel && config.channels && config.channels.length > 0) {
      targetChannel = config.channels[0].type;
    }

    if (!targetChannel) {
      console.error("[Hook] 没有可用的渠道");
      return;
    }

    console.log(`[Hook] targetChannel: ${targetChannel}, config.channels:`, config.channels.map(c => c.type));

    // 只发送到活跃渠道
    for (const channelConfig of config.channels) {
      // 跳过非活跃渠道
      if (channelConfig.type !== targetChannel) {
        continue;
      }

      if (channelConfig.type === "telegram") {
        const { botToken, chatIds } = channelConfig.config;
        const parseMode = options.parseMode || "HTML";

        let text = message;
        if (message.toFormat) {
          text = message.toFormat(parseMode);
        }

        for (const chatId of chatIds) {
          try {
            await sendTelegramMessageRaw(botToken, chatId, text, parseMode);
          } catch (err) {
            console.error(`[Hook] 发送到 ${chatId} 失败:`, err.message);
          }
        }
      } else if (channelConfig.type === "feishu") {
        const { appId, appSecret, receiveIds } = channelConfig.config;

        let text = message;
        if (message.toFormat) {
          text = message.toFormat("plain");
        }

        for (const receiveId of receiveIds) {
          try {
            await sendFeishuMessage(appId, appSecret, receiveId, text);
          } catch (err) {
            console.error(`[Hook] 发送到飞书 ${receiveId} 失败:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("[Hook] 广播失败:", err);
    // 回退到旧的直接发送方式
    await broadcastLegacy(message, options);
  }
}

/**
 * 向后兼容：直接发送 Telegram 消息
 */
async function broadcastLegacy(message, options = {}) {
  try {
    const config = loadConfig();
    const parseMode = options.parseMode || "HTML";

    let text = message;
    if (message.toFormat) {
      text = message.toFormat(parseMode);
    }

    const chatIds = config.chatIds || config.channels?.find(c => c.type === "telegram")?.config?.chatIds;
    const botToken = config.botToken || config.channels?.find(c => c.type === "telegram")?.config?.botToken;

    if (!chatIds || !botToken) {
      console.error("[Hook] 没有可用的 Telegram 配置");
      return;
    }

    for (const chatId of chatIds) {
      try {
        await sendTelegramMessage(botToken, chatId, text, parseMode);
      } catch (err) {
        console.error(`[Hook] 发送到 ${chatId} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.error("[Hook] 发送失败:", err);
  }
}

/**
 * 原始 Telegram API 发送（保持向后兼容）
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode = "HTML") {
  const maxLen = 4000;
  const messages = text.length > maxLen ? splitMessage(text, maxLen) : [text];

  for (const msg of messages) {
    let success = false;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg,
            parse_mode: parseMode,
          }),
        }
      );

      if (response.ok) {
        success = true;
      } else {
        const errorText = await response.text();
        console.error(`[Hook] Telegram API error (${parseMode}): ${response.status} ${response.statusText}`, errorText);
      }
    } catch (err) {
      console.error(`[Hook] Fetch error (${parseMode}):`, err);
    }

    if (!success) {
      try {
        const response2 = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: msg,
            }),
          }
        );

        if (!response2.ok) {
          const errorText = await response2.text();
          console.error(`[Hook] Telegram API error (plain): ${response2.status} ${response2.statusText}`, errorText);
        }
      } catch (err2) {
        console.error(`[Hook] Fetch error (plain):`, err2);
        throw err2;
      }
    }
  }
}

function splitMessage(text, maxLen) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      splitIdx = maxLen;
    }
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return parts;
}

async function processHookInput(input, eventType) {
  logHookEvent(eventType, input);

  const notifType = input.notification_type || "unknown";
  const message = input.message || "";
  const title = input.title || "";

  let text = null;
  let session = null;
  let parseMode = "HTML";

  if (eventType === "Stop" || input.hook_event_name === "Stop") {
    session = tryAssociate(input.session_id, input.cwd);

    if (!session) {
      return;
    }

    let summary = "";

    if (input.last_assistant_message) {
      summary = input.last_assistant_message;
    }

    if (!summary && input.transcript_path) {
      const transcriptReply = parseLatestAssistantReply(input.transcript_path);
      if (transcriptReply) {
        summary = transcriptReply;
      }
    }

    if (!summary && session.tmuxName) {
      try {
        if (tmuxSessionExists(session.tmuxName)) {
          const captured = tmuxCapture(session.tmuxName, 100);
          if (captured) {
            summary = extractLastAssistantReply(captured);
          }
        }
      } catch (err) {
        // 静默失败
      }
    }

    if (!summary) {
      summary = "（无内容）";
    }

    const unescapedSummary = unescapeJson(summary);
    const sessionLabel = formatLabel(session, input.cwd);

    text = MessageFormatter.sessionLabel(sessionLabel, `Claude 已完成:\n\n${unescapedSummary}`);
    parseMode = "MarkdownV2";
  } else if (
    eventType === "Notification" ||
    input.hook_event_name === "Notification"
  ) {
    session = tryAssociate(input.session_id, input.cwd);

    if (!session) {
      return;
    }

    if (session.status === "stopped") {
      return;
    }

    const sessionLabel = formatLabel(session, input.cwd);

    switch (notifType) {
      case "permission_prompt": {
        let detailText = "";

        if (input.transcript_path) {
          const toolUse = parsePendingToolUse(input.transcript_path);
          if (toolUse) {
            const { name, input: toolInput } = toolUse;

            if (name === "Bash" && toolInput.command) {
              const cmd = toolInput.command.length > 200
                ? toolInput.command.slice(0, 200) + "..."
                : toolInput.command;
              detailText = `\n\n<b>命令:</b>\n<code>${escapeHtml(cmd)}</code>`;
            } else if (name === "Read" && toolInput.file_path) {
              detailText = `\n\n<b>文件:</b> <code>${escapeHtml(toolInput.file_path)}</code>`;
            } else if (name === "Write" && toolInput.file_path) {
              detailText = `\n\n<b>写入文件:</b> <code>${escapeHtml(toolInput.file_path)}</code>`;
            } else if (name === "Edit" && toolInput.file_path) {
              detailText = `\n\n<b>编辑文件:</b> <code>${escapeHtml(toolInput.file_path)}</code>`;
            } else if (name === "Glob" && toolInput.pattern) {
              detailText = `\n\n<b>搜索模式:</b> <code>${escapeHtml(toolInput.pattern)}</code>`;
            } else if (name === "Grep" && toolInput.pattern) {
              detailText = `\n\n<b>搜索内容:</b> <code>${escapeHtml(toolInput.pattern)}</code>`;
            } else if (toolInput) {
              const params = Object.entries(toolInput)
                .slice(0, 3)
                .map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`)
                .join(", ");
              if (params) {
                detailText = `\n\n<b>参数:</b> <code>${escapeHtml(params)}</code>`;
              }
            }
          }
        }

        let optionCount = 3;
        if (session.tmuxName && tmuxSessionExists(session.tmuxName)) {
          try {
            const captured = tmuxCapture(session.tmuxName, 30);
            if (captured) {
              const matches = captured.match(/\s+\d+\.\s+\w+/g);
              if (matches && matches.length > 0) {
                optionCount = matches.length;
              }
            }
          } catch (err) {
            // 捕获失败，使用默认值
          }
        }

        try {
          updateSession(session.id, { lastPermissionOptionCount: optionCount });
        } catch (err) {
          // 静默失败
        }

        let replyHint = "";
        if (optionCount === 2) {
          replyHint = `\n\n回复:\n<code>y</code> - 允许\n<code>n</code> - 拒绝`;
        } else {
          replyHint = `\n\n回复:\n<code>y</code> - 允许 (仅本次)\n<code>a</code> - 允许并记住 (自动允许后续)\n<code>n</code> - 拒绝`;
        }

        text = `⚠️ <b>${escapeHtml(sessionLabel)}</b> 权限请求:\n${escapeHtml(title)}\n\n${escapeHtml(message)}${detailText}${replyHint}`;
        break;
      }
      case "idle_prompt":
        text = `💬 <b>${escapeHtml(sessionLabel)}</b> Claude 等待你的输入`;
        break;
      case "auth_success":
        text = `🔑 <b>${escapeHtml(sessionLabel)}</b> 认证成功`;
        break;
      case "elicitation_dialog":
        text = `❓ <b>${escapeHtml(sessionLabel)}</b> Claude 需要更多信息:\n${escapeHtml(message)}`;
        break;
      default:
        text = `📢 <b>${escapeHtml(sessionLabel)}</b> ${escapeHtml(title || notifType)}:\n${escapeHtml(message)}`;
    }
  } else if (eventType === "SessionStart") {
    text = handleSessionStart(input);
  }

  if (text) {
    try {
      await broadcastThroughChannelManager(text, { parseMode });

      if (eventType === "Stop" || input.hook_event_name === "Stop") {
        if (session) {
          try {
            updateSession(session.id, {
              status: "idle",
              lastActivityAt: new Date().toISOString(),
            });
          } catch (err) {
            // 静默失败
          }
        }
      }
    } catch (err) {
      console.error("[Hook] 发送失败:", err);
    }
  }
}

function handleSessionStart(input) {
  const claudeSessionId = input.session_id;

  if (!claudeSessionId) {
    return null;
  }

  let session = findSessionByClaudeId(claudeSessionId);

  if (!session) {
    const tmuxName = getCurrentTmuxSession();
    if (!tmuxName) {
      return null;
    }

    session = findSessionByTmuxName(tmuxName);
    if (!session) {
      return null;
    }
    associateClaudeSession(session.id, claudeSessionId);
  }

  const sessionName = session.name || "未命名";
  return `✅ <b>${session.id} ${sessionName}</b> 新会话已就绪`;
}

export { sendTelegramMessage, formatLabel, escapeHtml, escapeMarkdownV2 };

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  (async () => {
    const eventType = process.argv[2];

    if (!eventType) {
      process.exit(1);
    }

    let rawInput;
    try {
      rawInput = readFileSync(0, "utf-8");
    } catch (err) {
      process.exit(1);
    }

    let input;
    try {
      input = JSON.parse(rawInput);
    } catch (err) {
      process.exit(1);
    }

    await processHookInput(input, eventType);
  })().catch(async (err) => {
    try {
      const config = loadConfig();
      const errorMsg = `🚨 <b>CC-Bridge Hook 错误</b>\n\n<pre>${escapeHtml(err.message || String(err))}</pre>`;
      await broadcastLegacy(errorMsg, { parseMode: "HTML" });
    } catch {
      // ignore
    }
    process.exit(1);
  });
}
