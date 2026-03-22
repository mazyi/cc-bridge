/**
 * 命令处理器 - 与渠道无关的命令逻辑
 */

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
  getActiveChannel,
  setActiveChannel,
} from "./session.js";
import {
  createTmuxSession,
  tmuxSendKeys,
  tmuxCapture,
  killTmuxSession,
  checkTmux,
  tmuxSessionExists,
  tmuxSendSpecialKey,
  waitForScreenContent,
} from "./tmux.js";
import { parseRecentConversations } from "./transcript.js";
import { homedir } from "os";
import { join } from "path";
import { MessageFormatter, escapeHtml } from "./channels/index.js";

// 新会话流程状态
const newSessionFlows = new Map();

// 待确认关闭的会话
const pendingCloseConfirm = new Map();

// 渠道选择流程状态
const channelFlows = new Map();

// 存储 ChannelManager 引用
let channelManagerRef = null;

/**
 * 注册所有命令到 ChannelManager
 */
export function registerCommands(channelManager) {
  channelManagerRef = channelManager;

  channelManager.onCommand("start", handleStart);
  channelManager.onCommand("new", handleNew);
  channelManager.onCommand("list", handleList);
  channelManager.onCommand("ls", handleList);
  channelManager.onCommand("switch", handleSwitch);
  channelManager.onCommand("s", handleSwitch);
  channelManager.onCommand("close", handleClose);
  channelManager.onCommand("status", handleStatus);
  channelManager.onCommand("capture", handleCapture);
  channelManager.onCommand("history", handleHistory);
  channelManager.onCommand("all_history", handleAllHistory);
  channelManager.onCommand("channel", handleChannel);
  channelManager.onCommand("ch", handleChannel);

  // 回调查询处理器（飞书等渠道可能需要）
  channelManager.onCallback("channel:", handleChannelCallback);

  // 消息处理器
  channelManager.onMessage(handleMessage);
}

// ========== 命令处理器 ==========

async function handleStart(ctx) {
  const activeChannel = getActiveChannel();
  const channelInfo = activeChannel ? `当前渠道: ${activeChannel}` : "未设置活跃渠道";

  await ctx.reply(
    "🤖 <b>CC-Bridge</b> — 多渠道 Claude Code 控制台\n\n" +
      "命令列表:\n" +
      "/new [claude_session_id] — 创建新会话\n" +
      "/list — 列出所有会话\n" +
      "/switch <id> — 切换活跃会话\n" +
      "/channel — 切换活跃渠道\n" +
      "/close <id> — 关闭会话\n" +
      "/status — 当前状态\n" +
      "/capture — 捕获当前会话屏幕\n" +
      "/history [count] — 查看最近用户命令 (默认3条)\n" +
      "/all_history [count] — 查看最近完整对话 (默认3条)\n\n" +
      `📍 ${channelInfo}\n\n` +
      "💡 直接发送文本会注入到当前活跃会话中（仅活跃渠道）。",
    { parse_mode: "HTML" }
  );
}

async function handleNew(ctx) {
  const chatId = ctx.chatId;
  if (!chatId) {
    await ctx.reply("❌ 无法获取 chatId");
    return;
  }

  const claudeSessionId = ctx.match?.trim();

  if (claudeSessionId) {
    newSessionFlows.set(chatId, { step: "path", claudeSessionId });
    await ctx.reply(
      `🔗 使用 Claude Session ID: <code>${claudeSessionId}</code>\n\n📁 请输入项目路径（绝对路径）:`,
      { parse_mode: "HTML" }
    );
  } else {
    newSessionFlows.set(chatId, { step: "path" });
    await ctx.reply("📁 请输入项目路径（绝对路径）:");
  }
}

async function handleList(ctx) {
  syncSessionStates();
  const sessions = listAllSessions();
  const state = loadState();

  if (sessions.length === 0) {
    await ctx.reply("📋 没有会话。发送 /new 创建一个。");
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

  await ctx.reply(
    `📋 <b>会话列表</b> (共 ${sessions.length} 个)\n━━━━━━━━━━\n${lines.join("\n\n")}\n━━━━━━━━━━\n当前: #${state.activeSessionId || "无"}\n\n💡 使用 /close {序号} 关闭会话`,
    { parse_mode: "HTML" }
  );
}

async function handleSwitch(ctx) {
  const idStr = ctx.match;
  if (!idStr) {
    await ctx.reply("用法: /switch <id> 或 /s <id>\n例如: /s 2");
    return;
  }
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await ctx.reply("❌ 无效的 ID");
    return;
  }

  syncSessionStates();
  if (setActiveSession(id)) {
    const session = listActiveSessions().find((s) => s.id === id);
    const name = session?.name ? ` [${session.name}]` : "";
    await ctx.reply(`✅ 已切换到会话 #${id}${name}`);
  } else {
    await ctx.reply(`❌ 会话 #${id} 不存在或已关闭`);
  }
}

async function handleClose(ctx) {
  const idStr = ctx.match;
  let id;

  if (!idStr) {
    syncSessionStates();
    const session = getActiveSession();
    if (!session) {
      await ctx.reply("❌ 没有活跃会话。请使用 /close <id> 指定要关闭的会话。");
      return;
    }
    id = session.id;
  } else {
    id = parseInt(idStr, 10);
    if (isNaN(id)) {
      await ctx.reply("❌ 无效的 ID");
      return;
    }
  }

  const sessions = listAllSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    await ctx.reply(`❌ 会话 #${id} 不存在`);
    return;
  }

  // 文本确认
  const name = session.name ? ` ${session.name}` : "";
  await ctx.reply(
    `⚠️ 确认要关闭会话吗？\n\n#${id}${name}\n📁 ${session.projectPath}\n\n` +
    `请回复 "y" 确认关闭，或 "n" 取消`
  );

  // 设置待确认状态，等待用户回复
  pendingCloseConfirm.set(chatId, id);
}

async function handleStatus(ctx) {
  syncSessionStates();
  const session = getActiveSession();
  const activeChannel = getActiveChannel();

  let message = "📊 <b>当前状态</b>\n━━━━━━━━━━\n";

  // 显示活跃渠道
  message += `📡 活跃渠道: ${activeChannel || "未设置"}\n\n`;

  if (!session) {
    message += "❌ 没有活跃会话。发送 /new 创建。";
    await ctx.reply(message, { parse_mode: "HTML" });
    return;
  }

  const name = session.name ? `[${session.name}]` : "";
  const tmuxAlive = tmuxSessionExists(session.tmuxName) ? "✅" : "❌";

  // 状态中文映射
  const statusMap = {
    starting: "启动中",
    active: "活跃",
    idle: "空闲",
    stopped: "已停止",
  };
  const statusText = statusMap[session.status] || session.status;

  message +=
    `📊 <b>会话 #${session.id} ${name}</b>\n` +
    `📁 路径: <code>${session.projectPath}</code>\n` +
    `🔐 权限: ${session.permissionMode === "auto" ? "无确认" : "需确认"}\n` +
    `📡 状态: ${statusText}\n` +
    `🖥 tmux: ${session.tmuxName} ${tmuxAlive}\n` +
    `🕐 创建: ${session.createdAt}`;

  await ctx.reply(message, { parse_mode: "HTML" });
}

async function handleChannel(ctx) {
  const chatId = ctx.chatId;

  if (!channelManagerRef) {
    await ctx.reply("❌ 渠道管理器未初始化");
    return;
  }

  const channels = channelManagerRef.getAllChannels();
  if (channels.length === 0) {
    await ctx.reply("❌ 没有可用的渠道");
    return;
  }

  const activeChannel = getActiveChannel();

  // 如果提供了渠道参数，直接切换
  const channelArg = ctx.match?.trim();
  if (channelArg) {
    const targetChannel = channels.find(c => c.type === channelArg);
    if (!targetChannel) {
      const channelNames = channels.map(c => c.type).join(", ");
      await ctx.reply(`❌ 渠道 "${channelArg}" 不存在\n可用渠道: ${channelNames}`);
      return;
    }
    setActiveChannel(channelArg);
    console.log(`[Command] 渠道切换到: ${channelArg}`);
    await ctx.reply(`✅ 已切换到渠道: ${channelArg}`);
    return;
  }

  // 如果只有一个渠道，直接切换
  if (channels.length === 1) {
    setActiveChannel(channels[0].type);
    await ctx.reply(`✅ 已切换到渠道: ${channels[0].type}`);
    return;
  }

  // 通用文本菜单
  const channelList = channels.map((c, i) => {
    const isActive = c.type === activeChannel;
    return `${i + 1}. ${isActive ? "✓ " : "  "}${c.type}`;
  }).join("\n");

  // 设置选择状态
  channelFlows.set(chatId, { channels });

  await ctx.reply(
    `📡 选择活跃渠道:\n\n${channelList}\n\n` +
    `当前: ${activeChannel || "未设置"}\n\n` +
    `回复数字选择渠道，或使用 /channel <渠道名> 直接切换\n` +
    `例如: /channel telegram`
  );
}

async function handleCapture(ctx) {
  const session = getActiveSession();
  if (!session) {
    await ctx.reply("❌ 没有活跃会话");
    return;
  }

  const output = tmuxCapture(session.tmuxName, 80);
  if (!output) {
    await ctx.reply("❌ 无法捕获屏幕内容");
    return;
  }

  const truncated = output.length > 3900 ? output.slice(-3900) : output;
  await ctx.reply(`🖥 <b>#${session.id} 屏幕:</b>\n<pre>${escapeHtml(truncated)}</pre>`, {
    parse_mode: "HTML",
  });
}

async function handleHistory(ctx) {
  await handleHistoryInternal(ctx, false);
}

async function handleAllHistory(ctx) {
  await handleHistoryInternal(ctx, true);
}

async function handleHistoryInternal(ctx, includeAssistant) {
  const session = getActiveSession();
  if (!session) {
    await ctx.reply("❌ 没有活跃会话");
    return;
  }

  if (!session.claudeSessionId) {
    await ctx.reply("❌ 当前会话没有关联的 Claude Session ID");
    return;
  }

  const countStr = ctx.match?.trim();
  const count = countStr ? parseInt(countStr, 10) : 3;
  if (isNaN(count) || count < 1 || count > 10) {
    await ctx.reply("❌ 无效的数量，请输入 1-10 之间的数字");
    return;
  }

  const projectPathEncoded = session.projectPath
    .replace(/^\//, '')
    .replace(/\//g, '-');

  const transcriptPath = join(
    homedir(),
    ".claude",
    "projects",
    `-${projectPathEncoded}`,
    `${session.claudeSessionId}.jsonl`
  );

  const conversations = parseRecentConversations(transcriptPath, count, includeAssistant);

  if (!conversations || conversations.length === 0) {
    await ctx.reply(
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

  conversations.sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return timeA - timeB;
  });

  const entries = [];
  for (const conv of conversations) {
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
        // ignore
      }
    }

    const MAX_SINGLE_ENTRY = 3500;
    let entry = `${localTimeStr}: ${conv.user}\n\n`;

    if (includeAssistant && conv.assistant) {
      entry += `${conv.assistant}\n\n`;
    }

    if (entry.length > MAX_SINGLE_ENTRY) {
      const truncated = entry.slice(0, MAX_SINGLE_ENTRY - 50) + "\n\n... (内容过长，已截断)";
      entries.push(truncated);
    } else {
      entries.push(entry);
    }
  }

  const MAX_MESSAGE_LENGTH = 3900;
  const header = `💬 ${sessionLabel} 最近 ${conversations.length} 条${title}:\n\n`;

  let currentBatch = header;
  let batchCount = 0;

  for (const entry of entries) {
    if (currentBatch.length + entry.length > MAX_MESSAGE_LENGTH) {
      if (currentBatch.length > header.length) {
        await ctx.reply(currentBatch);
        batchCount++;
      }
      currentBatch = header + entry;
    } else {
      currentBatch += entry;
    }
  }

  if (currentBatch.length > header.length) {
    await ctx.reply(currentBatch);
    batchCount++;
  }

  if (batchCount === 0) {
    await ctx.reply("❌ 没有可显示的对话内容");
  }
}

// ========== 消息处理器 ==========

async function handleMessage(text, ctx) {
  const chatId = ctx.chatId;
  const flow = newSessionFlows.get(chatId);
  if (flow) {
    await handleNewSessionFlow(ctx, flow, text, chatId);
    return;
  }

  // 检查是否在等待渠道选择
  const channelFlow = channelFlows.get(chatId);
  if (channelFlow) {
    channelFlows.delete(chatId);
    const choice = parseInt(text.trim(), 10);
    const channels = channelFlow.channels;

    if (isNaN(choice) || choice < 1 || choice > channels.length) {
      await ctx.reply("❌ 请回复有效的数字");
      return;
    }

    const selectedChannel = channels[choice - 1];
    setActiveChannel(selectedChannel.type);
    console.log(`[Command] 渠道切换到: ${selectedChannel.type}`);
    await ctx.reply(`✅ 已切换到渠道: ${selectedChannel.type}`);
    return;
  }

  // 检查是否在等待关闭确认
  const pendingId = pendingCloseConfirm.get(chatId);
  if (pendingId !== undefined) {
    pendingCloseConfirm.delete(chatId);
    const sessions = listAllSessions();
    const session = sessions.find((s) => s.id === pendingId);

    const choice = text.trim().toLowerCase();
    if (choice === "y" || choice === "yes" || choice === "是") {
      if (session) {
        if (tmuxSessionExists(session.tmuxName)) {
          killTmuxSession(session.tmuxName);
        }
        closeSession(pendingId);
        await ctx.reply(`✅ 会话 #${pendingId} 已关闭`);
      } else {
        await ctx.reply(`❌ 会话 #${pendingId} 不存在或已被关闭`);
      }
    } else if (choice === "n" || choice === "no" || choice === "否") {
      await ctx.reply("已取消关闭");
    } else {
      await ctx.reply("❌ 请回复 y/n 或 n/否");
    }
    return;
  }

  // 检查是否是活跃渠道
  const activeChannel = getActiveChannel();
  const currentChannel = ctx.channelType;

  // 如果设置了活跃渠道，且当前渠道不是活跃渠道，提示用户
  // 注意：命令通过 bot.command() 单独处理，不会走这个函数
  if (activeChannel && currentChannel !== activeChannel) {
    await ctx.reply(`📢 当前活跃渠道是 <b>${activeChannel}</b>，请在该渠道发送消息。\n\n使用 /channel 切换渠道。`, { parse_mode: "HTML" });
    return;
  }

  syncSessionStates();
  const session = getActiveSession();
  if (!session) {
    await ctx.reply("❌ 没有活跃会话。发送 /new 创建或 /list 查看。");
    return;
  }

  if (!tmuxSessionExists(session.tmuxName)) {
    await ctx.reply(`❌ tmux session "${session.tmuxName}" 已失效`);
    updateSession(session.id, { status: "stopped" });
    return;
  }

  try {
    const trimmedText = text.trim().toLowerCase();
    if (trimmedText.length === 1 && /^[yan]$/.test(trimmedText)) {
      const optionCount = session.lastPermissionOptionCount || 3;

      if (trimmedText === 'y') {
        tmuxSendSpecialKey(session.tmuxName, "Enter");
      } else if (trimmedText === 'a') {
        tmuxSendSpecialKey(session.tmuxName, "Down");
        await new Promise(resolve => setTimeout(resolve, 100));
        tmuxSendSpecialKey(session.tmuxName, "Enter");
      } else if (trimmedText === 'n') {
        if (optionCount === 2) {
          tmuxSendSpecialKey(session.tmuxName, "Down");
          await new Promise(resolve => setTimeout(resolve, 100));
          tmuxSendSpecialKey(session.tmuxName, "Enter");
        } else {
          tmuxSendSpecialKey(session.tmuxName, "Down");
          await new Promise(resolve => setTimeout(resolve, 100));
          tmuxSendSpecialKey(session.tmuxName, "Down");
          await new Promise(resolve => setTimeout(resolve, 100));
          tmuxSendSpecialKey(session.tmuxName, "Enter");
        }
      }
    } else {
      tmuxSendKeys(session.tmuxName, text);
    }

    updateSession(session.id, {
      status: "active",
      lastActivityAt: new Date().toISOString(),
    });
    await ctx.reply(`➡️ #${session.id} ✓`);
  } catch (err) {
    await ctx.reply(`❌ 发送失败: ${err.message}`);
  }
}

// ========== 回调处理器 ==========

async function handleChannelCallback(data, ctx) {
  const channelType = data.split(":")[1];

  if (!channelType) {
    await ctx.answerCallback?.("无效的渠道");
    return;
  }

  // 检查渠道是否存在
  if (channelManagerRef) {
    const channel = channelManagerRef.getChannel(channelType);
    if (!channel) {
      await ctx.answerCallback?.("渠道不存在");
      return;
    }
  }

  setActiveChannel(channelType);
  console.log(`[Command] 渠道切换到: ${channelType}`);
  await ctx.answerCallback?.(`已切换到 ${channelType}`);
  await ctx.editMessage?.(`✅ 活跃渠道已切换为: ${channelType}\n\n💡 Hook 消息将只发送到此渠道`);
}

// ========== 新会话流程 ==========

async function handleNewSessionFlow(ctx, flow, text, chatId) {
  try {
    switch (flow.step) {
      case "path": {
        const projectPath = text.trim();
        if (!projectPath.startsWith("/") && !projectPath.startsWith("~")) {
          await ctx.reply("❌ 请输入绝对路径（以 / 或 ~ 开头）");
          return;
        }
        flow.projectPath = projectPath;
        flow.step = "permission";

        // 通用文本菜单选择
        await ctx.reply(
          "🔐 选择权限模式:\n\n" +
          "1. 🔓 自动确认 (跳过权限提示)\n" +
          "2. 🔐 每次确认 (需要你确认)\n\n" +
          "请回复 1 或 2"
        );
        break;
      }

      case "permission": {
        const choice = text.trim();
        if (choice === "1") {
          flow.permissionMode = "auto";
        } else if (choice === "2") {
          flow.permissionMode = "confirm";
        } else {
          await ctx.reply("❌ 请回复 1 或 2");
          return;
        }
        flow.step = "name";
        await ctx.reply("📝 请输入会话名 (可选，发送 - 跳过):");
        break;
      }

      case "name": {
        const name = text.trim() === "-" ? undefined : text.trim();

        if (!checkTmux()) {
          await ctx.reply("❌ tmux 未安装，请先安装 tmux");
          newSessionFlows.delete(chatId);
          return;
        }

        const claudeSessionId = flow.claudeSessionId || crypto.randomUUID();
        const session = createSession(flow.projectPath, flow.permissionMode, name, claudeSessionId);

        try {
          const nameText = name ? ` [${name}]` : "";
          await ctx.reply(
            `⏳ <b>${session.id}${nameText}</b> 会话启动中...\n\n` +
            `📁 路径: <code>${session.projectPath}</code>\n` +
            `🔐 权限: ${session.permissionMode === "auto" ? "无确认" : "需确认"}\n` +
            `🖥 tmux: ${session.tmuxName}\n` +
            `🔗 Claude Session ID:\n<code>${claudeSessionId}</code>`,
            { parse_mode: "HTML" }
          );

          createTmuxSession(session.tmuxName, session.projectPath, session.permissionMode, claudeSessionId);

          // 等待 Claude 初始化并检查权限提示（仅 auto 模式）
          if (session.permissionMode === "auto") {
            // 等待权限提示出现，最多 15 秒
            const permissionPatterns = [
              /Would you like to proceed\?/i,
              /allow.*access/i,
              /permission/i,
              /确认.*权限/i,
              /允许.*访问/i,
            ];

            let detected = false;
            for (const pattern of permissionPatterns) {
              const found = await waitForScreenContent(session.tmuxName, pattern, 15000);
              if (found) {
                detected = true;
                // 发送 Down+Enter 选择"始终允许"
                tmuxSendSpecialKey(session.tmuxName, "Down");
                await new Promise(resolve => setTimeout(resolve, 300));
                tmuxSendSpecialKey(session.tmuxName, "Enter");
                await new Promise(resolve => setTimeout(resolve, 1000));
                break;
              }
            }

            // 如果15秒内没检测到权限提示，直接继续（可能没有权限提示或已自动跳过）
            if (!detected) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          } else {
            // confirm 模式：给更多时间让用户手动处理
            await new Promise(resolve => setTimeout(resolve, 4000));
          }

          // 发送 Enter 激活 Claude 会话
          tmuxSendSpecialKey(session.tmuxName, "Enter");
          await new Promise(resolve => setTimeout(resolve, 500));

          updateSession(session.id, { status: "active" });
        } catch (err) {
          await ctx.reply(`❌ 创建失败: ${err.message}`);
          closeSession(session.id);
        }

        newSessionFlows.delete(chatId);
        break;
      }
    }
  } catch (err) {
    console.error("❌ 处理新会话流程错误:", err);
    await ctx.reply(`⚠️ 处理失败: ${err.message}`);
    newSessionFlows.delete(chatId);
  }
}
