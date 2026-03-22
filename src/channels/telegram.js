/**
 * Telegram Channel - Telegram 渠道实现
 */

import { Bot, InlineKeyboard } from "grammy";
import { BaseChannel } from "./base.js";
import { MessageFormatter, escapeHtml, escapeMarkdownV2, splitMessage } from "./format.js";

// 导出原始发送函数供 hook 使用
export async function sendTelegramMessageRaw(botToken, chatId, text, parseMode = "HTML") {
  const maxLen = 4000;
  const messages = text.length > maxLen ? splitMessage(text, maxLen) : [text];

  for (const msg of messages) {
    let success = false;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg,
            parse_mode: parseMode,
          }),
        }
      );

      if (response.ok) {
        success = true;
      } else {
        const errorText = await response.text();
        console.error(`[Telegram] API error (${parseMode}): ${response.status} ${response.statusText}`, errorText);
      }
    } catch (err) {
      console.error(`[Telegram] Fetch error (${parseMode}):`, err);
    }

    if (!success) {
      try {
        const response2 = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: msg,
            }),
          }
        );

        if (!response2.ok) {
          const errorText = await response2.text();
          console.error(`[Telegram] API error (plain): ${response2.status} ${response2.statusText}`, errorText);
        }
      } catch (err2) {
        console.error(`[Telegram] Fetch error (plain):`, err2);
        throw err2;
      }
    }
  }
}

export class TelegramChannel extends BaseChannel {
  static type = "telegram";
  static displayName = "Telegram";

  constructor(config) {
    super(config);
    this.bot = null;
    this.messageHandlers = [];
    this.commandHandlers = new Map();
    this.callbackHandlers = new Map();
    this.errorHandler = null;
  }

  /**
   * 验证 Telegram 配置
   */
  static validateConfig(config) {
    return !!(config.botToken && config.chatIds && config.chatIds.length > 0);
  }

  /**
   * 获取授权的 Chat ID 列表
   */
  getAuthorizedRecipients() {
    return this.config.chatIds || [];
  }

  /**
   * 启动 Telegram Bot
   */
  async start() {
    this.bot = new Bot(this.config.botToken);
    const allowedChatIds = this.config.chatIds || [];

    // 授权中间件
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id?.toString();
      if (!allowedChatIds.includes(chatId)) {
        await this.safeReply(ctx, "⛔ 未授权的用户");
        return;
      }
      await next();
    });

    // 全局错误处理
    this.bot.catch((err) => {
      const error = err.error;
      console.error("[Telegram] Bot 错误:", error);
      this.emitError(error, { ctx: err.ctx });

      if (err.ctx) {
        this.safeReply(err.ctx, "⚠️ 处理请求时发生错误，请稍后重试").catch((replyErr) => {
          console.error("[Telegram] 发送错误通知失败:", replyErr);
        });
      }
    });

    // 注册命令处理器
    for (const [command, handler] of this.commandHandlers) {
      this.bot.command(command, this.wrapHandler(handler));
    }

    // 文本消息处理器
    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx?.chat?.id;
      const text = ctx?.message?.text;
      if (!chatId || !text) return;

      // 转换为统一的消息上下文
      const context = this.createMessageContext(ctx);

      // 调用所有注册的消息处理器
      for (const handler of this.messageHandlers) {
        await handler(text, context);
      }
    });

    // 回调查询处理器
    this.bot.on("callback_query", async (ctx) => {
      try {
        const data = ctx.callbackQuery?.data;
        if (!data) {
          return;
        }

        // 查找匹配的回调处理器
        for (const [prefix, handler] of this.callbackHandlers) {
          if (data.startsWith(prefix)) {
            const context = this.createCallbackContext(ctx, data);
            await handler(data, context);
            return;
          }
        }

        await ctx.answerCallbackQuery("未知操作");
      } catch (err) {
        console.error("[Telegram] 处理回调错误:", err);
        await ctx.answerCallbackQuery("处理失败");
      }
    });

    await this.bot.start({
      onStart: () => {
        console.log("[Telegram] Bot 连接成功");
      },
    });
  }

  /**
   * 停止 Telegram Bot
   */
  async stop() {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
  }

  /**
   * 发送消息到指定 Chat ID
   */
  async sendMessage(message, options = {}) {
    const { parseMode = "HTML", recipientId } = options;
    const chatId = recipientId || this.config.chatIds[0];

    let text = message;
    if (message.toFormat) {
      text = message.toFormat(parseMode);
    }

    await this.sendTelegramMessageRaw(this.config.botToken, chatId, text, parseMode);
  }

  /**
   * 广播消息到所有授权 Chat ID
   */
  async broadcast(message, options = {}) {
    const { parseMode = "HTML" } = options;

    let text = message;
    if (message.toFormat) {
      text = message.toFormat(parseMode);
    }

    for (const chatId of this.config.chatIds) {
      try {
        await this.sendTelegramMessageRaw(this.config.botToken, chatId, text, parseMode);
      } catch (err) {
        console.error(`[Telegram] 发送到 ${chatId} 失败:`, err.message);
      }
    }
  }

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
    // 如果 bot 已经启动，动态注册
    if (this.bot) {
      this.bot.command(command, this.wrapHandler(handler));
    }
  }

  /**
   * 注册回调处理器
   */
  onCallback(prefix, handler) {
    this.callbackHandlers.set(prefix, handler);
  }

  // ========== 内部方法 ==========

  /**
   * 包装处理器，添加错误处理
   */
  wrapHandler(handler) {
    return async (ctx) => {
      try {
        const context = this.createMessageContext(ctx);
        await handler(context);
      } catch (err) {
        console.error("[Telegram] 处理错误:", err);
        await this.safeReply(ctx, `⚠️ 处理命令时发生错误: ${err.message}`);
      }
    };
  }

  /**
   * 创建统一的消息上下文对象
   */
  createMessageContext(ctx) {
    return {
      channel: this,
      channelType: "telegram",
      raw: ctx,
      chatId: ctx.chat?.id?.toString(),
      from: {
        id: ctx.from?.id?.toString(),
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
      },
      messageId: ctx.message?.message_id,
      text: ctx.message?.text,
      match: ctx.match,

      // 常用方法代理
      reply: async (text, options) => this.safeReply(ctx, text, options),
      editMessage: async (text, options) => this.safeEditMessageText(ctx, text, options),
    };
  }

  /**
   * 创建回调上下文对象
   */
  createCallbackContext(ctx, data) {
    return {
      ...this.createMessageContext(ctx),
      callbackData: data,
      answerCallback: async (text, options = {}) => {
        try {
          // 使用 ctx.api 避免上下文问题
          if (text) {
            await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, { text, ...options });
          } else {
            await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, options);
          }
        } catch (err) {
          console.error("[Telegram] answerCallbackQuery 失败:", err);
        }
      },
    };
  }

  /**
   * 安全发送消息
   */
  async safeReply(ctx, text, options = {}) {
    try {
      return await ctx.reply(text, options);
    } catch (err) {
      console.error("[Telegram] 发送消息失败:", err.message);
      try {
        return await ctx.reply(text.replace(/<[^>]*>/g, ""));
      } catch (fallbackErr) {
        console.error("[Telegram] 发送纯文本消息也失败:", fallbackErr.message);
        return null;
      }
    }
  }

  /**
   * 安全编辑消息
   */
  async safeEditMessageText(ctx, text, options = {}) {
    try {
      return await ctx.editMessageText(text, options);
    } catch (err) {
      console.error("[Telegram] 编辑消息失败:", err.message);
      return null;
    }
  }

  /**
   * 原始 Telegram API 调用
   */
  async sendTelegramMessageRaw(botToken, chatId, text, parseMode = "HTML") {
    const maxLen = 4000;
    const messages = text.length > maxLen ? this.splitMessage(text, maxLen) : [text];

    for (const msg of messages) {
      let success = false;

      try {
        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: msg,
              parse_mode: parseMode,
            }),
          }
        );

        if (response.ok) {
          success = true;
        } else {
          const errorText = await response.text();
          console.error(`[Telegram] API error (${parseMode}): ${response.status} ${response.statusText}`, errorText);
        }
      } catch (err) {
        console.error(`[Telegram] Fetch error (${parseMode}):`, err);
      }

      if (!success) {
        try {
          const response2 = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: msg,
              }),
            }
          );

          if (!response2.ok) {
            const errorText = await response2.text();
            console.error(`[Telegram] API error (plain): ${response2.status} ${response2.statusText}`, errorText);
          }
        } catch (err2) {
          console.error(`[Telegram] Fetch error (plain):`, err2);
          throw err2;
        }
      }
    }
  }
}

// 导出格式化工具供其他模块使用
export { escapeHtml, escapeMarkdownV2, MessageFormatter };
