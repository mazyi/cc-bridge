import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadDotenv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const ENV_FILE = join(PROJECT_ROOT, ".env");

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function getConfigDir() {
  return PROJECT_ROOT;
}

export function getSessionsPath() {
  return join(PROJECT_ROOT, "sessions.json");
}

/**
 * 加载多渠道配置
 *
 * 配置格式:
 * - 单个 Telegram 渠道（向后兼容）: BOT_TOKEN + CHAT_IDS
 * - 多渠道: CHANNELS=telegram,another; TELEGRAM_BOT_TOKEN=..., TELEGRAM_CHAT_IDS=...
 */
export function loadConfig() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `配置文件 (.env) 不存在: ${ENV_FILE}\n请先运行: npm run init`
    );
  }

  loadDotenv({ path: ENV_FILE });

  // 尝试加载多渠道配置
  const channelConfigs = loadChannelConfigs();

  if (channelConfigs.length > 0) {
    return {
      channels: channelConfigs,
      configDir: PROJECT_ROOT,
    };
  }

  // 向后兼容：加载旧的单 Telegram 渠道配置
  return loadLegacyConfig();
}

/**
 * 加载旧版单渠道配置（向后兼容）
 */
function loadLegacyConfig() {
  const botToken = process.env.BOT_TOKEN;
  const chatIds = process.env.CHAT_IDS;

  if (!botToken || botToken === "your_bot_token_here") {
    throw new Error("BOT_TOKEN 未配置，请先运行: npm run init");
  }
  if (!chatIds) {
    throw new Error("CHAT_IDS 未配置，请先运行: npm run init");
  }

  // 解析逗号分隔的 chat IDs
  const chatIdArray = chatIds.split(",").map(id => id.trim()).filter(id => id);

  if (chatIdArray.length === 0) {
    throw new Error("CHAT_IDS 为空，请先运行: npm run init");
  }

  return {
    channels: [
      {
        type: "telegram",
        config: {
          botToken,
          chatIds: chatIdArray,
        },
      },
    ],
    // 保留旧字段用于向后兼容
    botToken,
    chatIds: chatIdArray,
    configDir: PROJECT_ROOT,
  };
}

/**
 * 加载多渠道配置
 */
function loadChannelConfigs() {
  const channelsEnv = process.env.CHANNELS;
  if (!channelsEnv) {
    return [];
  }

  const channelTypes = channelsEnv.split(",").map(t => t.trim().toLowerCase()).filter(t => t);
  const configs = [];

  for (const type of channelTypes) {
    const prefix = type.toUpperCase();

    switch (type) {
      case "telegram": {
        const botToken = process.env[`${prefix}_BOT_TOKEN`];
        const chatIdsStr = process.env[`${prefix}_CHAT_IDS`];
        if (!botToken || !chatIdsStr) {
          console.warn(`[Config] 跳过 ${type} 渠道：缺少 ${prefix}_BOT_TOKEN 或 ${prefix}_CHAT_IDS`);
          continue;
        }
        const chatIds = chatIdsStr.split(",").map(id => id.trim()).filter(id => id);
        configs.push({
          type,
          config: { botToken, chatIds },
        });
        break;
      }
      case "feishu": {
        const appId = process.env[`${prefix}_APP_ID`];
        const appSecret = process.env[`${prefix}_APP_SECRET`];
        const receiveIdsStr = process.env[`${prefix}_RECEIVE_IDS`];
        if (!appId || !appSecret || !receiveIdsStr) {
          console.warn(`[Config] 跳过 ${type} 渠道：缺少 ${prefix}_APP_ID, ${prefix}_APP_SECRET 或 ${prefix}_RECEIVE_IDS`);
          continue;
        }
        const receiveIds = receiveIdsStr.split(",").map(id => id.trim()).filter(id => id);
        configs.push({
          type,
          config: { appId, appSecret, receiveIds },
        });
        break;
      }
      // 可以在这里添加其他渠道的配置解析
      default:
        console.warn(`[Config] 未知渠道类型: ${type}`);
    }
  }

  return configs;
}

/**
 * 获取指定类型的第一个渠道配置（向后兼容）
 */
export function getChannelConfig(config, type = "telegram") {
  if (!config.channels) {
    // 旧版配置格式
    return type === "telegram" ? { botToken: config.botToken, chatIds: config.chatIds } : null;
  }
  const channel = config.channels.find(c => c.type === type);
  return channel ? channel.config : null;
}
