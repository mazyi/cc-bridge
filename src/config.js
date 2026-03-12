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

export function loadConfig() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `配置文件 (.env) 不存在: ${ENV_FILE}\n请先运行: npm run init`
    );
  }

  loadDotenv({ path: ENV_FILE });

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
    botToken,
    chatIds: chatIdArray,
    configDir: PROJECT_ROOT,
  };
}
