#!/usr/bin/env node
/**
 * index.js — CC-Bridge 入口
 *
 * 启动 Telegram Bot，监听消息并路由到 Claude Code tmux sessions。
 */

import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { syncSessionStates, listActiveSessions } from "./session.js";
import { checkTmux } from "./tmux.js";

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
  console.log(`📡 Chat IDs: ${config.chatIds.join(", ")}`);
  console.log(`📋 活跃会话: ${sessions.length} 个`);
  if (sessions.length > 0) {
    for (const s of sessions) {
      const name = s.name ? `[${s.name}]` : "";
      console.log(`   #${s.id} ${name} ${s.projectPath} (${s.status})`);
    }
  }
  console.log("");

  const bot = createBot(config);

  // 全局错误处理器 - 捕获所有 bot 内部错误
  bot.catch((err) => {
    const error = err.error;
    console.error("❌ Bot 错误:", error);

    // 尝试通知用户（如果有上下文）
    if (err.ctx) {
      err.ctx.reply("⚠️ 处理请求时发生错误，请稍后重试").catch((replyErr) => {
        console.error("❌ 发送错误通知失败:", replyErr);
      });
    }
  });

  const shutdown = () => {
    console.log("\n🛑 正在关闭...");
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 捕获未处理的 Promise 拒绝
  process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ 未处理的 Promise 拒绝:", reason);
    console.error("   Promise:", promise);
  });

  // 捕获未捕获的异常
  process.on("uncaughtException", (error) => {
    console.error("❌ 未捕获的异常:", error);
    console.error("   Bot 将继续运行，但建议检查日志");
  });

  console.log("🤖 Telegram Bot 已启动，等待消息...");
  console.log("   按 Ctrl+C 退出");
  console.log("");

  bot.start({
    onStart: () => {
      console.log("✅ Bot 连接成功");
    },
  });
}

main().catch((err) => {
  console.error("❌ 启动失败:", err);
  process.exit(1);
});
