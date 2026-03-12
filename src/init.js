#!/usr/bin/env node
/**
 * init.js — 初始化配置向导
 */

import { createInterface } from "readline";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { getProjectRoot } from "./config.js";

const PROJECT_ROOT = getProjectRoot();
const ENV_FILE = join(PROJECT_ROOT, ".env");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function waitForUserMessage(botToken) {
  const { Bot } = await import("grammy");
  const bot = new Bot(botToken);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      bot.stop();
      resolve(null);
    }, 60000); // 60秒超时

    bot.on("message", async (ctx) => {
      clearTimeout(timeout);
      bot.stop();

      const chatId = ctx.chat?.id?.toString();
      const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "未知用户";

      resolve({ chatId, username });
    });

    bot.catch((err) => {
      console.error("❌ Bot 错误:", err.message);
      clearTimeout(timeout);
      bot.stop();
      resolve(null);
    });

    bot.start();
  });
}

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("🔧 CC-Bridge 初始化配置");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  if (existsSync(ENV_FILE)) {
    const overwrite = await ask(rl, `⚠️  配置文件已存在 (${ENV_FILE})，是否覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== "y") {
      console.log("已取消");
      rl.close();
      return;
    }
  }

  console.log("步骤 1: 输入 Telegram Bot Token");
  console.log("   从 @BotFather (https://t.me/BotFather) 创建 Bot 获取");
  const botToken = await ask(rl, "   > ");
  if (!botToken) {
    console.log("❌ BOT_TOKEN 不能为空");
    rl.close();
    return;
  }

  console.log("");
  console.log("步骤 2: 绑定授权用户");
  console.log("");

  const chatIds = [];
  let addMore = true;

  while (addMore) {
    console.log(`   正在等待第 ${chatIds.length + 1} 个用户...`);
    console.log("   📱 请在 Telegram 中向 Bot 发送: /start");
    console.log("");

    const result = await waitForUserMessage(botToken);

    if (!result) {
      console.log("❌ 未能获取 Chat ID");
      if (chatIds.length === 0) {
        rl.close();
        return;
      }
      break;
    }

    const { chatId, username } = result;

    if (chatIds.includes(chatId)) {
      console.log(`   ⚠️  该用户已添加: ${username} (${chatId})`);
    } else {
      console.log(`   ✅ 已添加: ${username} (${chatId})`);
      chatIds.push(chatId);
    }

    console.log("");
    const more = await ask(rl, "   是否继续添加用户? (y/N): ");
    addMore = more.toLowerCase() === "y";
    console.log("");
  }

  if (chatIds.length === 0) {
    console.log("❌ 至少需要绑定一个 Chat ID");
    rl.close();
    return;
  }

  console.log(`   已绑定 ${chatIds.length} 个用户`);
  console.log("");

  mkdirSync(PROJECT_ROOT, { recursive: true });

  const envContent = [
    "# CC-Bridge 配置",
    `# 生成时间: ${new Date().toISOString()}`,
    "",
    `BOT_TOKEN=${botToken}`,
    `CHAT_IDS=${chatIds.join(",")}`,
    "",
  ].join("\n");

  writeFileSync(ENV_FILE, envContent, "utf-8");
  console.log(`✅ 配置已保存到 ${ENV_FILE}`);

  await configureHooks(rl);

  rl.close();

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎉 初始化完成！");
  console.log("");
  console.log("启动服务:");
  console.log("  npm run dev     # 开发模式");
  console.log("  npm start       # 生产模式");
  console.log("");
}

async function configureHooks(rl) {
  const projectRoot = getProjectRoot();
  const hookScript = join(projectRoot, "src", "hook.js");

  const command = `node ${hookScript}`;

  const hookConfig = {
    Notification: [
      {
        hooks: [
          {
            type: "command",
            command: `${command} Notification`,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `${command} Stop`,
          },
        ],
      },
    ],
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: `${command} SessionStart`,
          },
        ],
      },
    ],
  };

  console.log("");
  console.log("3. Claude Code Hooks 配置");
  console.log(`   目标文件: ${CLAUDE_SETTINGS}`);
  console.log("");
  console.log("   将写入以下 hooks:");
  console.log(`   Notification:  ${command} Notification`);
  console.log(`   Stop:          ${command} Stop`);
  console.log(`   SessionStart:  ${command} SessionStart`);
  console.log("");

  const confirm = await ask(rl, "   是否写入 Claude Code hooks 配置? (Y/n): ");
  if (confirm.toLowerCase() === "n") {
    console.log("");
    console.log("⏭  跳过 hooks 配置。你可以稍后手动配置 ~/.claude/settings.json");
    console.log("   参考 README.md 中的 'Claude Code Hooks 配置' 章节");
    return;
  }

  let settings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf-8"));
    } catch {
    }
  }

  const existingHooks = (settings.hooks || {});
  existingHooks.Notification = hookConfig.Notification;
  existingHooks.Stop = hookConfig.Stop;
  existingHooks.SessionStart = hookConfig.SessionStart;
  settings.hooks = existingHooks;

  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), "utf-8");
  console.log(`✅ Claude Code hooks 已配置到 ${CLAUDE_SETTINGS}`);
}

main().catch(console.error);
