#!/usr/bin/env node
/**
 * hook.js — Claude Code hooks 处理器
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
} from "./session.js";
import { loadConfig } from "./config.js";
import { tmuxCapture, tmuxSessionExists, getCurrentTmuxSession } from "./tmux.js";
import { parseLatestAssistantReply, parsePendingToolUse } from "./transcript.js";

function logHookEvent(eventType, input) {
  try {
    // 查找对应的 session
    const claudeSessionId = input.session_id;
    if (!claudeSessionId) {
      return; // 没有 session_id，不记录日志
    }

    const session = findSessionByClaudeId(claudeSessionId);
    if (!session) {
      return; // 找不到 session，不记录日志
    }

    // 检查是否启用了日志记录（默认关闭）
    if (!session.enableHookLog) {
      return; // 日志开关未开启，不记录
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
    // 静默失败，不影响主流程
    console.error("Failed to write hook log:", err);
  }
}

async function sendTelegramMessage(botToken, chatId, text, parseMode = "HTML") {
  const maxLen = 4000;
  const messages = text.length > maxLen ? splitMessage(text, maxLen) : [text];

  for (const msg of messages) {
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

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Telegram API error (${parseMode}): ${response.status} ${response.statusText}`, errorText);
      }
    } catch (err) {
      console.error(`❌ Fetch error (${parseMode}):`, err);

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
          console.error(`❌ Telegram API error (plain): ${response2.status} ${response2.statusText}`, errorText);
        }
      } catch (err2) {
        console.error(`❌ Fetch error (plain):`, err2);
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

function tryAssociate(claudeSessionId, cwd) {
  // 通过 claudeSessionId 精确匹配
  let session = findSessionByClaudeId(claudeSessionId);

  if (!session) {
    // 如果找不到，尝试通过 tmux name 匹配
    const tmuxName = getCurrentTmuxSession();

    if (tmuxName) {
      session = findSessionByTmuxName(tmuxName);

      if (session && claudeSessionId) {
        // 找到了对应的会话，更新 claudeSessionId
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

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeJson(s) {
  // JSON 反转义：将 JSON 字符串中的转义序列还原为原始字符
  return s
    .replace(/\\n/g, "\n")      // 换行
    .replace(/\\r/g, "\r")      // 回车
    .replace(/\\t/g, "\t")      // 制表符
    .replace(/\\"/g, '"')       // 双引号
    .replace(/\\'/g, "'")       // 单引号
    .replace(/\\\\/g, "\\");    // 反斜杠（必须最后处理）
}

function escapeMarkdownV2(s) {
  // 根据 Telegram MarkdownV2 规则转义特殊字符
  // 必须转义的字符: _ * [ ] ( ) ~ ` > # + - = | { } . ! \ < >
  // 注意: \ 必须首先转义
  return s
    .replace(/\\/g, "\\\\")  // \ 必须首先转义
    .replace(/_/g, "\\_")
    .replace(/\*\*/g, "\*") // 这里不要改，claude的**加粗，tg里*才是加粗
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\`") // 这里不要改，tg里`是蓝色的可复制文本
    .replace(/>/g, "\\>")
    .replace(/</g, "\\<")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

function extractLastAssistantReply(captured) {
  const lines = captured.split("\n").filter((line) => {
    const trimmed = line.trim();
    // 过滤空行和 Claude Code 对话框分隔符
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


// 核心函数：根据输入发送通知
async function processHookInput(input, eventType) {
  // 记录 hook 事件到日志
  logHookEvent(eventType, input);

  const notifType = input.notification_type || "unknown";
  const message = input.message || "";
  const title = input.title || "";

  let text = "";
  let session = null; // 在函数作用域定义 session，避免作用域问题

  if (eventType === "Stop" || input.hook_event_name === "Stop") {
    session = tryAssociate(input.session_id, input.cwd);

    if (!session) {
      return;
    }

    let summary = "";

    // 优先级 1: last_assistant_message
    if (input.last_assistant_message) {
      summary = input.last_assistant_message;
    }

    // 优先级 2: transcript_path
    if (!summary && input.transcript_path) {
      const transcriptReply = parseLatestAssistantReply(input.transcript_path);
      if (transcriptReply) {
        summary = transcriptReply;
      }
    }

    // 优先级 3: tmux capture
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

    // 先进行 JSON 反转义，获得写入 JSON 前的原始字符串
    const unescapedSummary = unescapeJson(summary);

    const sessionLabel = formatLabel(session, input.cwd);
    const escapedLabel = escapeMarkdownV2(sessionLabel);
    const escapedSummary = escapeMarkdownV2(unescapedSummary);
    text = `✅ *${escapedLabel}* Claude 已完成:\n\n${escapedSummary}`;
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

        // 尝试从 transcript 中获取具体的工具调用详情
        if (input.transcript_path) {
          const toolUse = parsePendingToolUse(input.transcript_path);
          if (toolUse) {
            const { name, input: toolInput } = toolUse;

            // 根据不同工具类型提取关键信息
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
              // 其他工具，显示简化的参数
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

        // 捕获屏幕内容，判断有几个选项
        let optionCount = 3; // 默认 3 个选项
        if (session.tmuxName && tmuxSessionExists(session.tmuxName)) {
          try {
            const captured = tmuxCapture(session.tmuxName, 30);
            if (captured) {
              // 匹配所有的数字序号（1. 2. 3. 等），不限定在行首
              // 匹配格式：可选空格 + 数字 + 点 + 空格 + 文本
              const matches = captured.match(/\s+\d+\.\s+\w+/g);
              if (matches && matches.length > 0) {
                optionCount = matches.length;
              }
            }
          } catch (err) {
            // 捕获失败，使用默认值
          }
        }

        // 将选项数量存储到 session 中，供 bot.js 使用
        try {
          updateSession(session.id, { lastPermissionOptionCount: optionCount });
        } catch (err) {
          // 静默失败
        }

        // 根据选项数量生成不同的提示
        let replyHint = "";
        if (optionCount === 2) {
          replyHint = `\n\n回复:\n<code>y</code> - 允许\n<code>n</code> - 拒绝`;
        } else {
          replyHint = `\n\n回复:\n<code>y</code> - 允许 (仅本次)\n<code>a</code> - 允许并记住 (自动允许后续)\n<code>n</code> - 拒绝`;
        }

        text = `⚠️ <b>${sessionLabel}</b> 权限请求:\n${escapeHtml(title)}\n\n${escapeHtml(message)}${detailText}${replyHint}`;
        break;
      }
      case "idle_prompt":
        text = `💬 <b>${sessionLabel}</b> Claude 等待你的输入`;
        break;
      case "auth_success":
        text = `🔑 <b>${sessionLabel}</b> 认证成功`;
        break;
      case "elicitation_dialog":
        text = `❓ <b>${sessionLabel}</b> Claude 需要更多信息:\n${escapeHtml(message)}`;
        break;
      default:
        text = `📢 <b>${sessionLabel}</b> ${escapeHtml(title || notifType)}:\n${escapeHtml(message)}`;
    }
  } else if (eventType === "SessionStart") {
    // 处理 SessionStart 事件（Claude Code 自定义 hook）
    text = handleSessionStart(input);
  } else {
    text = `📌 <b>未知事件</b> ${input.hook_event_name}: ${escapeHtml(JSON.stringify(input).slice(0, 500))}`;
  }

  if (text) {
    try {
      const config = loadConfig();
      const parseMode = (eventType === "Stop" || input.hook_event_name === "Stop") ? "MarkdownV2" : "HTML";

      // 向所有授权的 chat ID 发送消息
      for (const chatId of config.chatIds) {
        await sendTelegramMessage(config.botToken, chatId, text, parseMode);
      }

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
      // 静默失败
    }
  }
}

function handleSessionStart(input) {
  const claudeSessionId = input.session_id;

  if (!claudeSessionId) {
    return null;
    return `⚠️ 未知会话(无ID)准备就绪`;
  }

  // 通过 claudeSessionId 查找对应的 session
  let session = findSessionByClaudeId(claudeSessionId);

  if (!session) {
    // 如果找不到，尝试通过 tmux name 匹配
    const tmuxName = getCurrentTmuxSession();
    if (!tmuxName) {
      // tmuxName 为 null，也显示警告
      const shortId = claudeSessionId.slice(0, 8);
      return null;
      return `⚠️ 未知会话(${shortId})准备就绪`;
    }

    session = findSessionByTmuxName(tmuxName);
    if (!session) {
      // 还是找不到，显示警告
      return null;
      return `⚠️ 未知会话(${tmuxName})准备就绪`;
    }
    // 找到了对应的会话，更新 claudeSessionId
    associateClaudeSession(session.id, claudeSessionId);
  }

  const sessionName = session.name || "未命名";
  return `✅ <b>${session.id} ${sessionName}</b> 新会话已就绪`;
}

export { sendTelegramMessage, formatLabel, escapeHtml, escapeMarkdownV2 };

// 独立运行（被 Claude Code hooks 调用）
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

      // 向所有授权的 chat ID 发送错误消息
      for (const chatId of config.chatIds) {
        await sendTelegramMessage(config.botToken, chatId, errorMsg);
      }
    } catch {
    }
    process.exit(1);
  });
}
