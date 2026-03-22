/**
 * 消息格式化工具 - 支持多种格式
 */

// HTML 转义
export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Telegram MarkdownV2 转义
export function escapeMarkdownV2(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*\*/g, "*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "`")
    .replace(/>/g, "\\>")
    .replace(/</g, "\\<")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

// JSON 反转义
export function unescapeJson(s) {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/**
 * 分割长消息（用于消息发送）
 * @param {string} text - 要分割的文本
 * @param {number} maxLen - 最大长度
 * @returns {string[]} 分割后的消息数组
 */
export function splitMessage(text, maxLen) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      splitIdx = maxLen;
    }
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return parts;
}

/**
 * 消息格式化器 - 根据目标格式生成消息
 */
export class MessageFormatter {
  /**
   * 创建一个简单的文本消息
   */
  static text(content) {
    return {
      type: "text",
      content,
      toFormat(targetFormat) {
        return MessageFormatter.format(this, targetFormat);
      },
    };
  }

  /**
   * 创建一个带标题的消息
   */
  static titled(title, content) {
    return {
      type: "titled",
      title,
      content,
      toFormat(targetFormat) {
        return MessageFormatter.format(this, targetFormat);
      },
    };
  }

  /**
   * 创建一个带会话标签的消息
   */
  static sessionLabel(label, content) {
    return {
      type: "sessionLabel",
      label,
      content,
      toFormat(targetFormat) {
        return MessageFormatter.format(this, targetFormat);
      },
    };
  }

  /**
   * 创建一个权限请求消息
   */
  static permissionPrompt(label, title, message, details, replyHint, optionCount) {
    return {
      type: "permissionPrompt",
      label,
      title,
      message,
      details,
      replyHint,
      optionCount,
      toFormat(targetFormat) {
        return MessageFormatter.format(this, targetFormat);
      },
    };
  }

  /**
   * 创建一个包含代码块的消息
   */
  static code(content, language = "") {
    return {
      type: "code",
      content,
      language,
      toFormat(targetFormat) {
        return MessageFormatter.format(this, targetFormat);
      },
    };
  }

  /**
   * 格式化消息到目标格式
   */
  static format(message, targetFormat = "HTML") {
    switch (targetFormat) {
      case "HTML":
        return this.toHtml(message);
      case "MarkdownV2":
        return this.toMarkdownV2(message);
      case "plain":
      default:
        return this.toPlain(message);
    }
  }

  /**
   * 转换为 HTML 格式
   */
  static toHtml(message) {
    switch (message.type) {
      case "text":
        return escapeHtml(message.content);
      case "titled":
        return `<b>${escapeHtml(message.title)}</b>\n\n${escapeHtml(message.content)}`;
      case "sessionLabel":
        return `<b>${escapeHtml(message.label)}</b> ${escapeHtml(message.content)}`;
      case "permissionPrompt":
        let html = `⚠️ <b>${escapeHtml(message.label)}</b> 权限请求:\n${escapeHtml(message.title)}\n\n${escapeHtml(message.message)}`;
        if (message.details) {
          html += message.details;
        }
        if (message.replyHint) {
          html += message.replyHint;
        }
        return html;
      case "code":
        return `<pre>${escapeHtml(message.content)}</pre>`;
      default:
        return escapeHtml(String(message));
    }
  }

  /**
   * 转换为 MarkdownV2 格式
   */
  static toMarkdownV2(message) {
    switch (message.type) {
      case "text":
        return escapeMarkdownV2(message.content);
      case "titled":
        return `*${escapeMarkdownV2(message.title)}*\n\n${escapeMarkdownV2(message.content)}`;
      case "sessionLabel":
        return `*${escapeMarkdownV2(message.label)}* ${escapeMarkdownV2(message.content)}`;
      case "permissionPrompt":
        let md = `⚠️ *${escapeMarkdownV2(message.label)}* 权限请求:\n${escapeMarkdownV2(message.title)}\n\n${escapeMarkdownV2(message.message)}`;
        if (message.details) {
          md += message.details;
        }
        if (message.replyHint) {
          md += message.replyHint;
        }
        return md;
      case "code":
        return `\`${message.content}\``;
      default:
        return escapeMarkdownV2(String(message));
    }
  }

  /**
   * 转换为纯文本格式
   */
  static toPlain(message) {
    switch (message.type) {
      case "text":
        return message.content;
      case "titled":
        return `${message.title}\n\n${message.content}`;
      case "sessionLabel":
        return `[${message.label}] ${message.content}`;
      case "permissionPrompt":
        let plain = `⚠️ [${message.label}] 权限请求:\n${message.title}\n\n${message.message}`;
        if (message.details) {
          plain += message.details.replace(/<[^>]+>/g, "");
        }
        if (message.replyHint) {
          plain += message.replyHint.replace(/<[^>]+>/g, "");
        }
        return plain;
      case "code":
        return message.content;
      default:
        return String(message);
    }
  }
}
