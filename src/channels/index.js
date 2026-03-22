/**
 * 渠道注册中心 - 所有支持的渠道
 */

import { TelegramChannel } from "./telegram.js";
import { FeishuChannel } from "./feishu.js";

// 注册的渠道类
export const ChannelClasses = {
  [TelegramChannel.type]: TelegramChannel,
  [FeishuChannel.type]: FeishuChannel,
};

// 渠道类型枚举
export const ChannelTypes = {
  TELEGRAM: TelegramChannel.type,
  FEISHU: FeishuChannel.type,
};

/**
 * 获取渠道类
 */
export function getChannelClass(type) {
  return ChannelClasses[type];
}

/**
 * 创建渠道实例
 */
export function createChannel(type, config) {
  const ChannelClass = getChannelClass(type);
  if (!ChannelClass) {
    throw new Error(`Unknown channel type: ${type}`);
  }
  if (!ChannelClass.validateConfig(config)) {
    throw new Error(`Invalid config for channel type: ${type}`);
  }
  return new ChannelClass(config);
}

/**
 * 列出所有可用的渠道类型
 */
export function listAvailableChannels() {
  return Object.entries(ChannelClasses).map(([type, cls]) => ({
    type,
    displayName: cls.displayName,
  }));
}

// 导出单个渠道类，方便直接导入
export { TelegramChannel, sendTelegramMessageRaw } from "./telegram.js";
export { FeishuChannel, sendFeishuMessage } from "./feishu.js";
export { BaseChannel } from "./base.js";
export { MessageFormatter, escapeHtml, escapeMarkdownV2, unescapeJson, splitMessage } from "./format.js";
