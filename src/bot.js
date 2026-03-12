import { Bot, InlineKeyboard } from "grammy";
import { loadConfig } from "./config.js";
import {
  createSession,
  getActiveSession,
  setActiveSession,
  closeSession,
  listActiveSessions,
  listAllSessions,
  updateSession,
  syncSessionStates,
  loadState,
} from "./session.js";
import {
  createTmuxSession,
  tmuxSendKeys,
  tmuxCapture,
  killTmuxSession,
  checkTmux,
  tmuxSessionExists,
  tmuxSendSpecialKey,
} from "./tmux.js";
import { parseRecentConversations } from "./transcript.js";
import { homedir } from "os";
import { join } from "path";
import { escapeMarkdownV2 } from "./hook.js";

const newSessionFlows = new Map();

/**
 * 安全地发送 Telegram 消息，捕获所有错误
 */
async function safeReply(ctx, text, options = {}) {
  try {
    return await ctx.reply(text, options);
  } catch (err) {
    console.error("❌ 发送消息失败:", err.message);
    // 尝试发送纯文本版本（去掉格式）
    try {
      return await ctx.reply(text.replace(/<[^>]*>/g, ""));
    } catch (fallbackErr) {
      console.error("❌ 发送纯文本消息也失败:", fallbackErr.message);
      return null;
    }
  }
}

/**
 * 安全地编辑消息
 */
async function safeEditMessageText(ctx, text, options = {}) {
  try {
    return await ctx.editMessageText(text, options);
  } catch (err) {
    console.error("❌ 编辑消息失败:", err.message);
    return null;
  }
}

/**
 * 包装命令处理器，添加统一的错误处理
 */
function wrapHandler(handler) {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      console.error("❌ 命令处理错误:", err);
      await safeReply(ctx, `⚠️ 处理命令时发生错误: ${err.message}`);
    }
  };
}

export function createBot(config) {
  const bot = new Bot(config.botToken);
  const allowedChatIds = config.chatIds || [];

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (!allowedChatIds.includes(chatId)) {
      await safeReply(ctx, "⛔ 未授权的用户");
      return;
    }
    await next();
  });

  bot.command("start", wrapHandler(async (ctx) => {
    await safeReply(
      ctx,
      "🤖 <b>CC-Bridge</b> — Telegram ↔ Claude Code\n\n" +
        "命令列表:\n" +
        "/new [claude_session_id] — 创建新会话\n" +
        "/list — 列出所有会话\n" +
        "/switch <id> — 切换活跃会话\n" +
        "/close <id> — 关闭会话\n" +
        "/status — 当前状态\n" +
        "/capture — 捕获当前会话屏幕\n" +
        "/history [count] — 查看最近用户命令 (默认3条)\n" +
        "/all_history [count] — 查看最近完整对话 (默认3条)\n\n" +
        "直接发送文本会注入到当前活跃会话中。",
      { parse_mode: "HTML" }
    );
  }));

  bot.command("new", wrapHandler(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await safeReply(ctx, "❌ 无法获取 chatId");
      return;
    }

    // 检查是否提供了 Claude session ID 参数
    const claudeSessionId = ctx.match?.trim();

    if (claudeSessionId) {
      // 使用提供的 Claude session ID
      newSessionFlows.set(chatId, { step: "path", claudeSessionId });
      await safeReply(ctx, `🔗 使用 Claude Session ID: <code>${claudeSessionId}</code>\n\n📁 请输入项目路径（绝对路径）:`, { parse_mode: "HTML" });
    } else {
      // 自动生成 Claude session ID（原有流程）
      newSessionFlows.set(chatId, { step: "path" });
      await safeReply(ctx, "📁 请输入项目路径（绝对路径）:");
    }
  }));

  const listHandler = wrapHandler(async (ctx) => {
    syncSessionStates();
    const sessions = listAllSessions();
    const state = loadState();

    if (sessions.length === 0) {
      await safeReply(ctx, "📋 没有会话。发送 /new 创建一个。");
      return;
    }

    const lines = sessions.map((s) => {
      const isActive = s.id === state.activeSessionId;
      const icon = isActive ? "➤" : " ";
      const statusIcon =
        s.status === "active"
          ? "⚡"
          : s.status === "idle"
            ? "💤"
            : s.status === "starting"
              ? "🔄"
              : "⏹";
      const name = s.name ? `[${s.name}]` : "";
      const tmuxStatus = tmuxSessionExists(s.tmuxName) ? "🖥" : "";
      return `${icon} #${s.id} ${name} ${s.projectPath}\n   ${statusIcon} ${s.status} ${tmuxStatus} | ${s.permissionMode === "auto" ? "无确认" : "需确认"}`;
    });

    await safeReply(
      ctx,
      `📋 <b>会话列表</b> (共 ${sessions.length} 个)\n━━━━━━━━━━\n${lines.join("\n\n")}\n━━━━━━━━━━\n当前: #${state.activeSessionId || "无"}\n\n💡 使用 /close {序号} 关闭会话`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("list", listHandler);
  bot.command("ls", listHandler);

  const switchHandler = wrapHandler(async (ctx) => {
    const idStr = ctx.match;
    if (!idStr) {
      await safeReply(ctx, "用法: /switch <id> 或 /s <id>\n例如: /s 2");
      return;
    }
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      await safeReply(ctx, "❌ 无效的 ID");
      return;
    }

    syncSessionStates();
    if (setActiveSession(id)) {
      const session = listActiveSessions().find((s) => s.id === id);
      const name = session?.name ? ` [${session.name}]` : "";
      await safeReply(ctx, `✅ 已切换到会话 #${id}${name}`);
    } else {
      await safeReply(ctx, `❌ 会话 #${id} 不存在或已关闭`);
    }
  });

  bot.command("switch", switchHandler);
  bot.command("s", switchHandler);

  bot.command("close", wrapHandler(async (ctx) => {
    const idStr = ctx.match;
    let id;

    // 如果没有提供 ID，使用当前活跃会话
    if (!idStr) {
      syncSessionStates();
      const session = getActiveSession();
      if (!session) {
        await safeReply(ctx, "❌ 没有活跃会话。请使用 /close <id> 指定要关闭的会话。");
        return;
      }
      id = session.id;
    } else {
      id = parseInt(idStr, 10);
      if (isNaN(id)) {
        await safeReply(ctx, "❌ 无效的 ID");
        return;
      }
    }

    const sessions = listAllSessions();
    const session = sessions.find((s) => s.id === id);
    if (!session) {
      await safeReply(ctx, `❌ 会话 #${id} 不存在`);
      return;
    }

    // 显示确认对话框
    const name = session.name ? ` ${session.name}` : "";
    const keyboard = new InlineKeyboard()
      .text("✅ 确认关闭", `close_confirm:${id}`)
      .text("❌ 取消", `close_cancel:${id}`);

    await safeReply(
      ctx,
      `⚠️ 确认要关闭会话吗？\n\n#${id}${name}\n📁 ${session.projectPath}`,
      { reply_markup: keyboard }
    );
  }));

  bot.command("status", wrapHandler(async (ctx) => {
    syncSessionStates();
    const session = getActiveSession();
    if (!session) {
      await safeReply(ctx, "📊 没有活跃会话。发送 /new 创建。");
      return;
    }

    const name = session.name ? `[${session.name}]` : "";
    const tmuxAlive = tmuxSessionExists(session.tmuxName) ? "✅" : "❌";

    await safeReply(
      ctx,
      `📊 <b>当前会话 #${session.id} ${name}</b>\n` +
        `━━━━━━━━━━\n` +
        `📁 路径: <code>${session.projectPath}</code>\n` +
        `🔐 权限: ${session.permissionMode === "auto" ? "无确认" : "需确认"}\n` +
        `📡 状态: ${session.status}\n` +
        `🖥 tmux: ${session.tmuxName} ${tmuxAlive}\n` +
        `🕐 创建: ${session.createdAt}`,
      { parse_mode: "HTML" }
    );
  }));

  bot.command("capture", wrapHandler(async (ctx) => {
    const session = getActiveSession();
    if (!session) {
      await safeReply(ctx, "❌ 没有活跃会话");
      return;
    }

    const output = tmuxCapture(session.tmuxName, 80);
    if (!output) {
      await safeReply(ctx, "❌ 无法捕获屏幕内容");
      return;
    }

    const truncated = output.length > 3900 ? output.slice(-3900) : output;
    await safeReply(ctx, `🖥 <b>#${session.id} 屏幕:</b>\n<pre>${escapeHtml(truncated)}</pre>`, {
      parse_mode: "HTML",
    });
  }));

  // 通用对话历史处理器
  const historyHandler = async (ctx, includeAssistant = false) => {
    const session = getActiveSession();
    if (!session) {
      await safeReply(ctx, "❌ 没有活跃会话");
      return;
    }

    if (!session.claudeSessionId) {
      await safeReply(ctx, "❌ 当前会话没有关联的 Claude Session ID");
      return;
    }

    // 解析参数：对话数量（默认 3）
    const countStr = ctx.match?.trim();
    const count = countStr ? parseInt(countStr, 10) : 3;
    if (isNaN(count) || count < 1 || count > 10) {
      await safeReply(ctx, "❌ 无效的数量，请输入 1-10 之间的数字");
      return;
    }

    // 构建 transcript 文件路径
    // 格式: ~/.claude/projects/{项目路径-替换为-}/{sessionId}.jsonl
    const projectPathEncoded = session.projectPath
      .replace(/^\//, '')  // 移除开头的 /
      .replace(/\//g, '-'); // 将所有 / 替换为 -

    const transcriptPath = join(
      homedir(),
      ".claude",
      "projects",
      `-${projectPathEncoded}`,
      `${session.claudeSessionId}.jsonl`
    );

    const conversations = parseRecentConversations(transcriptPath, count, includeAssistant);

    if (!conversations || conversations.length === 0) {
      await safeReply(
        ctx,
        `❌ 无法读取对话记录或对话记录为空\n\n` +
        `📁 路径: ${transcriptPath}\n` +
        `🔗 Session ID: ${session.claudeSessionId}\n\n` +
        `请检查:\n` +
        `1. 文件是否存在\n` +
        `2. Session ID 是否正确\n` +
        `3. 是否有对话记录`
      );
      return;
    }

    const sessionLabel = session.name ? `[${session.name}]` : `#${session.id}`;
    const title = includeAssistant ? "完整对话" : "用户命令";

    // 按时间从老到新排序（timestamp 小的在前）
    conversations.sort((a, b) => {
      const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return timeA - timeB;
    });

    // 构建每条对话的文本块
    const entries = [];
    for (const conv of conversations) {
      // 将 UTC timestamp 转换为本地时间（HH:MM:SS）
      let localTimeStr = "??:??:??";
      if (conv.timestamp) {
        try {
          const utcDate = new Date(conv.timestamp);
          localTimeStr = utcDate.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
        } catch (e) {
          // 保持默认
        }
      }

      // 不对单条对话内容做截断（保证完整性），但设置一个极高位上限以防异常
      const MAX_SINGLE_ENTRY = 3500; // 单条对话总字符上限（包含时间、换行等）
      let entry = `${escapeMarkdownV2(localTimeStr)}: ${escapeMarkdownV2(conv.user)}\n\n`;

      if (includeAssistant && conv.assistant) {
        entry += `${escapeMarkdownV2(conv.assistant)}\n\n`;
      }

      // 如果单条对话本身超过上限，出于Telegram限制必须截断（极少情况）
      if (entry.length > MAX_SINGLE_ENTRY) {
        const truncated = entry.slice(0, MAX_SINGLE_ENTRY - 50) + "\n\n... (内容过长，已截断)";
        entries.push(truncated);
      } else {
        entries.push(entry);
      }
    }

    // 分批发送，每条消息不超过 4000 字符
    const MAX_MESSAGE_LENGTH = 3900; // 留一些缓冲
    const header = `💬 *${escapeMarkdownV2(sessionLabel)}* 最近 ${conversations.length} 条${escapeMarkdownV2(title)}:\n\n`;

    let currentBatch = header;
    let batchCount = 0;

    for (const entry of entries) {
      // 如果加入这条对话会超过限制，先发送当前批次
      if (currentBatch.length + entry.length > MAX_MESSAGE_LENGTH) {
        if (currentBatch.length > header.length) { // 避免发送只有标题的空消息
          await safeReply(ctx, currentBatch, { parse_mode: "MarkdownV2" });
          batchCount++;
        }
        // 开始新批次，从标题开始
        currentBatch = header + entry;
      } else {
        currentBatch += entry;
      }
    }

    // 发送最后一批
    if (currentBatch.length > header.length) {
      await safeReply(ctx, currentBatch, { parse_mode: "MarkdownV2" });
      batchCount++;
    }

    // 如果没有发送任何消息（理论上不会发生），发送一个提示
    if (batchCount === 0) {
      await safeReply(ctx, "❌ 没有可显示的对话内容");
    }
  };

  bot.command("history", wrapHandler(async (ctx) => {
    await historyHandler(ctx, false); // 默认只显示用户消息
  }));

  bot.command("all_history", wrapHandler(async (ctx) => {
    await historyHandler(ctx, true); // 显示完整对话
  }));

  bot.on("message:text", wrapHandler(async (ctx) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    if (!chatId || !text) {
      return;
    }

    const flow = newSessionFlows.get(chatId);
    if (flow) {
      await handleNewSessionFlow(ctx, flow, text, chatId);
      return;
    }

    syncSessionStates();
    const session = getActiveSession();
    if (!session) {
      await safeReply(ctx, "❌ 没有活跃会话。发送 /new 创建或 /list 查看。");
      return;
    }

    if (!tmuxSessionExists(session.tmuxName)) {
      await safeReply(ctx, `❌ tmux session "${session.tmuxName}" 已失效`);
      updateSession(session.id, { status: "stopped" });
      return;
    }

    try {
      // 检测是否是权限回复（单字符 y/a/n）
      const trimmedText = text.trim().toLowerCase();
      if (trimmedText.length === 1 && /^[yan]$/.test(trimmedText)) {
        // 权限回复：使用方向键选择 + Enter
        // Claude Code 权限选项布局：
        // 3 个选项: 1. Yes  2. Yes, allow xxx  3. No
        // 2 个选项: 1. Yes  2. No

        // 获取上次检测到的选项数量（默认 3）
        const optionCount = session.lastPermissionOptionCount || 3;

        if (trimmedText === 'y') {
          // y: 直接 Enter (选择第一个选项 "Yes")
          tmuxSendSpecialKey(session.tmuxName, "Enter");
        } else if (trimmedText === 'a') {
          // a: Down + Enter (选择第二个选项 "Yes, allow xxxxxxxxxxxx")
          // 注意：如果只有 2 个选项，这会选到 "No"，但用户不应该在 2 选项时使用 'a'
          tmuxSendSpecialKey(session.tmuxName, "Down");
          await new Promise(resolve => setTimeout(resolve, 100));
          tmuxSendSpecialKey(session.tmuxName, "Enter");
        } else if (trimmedText === 'n') {
          // n: 根据选项数量决定按几次 Down
          if (optionCount === 2) {
            // 2 个选项: Down + Enter (选择第二个 "No")
            tmuxSendSpecialKey(session.tmuxName, "Down");
            await new Promise(resolve => setTimeout(resolve, 100));
            tmuxSendSpecialKey(session.tmuxName, "Enter");
          } else {
            // 3 个选项: Down + Down + Enter (选择第三个 "No")
            tmuxSendSpecialKey(session.tmuxName, "Down");
            await new Promise(resolve => setTimeout(resolve, 100));
            tmuxSendSpecialKey(session.tmuxName, "Down");
            await new Promise(resolve => setTimeout(resolve, 100));
            tmuxSendSpecialKey(session.tmuxName, "Enter");
          }
        }
      } else {
        // 普通消息：使用 -l 参数逐字发送
        tmuxSendKeys(session.tmuxName, text);
      }

      updateSession(session.id, {
        status: "active",
        lastActivityAt: new Date().toISOString(),
      });
      await safeReply(ctx, `➡️ #${session.id} ✓`);
    } catch (err) {
      await safeReply(ctx, `❌ 发送失败: ${err.message}`);
    }
  }));

  bot.on("callback_query:data", wrapHandler(async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery("无法获取 chatId");
      return;
    }

    if (data.startsWith("perm:")) {
      const flow = newSessionFlows.get(chatId);
      if (!flow || flow.step !== "permission") {
        await ctx.answerCallbackQuery("会话已过期");
        return;
      }

      flow.permissionMode = data === "perm:auto" ? "auto" : "confirm";
      flow.step = "name";
      await ctx.answerCallbackQuery();
      await safeEditMessageText(
        ctx,
        `🔐 权限模式: ${flow.permissionMode === "auto" ? "无确认" : "需确认"}\n\n📝 请输入会话名 (可选，发送 <code>-</code> 跳过):`,
        { parse_mode: "HTML" }
      );
    } else if (data.startsWith("close_confirm:")) {
      const id = parseInt(data.split(":")[1], 10);
      const sessions = listAllSessions();
      const session = sessions.find((s) => s.id === id);

      if (!session) {
        await ctx.answerCallbackQuery("❌ 会话不存在");
        await safeEditMessageText(ctx, `❌ 会话 #${id} 不存在或已被关闭`);
        return;
      }

      // 如果有 tmux 窗口，先关闭它
      if (tmuxSessionExists(session.tmuxName)) {
        killTmuxSession(session.tmuxName);
      }

      // 从 sessions.json 中移除
      closeSession(id);

      await ctx.answerCallbackQuery("✅ 已关闭");
      await safeEditMessageText(
        ctx,
        `✅ 会话 #${id} 已关闭\n\n` +
        `🖥 tmux session "${session.tmuxName}" 已终止\n` +
        `📋 已从会话列表中移除`
      );
    } else if (data.startsWith("close_cancel:")) {
      const id = parseInt(data.split(":")[1], 10);
      await ctx.answerCallbackQuery("已取消");
      await safeEditMessageText(ctx, `❌ 已取消关闭会话 #${id}`);
    }
  }));

  return bot;
}

async function handleNewSessionFlow(ctx, flow, text, chatId) {
  try {
    switch (flow.step) {
      case "path": {
        const projectPath = text.trim();
        if (!projectPath.startsWith("/") && !projectPath.startsWith("~")) {
          await safeReply(ctx, "❌ 请输入绝对路径（以 / 或 ~ 开头）");
          return;
        }
        flow.projectPath = projectPath;
        flow.step = "permission";

        const keyboard = new InlineKeyboard()
          .text("🔓 无确认", "perm:auto")
          .text("🔐 需确认", "perm:confirm");

        await safeReply(ctx, "🔐 选择权限模式:", { reply_markup: keyboard });
        break;
      }

      case "name": {
        const name = text.trim() === "-" ? undefined : text.trim();

        if (!checkTmux()) {
          await safeReply(ctx, "❌ tmux 未安装，请先安装 tmux");
          newSessionFlows.delete(chatId);
          return;
        }

        // 使用提供的 Claude session ID 或生成新的 (UUID v4)
        const claudeSessionId = flow.claudeSessionId || crypto.randomUUID();

        const session = createSession(flow.projectPath, flow.permissionMode, name, claudeSessionId);

        try {
          // 先发送创建成功通知，包含 Claude session ID
          const nameText = name ? ` [${name}]` : "";
          await safeReply(
            ctx,
            `⏳ <b>${session.id}${nameText}</b> 会话启动中...\n\n` +
            `📁 路径: <code>${session.projectPath}</code>\n` +
            `🔐 权限: ${session.permissionMode === "auto" ? "无确认" : "需确认"}\n` +
            `🖥 tmux: ${session.tmuxName}\n` +
            `🔗 Claude Session ID:\n<code>${claudeSessionId}</code>`,
            { parse_mode: "HTML" }
          );

          // 然后再启动 Claude，确保 session.json 已经保存
          createTmuxSession(session.tmuxName, session.projectPath, session.permissionMode, claudeSessionId);

          await new Promise((resolve) => setTimeout(resolve, 2000));

          // 自动处理启动流程，确保 Claude 真正启动
          try {
            if (session.permissionMode === "auto") {
              // 无确认模式：自动选择 yes
              tmuxSendSpecialKey(session.tmuxName, "Down");
              await new Promise((resolve) => setTimeout(resolve, 300));
              tmuxSendSpecialKey(session.tmuxName, "Enter");
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } else {
              // 需确认模式：等待用户手动选择
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }

            // 发送回车来真正进入 Claude 对话界面（所有模式都需要）
            tmuxSendSpecialKey(session.tmuxName, "Enter");
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (err) {
            console.error("❌ 启动 Claude 时出错:", err);
          }

          updateSession(session.id, { status: "active" });
        } catch (err) {
          await safeReply(ctx, `❌ 创建失败: ${err.message}`);
          closeSession(session.id);
        }

        newSessionFlows.delete(chatId);
        break;
      }
    }
  } catch (err) {
    console.error("❌ 处理新会话流程错误:", err);
    await safeReply(ctx, `⚠️ 处理失败: ${err.message}`);
    newSessionFlows.delete(chatId);
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
