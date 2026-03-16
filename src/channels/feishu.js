/**
 * Feishu/Lark Channel - 飞书渠道实现 (使用官方 SDK)
 *
 * 使用飞书官方 SDK @larksuiteoapi/node-sdk 实现 WebSocket 长连接
 */

import lark from "@larksuiteoapi/node-sdk";
const { Client, WSClient, Domain, EventDispatcher, LoggerLevel } = lark;
import { BaseChannel } from "./base.js";
import { MessageFormatter, escapeHtml } from "./format.js";

// 飞书 API 基础 URL
const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

// Token 缓存（用于静态方法）
let cachedTenantAccessToken = null;
let cachedTokenExpireAt = 0;

/**
 * 获取 tenant_access_token（静态方法，供 hook 使用）
 */
async function getTenantAccessToken(appId, appSecret) {
  const now = Date.now();

  // 如果 token 有效期还有 5 分钟以上，直接使用
  if (cachedTenantAccessToken && cachedTokenExpireAt > now + 5 * 60 * 1000) {
    return cachedTenantAccessToken;
  }

  const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`[Feishu] 获取 token 失败，状态码: ${response.status}`);
    throw new Error(`获取 token 失败: ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (parseErr) {
    console.error(`[Feishu] JSON 解析失败，响应内容: ${responseText.slice(0, 500)}`);
    throw new Error(`获取 token 失败: 响应不是有效的 JSON 格式`);
  }

  if (data.code !== 0) {
    throw new Error(`获取 token 失败: ${data.msg} (code: ${data.code})`);
  }

  cachedTenantAccessToken = data.tenant_access_token;
  cachedTokenExpireAt = now + data.expire * 1000;

  return cachedTenantAccessToken;
}

/**
 * 发送飞书消息（静态方法，供 hook 使用）
 */
export async function sendFeishuMessage(appId, appSecret, receiveId, text, receiveIdType = null) {
  // 自动检测 ID 类型
  if (!receiveIdType) {
    if (receiveId.startsWith("oc_")) {
      receiveIdType = "chat_id";
    } else if (receiveId.startsWith("ou_")) {
      receiveIdType = "open_id";
    } else if (receiveId.startsWith("on_")) {
      receiveIdType = "union_id";
    } else {
      receiveIdType = "open_id"; // 默认
    }
  }

  const token = await getTenantAccessToken(appId, appSecret);

  // 构建消息内容 - 飞书要求 content 是 JSON 字符串
  let contentStr;
  if (typeof text === "string") {
    contentStr = JSON.stringify({ text });
  } else if (typeof text === "object") {
    contentStr = JSON.stringify(text);
  } else {
    contentStr = JSON.stringify({ text: String(text) });
  }

  const response = await fetch(
    `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content: contentStr,
      }),
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`[Feishu] 发送消息失败，状态码: ${response.status}`);
    console.error(`[Feishu] 响应内容: ${responseText.slice(0, 500)}`);
    throw new Error(`发送消息失败: ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (parseErr) {
    console.error(`[Feishu] 响应解析失败: ${responseText.slice(0, 500)}`);
    throw new Error(`发送消息失败: 响应不是有效的 JSON`);
  }

  // 如果是 open_id 跨应用错误，尝试使用 chat_id
  if (data.code === 99992361 && receiveIdType === "open_id") {
    console.log("[Feishu] open_id 失败，尝试使用 chat_id...");
    return sendFeishuMessage(appId, appSecret, receiveId, text, "chat_id");
  }

  if (data.code !== 0) {
    throw new Error(`发送消息失败: ${data.msg} (code: ${data.code})`);
  }

  return data.data;
}

/**
 * 飞书渠道类 (使用官方 SDK)
 */
export class FeishuChannel extends BaseChannel {
  static type = "feishu";
  static displayName = "飞书";

  constructor(config) {
    super(config);
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.receiveIds = config.receiveIds || [];

    // SDK 客户端
    this.client = null;
    this.wsClient = null;
    this.running = false;

    // 处理器存储
    this.messageHandlers = [];
    this.commandHandlers = new Map();
    this.callbackHandlers = new Map();
  }

  /**
   * 验证飞书配置
   */
  static validateConfig(config) {
    return !!(config.appId && config.appSecret && config.receiveIds?.length > 0);
  }

  /**
   * 获取授权的接收者ID列表
   */
  getAuthorizedRecipients() {
    return this.receiveIds;
  }

  /**
   * 启动飞书渠道
   */
  async start() {
    this.running = true;

    // 初始化 SDK 客户端
    this.client = new Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
    });

    // 启动 WebSocket 长连接（用于接收消息）
    await this.startWebSocket();

    console.log("[Feishu] 已就绪");
  }

  /**
   * 停止飞书渠道
   */
  async stop() {
    this.running = false;

    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch (err) {
        // 忽略关闭错误
      }
      this.wsClient = null;
    }
  }

  /**
   * 启动 WebSocket 长连接
   */
  async startWebSocket() {
    try {
      // 使用 SDK 的 WebSocket 客户端
      this.wsClient = new WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: Domain.Feishu,
        autoReconnect: true,
        loggerLevel: LoggerLevel.warn,
      });

      // 创建事件分发器并注册消息处理
      const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn });
      eventDispatcher.register({
        "im.message.receive_v1": async (data) => {
          await this.handleEvent(data);
        },
      });

      // 启动连接，传入事件分发器
      await this.wsClient.start({ eventDispatcher });

    } catch (err) {
      console.error("[Feishu] WebSocket 连接失败:", err.message);

      if (err.message?.includes("404") || err.message?.includes("not found")) {
        console.error("");
        console.error("❌ 请确认已完成以下配置:");
        console.error("   1. 在飞书开放平台开启「使用长连接接收事件」功能");
        console.error("      路径: 应用详情 → 事件订阅 → 使用长连接接收事件");
        console.error("   2. 添加事件订阅: im.message.receive_v1");
        console.error("   3. 发布应用版本");
        console.error("");
      }

      // 重试
      if (this.running) {
        setTimeout(() => {
          if (this.running) {
            this.startWebSocket();
          }
        }, 5000);
      }
    }
  }

  /**
   * 处理飞书事件
   */
  async handleEvent(event) {
    try {
      // SDK 传递的数据可能有两种格式：
      // 1. event.event_type (扁平结构)
      // 2. event.header.event_type (嵌套结构)
      const eventType = event.event_type || event.header?.event_type;

      // 处理消息接收事件
      if (eventType === "im.message.receive_v1") {
        await this.handleMessageEvent(event);
      }
    } catch (err) {
      console.error("[Feishu] 处理事件失败:", err.message);
    }
  }

  /**
   * 处理消息接收事件
   */
  async handleMessageEvent(event) {
    // SDK 传递的数据可能有两种格式：
    // 1. event.message (扁平结构)
    // 2. event.event.message (嵌套结构)
    const message = event.message || event.event?.message;

    if (!message) {
      return;
    }

    // 检查授权 - 支持多种 ID 类型
    const chatId = message.chat_id;
    const senderId = event.sender?.sender_id?.open_id ||
                    message.sender?.id?.open_id ||
                    event.sender?.sender_id?.user_id ||
                    message.sender?.id?.user_id;

    const isAuthorized = this.receiveIds.some(id =>
      id === chatId || id === senderId
    );

    if (!isAuthorized) {
      return;
    }

    // 构建统一的上下文对象
    const context = {
      channel: this,
      channelType: "feishu",
      raw: event,
      chatId: chatId,
      from: {
        id: event.sender?.sender_id?.open_id || message.sender?.id?.open_id,
        userId: event.sender?.sender_id?.user_id || message.sender?.id?.user_id,
        username: event.sender?.sender_id?.open_id || message.sender?.id?.open_id,
      },
      messageId: message.message_id,
      text: this.extractTextFromMessage(message),
      match: null,

      reply: async (text, options = {}) => {
        return this.sendMessage(text, {
          recipientId: chatId,
          receiveIdType: "chat_id",
          ...options,
        });
      },

      editMessage: async (text, options = {}) => {
        return this.updateMessage(message.message_id, text);
      },

      answerCallback: async (text) => {
        return this.sendMessage(text, {
          recipientId: chatId,
          receiveIdType: "chat_id",
        });
      },
    };

    // 检查是否是命令
    const text = context.text;
    if (text && text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0];
      const handler = this.commandHandlers.get(cmd);

      if (handler) {
        context.match = parts.slice(1).join(" ");
        await handler(context);
        return;
      }
    }

    // 调用消息处理器
    for (const handler of this.messageHandlers) {
      await handler(text, context);
    }
  }

  /**
   * 从飞书消息中提取文本
   */
  extractTextFromMessage(message) {
    const content = message.content;

    try {
      const parsed = typeof content === "string" ? JSON.parse(content) : content;

      // 飞书消息类型字段是 message_type
      if (message.message_type === "text") {
        return parsed.text || "";
      }

      if (message.message_type === "post") {
        return this.extractTextFromPostContent(parsed);
      }

      return "";
    } catch {
      return String(content);
    }
  }

  /**
   * 从飞书富文本中提取纯文本
   */
  extractTextFromPostContent(postContent) {
    const texts = [];

    const extractFromParagraph = (paragraph) => {
      if (!Array.isArray(paragraph)) return;

      for (const element of paragraph) {
        if (element.tag === "text") {
          texts.push(element.text);
        } else if (element.children) {
          extractFromParagraph(element.children);
        }
      }
    };

    const content = postContent.zh_cn?.content || postContent.content || [];
    for (const paragraph of content) {
      extractFromParagraph(paragraph);
    }

    return texts.join("");
  }

  // ========== 消息发送 ==========

  /**
   * 发送消息到指定接收者
   */
  async sendMessage(message, options = {}) {
    const receiveIdType = options.receiveIdType || "open_id";
    const receiveId = options.recipientId || this.receiveIds[0];

    if (!receiveId) {
      throw new Error("[Feishu] 没有指定接收者ID");
    }

    // 构建消息内容
    let contentStr;
    if (typeof message === "string") {
      contentStr = JSON.stringify({ text: message });
    } else {
      contentStr = JSON.stringify(message);
    }

    try {
      // 使用 SDK 发送消息
      const result = await this.client.im.v1.message.create({
        params: {
          receive_id_type: receiveIdType,
        },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: contentStr,
        },
      });

      if (result.code !== 0) {
        throw new Error(`发送消息失败: ${result.msg}`);
      }

      return result.data;
    } catch (err) {
      // SDK 失败时回退到直接 API 调用
      return await sendFeishuMessage(
        this.appId,
        this.appSecret,
        receiveId,
        message,
        receiveIdType
      );
    }
  }

  /**
   * 广播消息到所有授权接收者
   */
  async broadcast(message, options = {}) {
    const results = [];

    for (const receiveId of this.receiveIds) {
      try {
        const result = await this.sendMessage(message, {
          ...options,
          recipientId: receiveId,
        });
        results.push({ receiveId, success: true, result });
      } catch (err) {
        console.error(`[Feishu] 发送到 ${receiveId} 失败:`, err.message);
        results.push({ receiveId, success: false, error: err.message });
      }
    }

    return results;
  }

  /**
   * 更新已发送的消息
   */
  async updateMessage(messageId, text) {
    try {
      const result = await this.client.im.v1.message.patch({
        path: {
          message_id: messageId,
        },
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });

      if (result.code !== 0) {
        throw new Error(`更新消息失败: ${result.msg}`);
      }

      return result.data;
    } catch (err) {
      throw new Error(`更新消息失败: ${err.message}`);
    }
  }

  // ========== 事件处理注册 ==========

  /**
   * 注册消息处理器
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  /**
   * 注册命令处理器
   */
  onCommand(command, handler) {
    this.commandHandlers.set(command, handler);
  }

  /**
   * 注册回调处理器
   */
  onCallback(prefix, handler) {
    this.callbackHandlers.set(prefix, handler);
  }

  /**
   * 创建内联键盘 (飞书卡片按钮)
   */
  createInlineKeyboard() {
    return new FeishuCardBuilder();
  }
}

/**
 * 飞书卡片构建器
 */
export class FeishuCardBuilder {
  constructor() {
    this.elements = [];
  }

  /**
   * 添加按钮
   */
  text(label, callbackData) {
    this.elements.push({
      tag: "button",
      text: { tag: "plain_text", content: label },
      type: "primary",
      value: { callback: callbackData },
    });
    return this;
  }

  /**
   * 构建卡片
   */
  build() {
    return {
      type: "template",
      data: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "horizontal",
              contents: this.elements,
            },
          ],
        },
      },
    };
  }

  /**
   * 转换为 JSON
   */
  toJSON() {
    return this.build();
  }
}

// 导出辅助函数
export function createFeishuCard() {
  return new FeishuCardBuilder();
}
