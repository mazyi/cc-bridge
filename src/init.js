#!/usr/bin/env node
/**
 * init.js — 初始化配置向导 (多渠道版本)
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
import { config as loadDotenv } from "dotenv";
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

/**
 * 等待 Telegram 用户发送消息
 */
async function waitForTelegramUser(botToken) {
  const { Bot } = await import("grammy");
  const bot = new Bot(botToken);

  console.log("   正在连接 Telegram Bot...");

  // 打印 Bot 信息
  const me = await bot.api.getMe();
  console.log(`   Bot 名称: ${me.first_name} (@${me.username})`);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      bot.stop();
      console.log("   ⏰ 等待超时，未收到消息");
      resolve(null);
    }, 120000);

    bot.on("message", async (ctx) => {
      clearTimeout(timeout);
      bot.stop();
      const chatId = ctx.chat?.id?.toString();
      const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "未知用户";
      console.log("   ✅ 收到消息，已绑定用户");
      resolve({ id: chatId, username });
    });

    bot.catch((err) => {
      console.error("❌ Bot 错误:", err.message);
      clearTimeout(timeout);
      bot.stop();
      resolve(null);
    });

    console.log("   等待用户发送 /start ...");
    bot.start();
  });
}

/**
 * 等待飞书用户发送消息 (使用官方 SDK)
 */
async function waitForFeishuUser(appId, appSecret) {
  const lark = await import("@larksuiteoapi/node-sdk");
  const { WSClient, Domain, EventDispatcher, LoggerLevel } = lark;

  const wsClient = new WSClient({
    appId: appId,
    appSecret: appSecret,
    domain: Domain.Feishu,
    autoReconnect: true,
    loggerLevel: LoggerLevel.warn,
  });

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      try { wsClient.close(); } catch (e) {}
      resolve(null);
    }, 120000);

    try {
      // 创建事件分发器并注册消息处理
      const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn });
      eventDispatcher.register({
        "im.message.receive_v1": async (data) => {
          // 打印收到的完整消息
          console.log("");
          console.log("   📩 收到飞书消息:");
          console.log("   " + "-".repeat(40));
          console.log("   原始数据:", JSON.stringify(data, null, 2).replace(/\n/g, "\n   "));

          // SDK 传递的数据可能有两种格式：
          // 1. data.message (扁平结构)
          // 2. data.event.message (嵌套结构)
          const message = data.message || data.event?.message;

          if (message) {
            console.log("   消息ID:", message.message_id);
            console.log("   消息类型:", message.msg_type);
            console.log("   群/用户ID:", message.chat_id);
            console.log("   发送者:", data.sender?.sender_id || message.sender?.sender_id);

            let text = "";
            try {
              const parsed = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
              text = parsed.text || "";
              console.log("   消息内容:", text);
            } catch (e) { text = message.content; }

            console.log("   " + "-".repeat(40));

            const openId = data.sender?.sender_id?.open_id || message.sender?.id?.open_id;

            if (text && text.trim().startsWith("/start")) {
              clearTimeout(timeout);
              try { wsClient.close(); } catch (e) {}
              resolve({
                id: message.chat_id || openId,
                openId: openId,
                userId: data.sender?.sender_id?.user_id || message.sender?.id?.user_id,
                username: openId || "飞书用户",
                text,
              });
            }
          }
        },
      });

      // 启动连接，传入事件分发器
      await wsClient.start({ eventDispatcher });

    } catch (err) {
      console.error("❌ WebSocket 连接失败:", err.message);
      if (err.message?.includes("404") || err.message?.includes("not found")) {
        console.error("");
        console.error("   请确认已完成以下配置:");
        console.error("   1. 在飞书开放平台开启「使用长连接接收事件」功能");
        console.error("   2. 添加事件订阅: im.message.receive_v1");
        console.error("   3. 发布应用版本");
      }
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

/**
 * 配置 Telegram 渠道
 */
async function configureTelegram(rl) {
  console.log("");
  console.log("📱 配置 Telegram 渠道");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");

  console.log("步骤 1: 输入 Telegram Bot Token");
  const botToken = await ask(rl, "   > ");
  if (!botToken) {
    console.log("❌ BOT_TOKEN 不能为空");
    return null;
  }

  console.log("");
  console.log("步骤 2: 绑定授权用户");

  const chatIds = [];
  let addMore = true;

  while (addMore) {
    console.log(`   正在等待第 ${chatIds.length + 1} 个用户...`);
    console.log("   📱 请在 Telegram 中向 Bot 发送: /start");

    const result = await waitForTelegramUser(botToken);

    if (!result) {
      console.log("❌ 未能获取 Chat ID (超时)");
      if (chatIds.length === 0) return null;
      break;
    }

    const { id, username } = result;
    if (chatIds.includes(id)) {
      console.log(`   ⚠️  该用户已添加: ${username} (${id})`);
    } else {
      console.log(`   ✅ 已添加: ${username} (${id})`);
      chatIds.push(id);
    }

    console.log("");
    const more = await ask(rl, "   是否继续添加用户? (y/N): ");
    addMore = more.toLowerCase() === "y";
  }

  if (chatIds.length === 0) {
    console.log("❌ 至少需要绑定一个 Chat ID");
    return null;
  }

  console.log(`   已绑定 ${chatIds.length} 个用户`);
  return { type: "telegram", config: { botToken, chatIds } };
}

/**
 * 配置飞书渠道
 */
async function configureFeishu(rl) {
  console.log("");
  console.log("🦜 配置飞书渠道 (使用官方 SDK)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const appId = await ask(rl, "\n   App ID: ");
  if (!appId) { console.log("❌ App ID 不能为空"); return null; }

  const appSecret = await ask(rl, "   App Secret: ");
  if (!appSecret) { console.log("❌ App Secret 不能为空"); return null; }

  console.log("");
  console.log("步骤 2: 绑定授权用户/群");
  console.log("   ⚠️  请确保已开启「使用长连接接收事件」");

  const receiveIds = [];
  let addMore = true;

  while (addMore) {
    console.log(`   正在等待第 ${receiveIds.length + 1} 个用户/群...`);
    console.log("   📱 请在飞书中向机器人发送: /start");

    const result = await waitForFeishuUser(appId, appSecret);

    if (!result) {
      console.log("❌ 未能获取 Receive ID");
      if (receiveIds.length === 0) return null;
    } else {
      const { id, openId } = result;
      const rid = id || openId;
      if (receiveIds.includes(rid)) {
        console.log(`   ⚠️  该用户/群已添加: ${rid}`);
      } else {
        console.log(`   ✅ 已添加: ${rid}`);
        receiveIds.push(rid);
      }
    }

    console.log("");
    const more = await ask(rl, "   是否继续添加? (y/N): ");
    addMore = more.toLowerCase() === "y";
  }

  if (receiveIds.length === 0) return null;
  console.log(`   已绑定 ${receiveIds.length} 个用户/群`);

  return { type: "feishu", config: { appId, appSecret, receiveIds } };
}

/**
 * 配置 Hooks
 */
async function configureHooks(rl) {
  const projectRoot = getProjectRoot();
  const hookScript = join(projectRoot, "src", "hook.js");
  const command = `node ${hookScript}`;

  console.log("");
  console.log("🔧 Claude Code Hooks 配置");
  console.log(`   目标文件: ${CLAUDE_SETTINGS}`);

  const confirm = await ask(rl, "\n   是否写入? (Y/n): ");
  if (confirm.toLowerCase() === "n") return;

  let settings = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf-8")); } catch {}
  }

  const hookConfig = {
    Notification: [{ hooks: [{ type: "command", command: `${command} Notification` }] }],
    Stop: [{ hooks: [{ type: "command", command: `${command} Stop` }] }],
    SessionStart: [{ hooks: [{ type: "command", command: `${command} SessionStart` }] }],
  };

  settings.hooks = hookConfig;
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`✅ Claude Code hooks 已配置`);
}

/**
 * 加载现有渠道配置
 */
function loadExistingChannels() {
  const channels = [];
  const content = readFileSync(ENV_FILE, "utf-8");
  const lines = content.split("\n");

  // 解析 CHANNELS
  let channelsLine = "";
  for (const line of lines) {
    if (line.startsWith("CHANNELS=")) {
      channelsLine = line.split("=")[1].trim();
      break;
    }
  }

  // 如果没有 CHANNELS，检查旧格式
  if (!channelsLine) {
    const botToken = process.env.BOT_TOKEN;
    const chatIds = process.env.CHAT_IDS;
    if (botToken && chatIds) {
      channels.push({
        type: "telegram",
        config: { botToken, chatIds: chatIds.split(",") }
      });
    }
    return channels;
  }

  // 解析多渠道配置
  const types = channelsLine.split(",").map(t => t.trim());

  for (const type of types) {
    const prefix = type.toUpperCase();
    if (type === "telegram") {
      const botToken = process.env[`${prefix}_BOT_TOKEN`];
      const chatIdsStr = process.env[`${prefix}_CHAT_IDS`];
      if (botToken && chatIdsStr) {
        channels.push({
          type,
          config: { botToken, chatIds: chatIdsStr.split(",") }
        });
      }
    } else if (type === "feishu") {
      const appId = process.env[`${prefix}_APP_ID`];
      const appSecret = process.env[`${prefix}_APP_SECRET`];
      const receiveIdsStr = process.env[`${prefix}_RECEIVE_IDS`];
      if (appId && appSecret && receiveIdsStr) {
        channels.push({
          type,
          config: { appId, appSecret, receiveIds: receiveIdsStr.split(",") }
        });
      }
    }
  }

  return channels;
}

/**
 * 生成 .env 内容
 */
function generateEnvContent(channels) {
  const lines = ["# CC-Bridge 配置", `# 生成时间: ${new Date().toISOString()}`, ""];

  if (channels.length === 1 && channels[0].type === "telegram") {
    lines.push(`BOT_TOKEN=${channels[0].config.botToken}`);
    lines.push(`CHAT_IDS=${channels[0].config.chatIds.join(",")}`);
    return lines.join("\n") + "\n";
  }

  lines.push(`CHANNELS=${channels.map(c => c.type).join(",")}`);
  for (const ch of channels) {
    lines.push(`# ${ch.type} 配置`);
    if (ch.type === "telegram") {
      lines.push(`TELEGRAM_BOT_TOKEN=${ch.config.botToken}`);
      lines.push(`TELEGRAM_CHAT_IDS=${ch.config.chatIds.join(",")}`);
    } else if (ch.type === "feishu") {
      lines.push(`FEISHU_APP_ID=${ch.config.appId}`);
      lines.push(`FEISHU_APP_SECRET=${ch.config.appSecret}`);
      lines.push(`FEISHU_RECEIVE_IDS=${ch.config.receiveIds.join(",")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log("🔧 CC-Bridge 初始化配置");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");

  let existingChannels = [];
  if (existsSync(ENV_FILE)) {
    console.log("⚠️  发现现有配置文件");
    const action = await ask(rl, "   [1] 覆盖  [2] 添加  [3] 取消: ");
    if (action === "3" || !action) { console.log("已取消"); rl.close(); process.exit(0); return; }
    if (action === "1") {
      existingChannels = [];
    } else if (action === "2") {
      // 加载现有配置
      loadDotenv({ path: ENV_FILE });
      existingChannels = loadExistingChannels();
    }
  }

  const channels = [...existingChannels];

  while (true) {
    console.log("");
    console.log("📱 选择渠道: [1] Telegram  [2] 飞书  [3] 完成");
    if (channels.length > 0) console.log(`   已配置: ${channels.map(c => c.type).join(", ")}`);
    const choice = await ask(rl, "   > ");
    if (choice === "3" || !choice) { if (channels.length === 0) continue; break; }

    let ch;
    if (choice === "1") ch = await configureTelegram(rl);
    else if (choice === "2") ch = await configureFeishu(rl);
    if (ch) channels.push(ch);
  }

  mkdirSync(PROJECT_ROOT, { recursive: true });
  writeFileSync(ENV_FILE, generateEnvContent(channels));
  console.log(`\n✅ 配置已保存到 ${ENV_FILE}`);

  await configureHooks(rl);
  rl.close();

  console.log("\n🎉 初始化完成！\n启动: npm start\n");

  // 确保进程退出
  process.exit(0);
}

main().catch(console.error);
