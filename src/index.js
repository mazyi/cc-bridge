#!/usr/bin/env node
/**
 * index.js — CC-Bridge 入口 (多渠道版本)
 *
 * 启动所有配置的渠道 Bot，监听消息并路由到 Claude Code tmux sessions。
 */

import { loadConfig } from "./config.js";
import { syncSessionStates, listActiveSessions } from "./session.js";
import { checkTmux } from "./tmux.js";
import { ChannelManager, getChannelManager } from "./channels/manager.js";
import { registerCommands } from "./commands.js";

let channelManager = null;

async function main() {
  console.log("🚀 CC-Bridge 启动中...");
  console.log("");

  if (!checkTmux()) {
    console.error("❌ tmux 未安装，请先安装:");
    console.error("   macOS: brew install tmux");
    console.error("   Linux: apt install tmux / yum install tmux");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`❌ ${(err).message}`);
    process.exit(1);
  }

  syncSessionStates();
  const sessions = listActiveSessions();

  console.log(`✅ 配置加载成功`);
  console.log(`📡 渠道: ${config.channels.map(c => c.type).join(", ")}`);
  if (config.chatIds) {
    console.log(`📡 Chat IDs: ${config.chatIds.join(", ")}`);
  }
  console.log(`📋 活跃会话: ${sessions.length} 个`);
  if (sessions.length > 0) {
    for (const s of sessions) {
      const name = s.name ? `[${s.name}]` : "";
      console.log(`   #${s.id} ${name} ${s.projectPath} (${s.status})`);
    }
  }
  console.log("");

  // 初始化渠道管理器
  channelManager = getChannelManager();
  channelManager.initializeFromConfig(config);

  // 注册命令和消息处理器
  registerCommands(channelManager);

  // 全局错误处理器
  channelManager.onError((err, context) => {
    console.error("❌ 渠道错误:", err);
    if (context?.ctx?.reply) {
      context.ctx.reply("⚠️ 处理请求时发生错误，请稍后重试").catch((replyErr) => {
        console.error("❌ 发送错误通知失败:", replyErr);
      });
    }
  });

  // 启动所有渠道
  await channelManager.startAll();

  const shutdown = async () => {
    console.log("\n🛑 正在关闭...");
    await channelManager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ 未处理的 Promise 拒绝:", reason);
    console.error("   Promise:", promise);
  });

  process.on("uncaughtException", (error) => {
    console.error("❌ 未捕获的异常:", error);
    console.error("   Bot 将继续运行，但建议检查日志");
  });

  console.log("🤖 CC-Bridge 已启动，等待消息...");
  console.log("   按 Ctrl+C 退出");
  console.log("");
}

main().catch(async (err) => {
  console.error("❌ 启动失败:", err);
  if (channelManager) {
    try {
      await channelManager.stopAll();
    } catch {
      // ignore
    }
  }
  process.exit(1);
});

// 导出供 hook 使用
export { getChannelManager };
