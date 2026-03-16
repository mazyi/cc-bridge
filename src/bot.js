/**
 * bot.js - 向后兼容层
 *
 * 注意：这个文件仅用于向后兼容。新代码应该使用：
 * - src/channels/telegram.js - Telegram 渠道实现
 * - src/channels/manager.js - 渠道管理器
 * - src/commands.js - 命令处理器
 */

import { loadConfig, getChannelConfig } from "./config.js";
import { TelegramChannel } from "./channels/telegram.js";
import { ChannelManager } from "./channels/manager.js";
import { registerCommands } from "./commands.js";

// 导出旧的 createBot 函数供现有代码使用
export function createBot(config) {
  console.warn("[bot.js] 警告: createBot() 已弃用，请使用 ChannelManager");

  // 创建渠道管理器
  const manager = new ChannelManager();

  // 从配置获取 Telegram 配置
  const telegramConfig = getChannelConfig(config, "telegram");
  if (!telegramConfig) {
    throw new Error("No Telegram config found");
  }

  // 添加 Telegram 渠道
  const channel = manager.addChannel("telegram", telegramConfig);

  // 注册命令
  registerCommands(manager);

  // 包装为旧的 bot 接口
  return {
    bot: channel,

    start: async (options = {}) => {
      await manager.startAll();
      if (options.onStart) {
        options.onStart();
      }
    },

    stop: async () => {
      await manager.stopAll();
    },

    catch: (handler) => {
      manager.onError(handler);
    },

    // 直接访问底层渠道
    _channel: channel,
    _manager: manager,
  };
}

// 向后兼容：也导出一个默认的 createBot 用于独立使用
export default {
  createBot,
};
