/**
 * Channel Manager - 渠道管理器
 *
 * 管理多个渠道的生命周期、消息路由和广播
 */

import { createChannel, getChannelClass } from "./index.js";

export class ChannelManager {
  constructor() {
    this.channels = new Map(); // type -> Channel instance(s)
    this.messageHandlers = [];
    this.commandHandlers = new Map(); // command -> handler
    this.callbackHandlers = new Map(); // prefix -> handler
    this.errorHandler = null;
  }

  /**
   * 从配置初始化渠道
   * @param {object} config - loadConfig() 返回的配置
   */
  initializeFromConfig(config) {
    if (!config.channels || config.channels.length === 0) {
      throw new Error("No channels configured");
    }

    for (const channelConfig of config.channels) {
      this.addChannel(channelConfig.type, channelConfig.config);
    }
  }

  /**
   * 添加一个渠道
   * @param {string} type - 渠道类型
   * @param {object} config - 渠道配置
   * @returns {BaseChannel} 创建的渠道实例
   */
  addChannel(type, config) {
    const channel = createChannel(type, config);

    // 注册已有的处理器到新渠道
    for (const handler of this.messageHandlers) {
      channel.onMessage(handler);
    }
    for (const [command, handler] of this.commandHandlers) {
      channel.onCommand(command, handler);
    }
    for (const [prefix, handler] of this.callbackHandlers) {
      channel.onCallback(prefix, handler);
    }
    if (this.errorHandler) {
      channel.onError(this.errorHandler);
    }

    // 存储渠道
    if (!this.channels.has(type)) {
      this.channels.set(type, []);
    }
    this.channels.get(type).push(channel);

    return channel;
  }

  /**
   * 启动所有渠道
   */
  async startAll() {
    const promises = [];
    for (const channels of this.channels.values()) {
      for (const channel of channels) {
        promises.push(channel.start());
      }
    }
    await Promise.all(promises);
  }

  /**
   * 停止所有渠道
   */
  async stopAll() {
    const promises = [];
    for (const channels of this.channels.values()) {
      for (const channel of channels) {
        promises.push(channel.stop());
      }
    }
    await Promise.all(promises);
  }

  /**
   * 获取指定类型的所有渠道
   */
  getChannels(type) {
    return this.channels.get(type) || [];
  }

  /**
   * 获取第一个指定类型的渠道（向后兼容）
   */
  getChannel(type) {
    const channels = this.getChannels(type);
    return channels[0] || null;
  }

  /**
   * 获取所有渠道
   */
  getAllChannels() {
    const all = [];
    for (const channels of this.channels.values()) {
      all.push(...channels);
    }
    return all;
  }

  // ========== 消息/命令路由注册 ==========

  /**
   * 注册消息处理器（所有渠道）
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
    for (const channel of this.getAllChannels()) {
      channel.onMessage(handler);
    }
  }

  /**
   * 注册命令处理器（所有渠道）
   */
  onCommand(command, handler) {
    this.commandHandlers.set(command, handler);
    for (const channel of this.getAllChannels()) {
      channel.onCommand(command, handler);
    }
  }

  /**
   * 注册回调处理器（所有渠道）
   */
  onCallback(prefix, handler) {
    this.callbackHandlers.set(prefix, handler);
    for (const channel of this.getAllChannels()) {
      channel.onCallback(prefix, handler);
    }
  }

  /**
   * 注册错误处理器（所有渠道）
   */
  onError(handler) {
    this.errorHandler = handler;
    for (const channel of this.getAllChannels()) {
      channel.onError(handler);
    }
  }

  // ========== 消息发送 ==========

  /**
   * 广播消息到所有渠道的所有授权用户
   */
  async broadcast(message, options = {}) {
    const promises = [];
    for (const channel of this.getAllChannels()) {
      promises.push(channel.broadcast(message, options));
    }
    await Promise.allSettled(promises);
  }

  /**
   * 发送消息到指定类型的渠道
   */
  async sendToType(type, message, options = {}) {
    const channels = this.getChannels(type);
    const promises = channels.map(c => c.broadcast(message, options));
    await Promise.allSettled(promises);
  }

  /**
   * 发送消息到特定接收者（需要指定渠道类型）
   */
  async sendToRecipient(channelType, recipientId, message, options = {}) {
    const channels = this.getChannels(channelType);
    for (const channel of channels) {
      if (channel.isAuthorized(recipientId)) {
        await channel.sendMessage(message, { ...options, recipientId });
        return;
      }
    }
    throw new Error(`Recipient ${recipientId} not found in channel ${channelType}`);
  }
}

// 全局单例
let globalManager = null;

export function getChannelManager() {
  if (!globalManager) {
    globalManager = new ChannelManager();
  }
  return globalManager;
}
