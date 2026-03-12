/**
 * transcript.js — Claude Code transcript.jsonl 文件解析工具
 */

import { existsSync, openSync, fstatSync, readSync, closeSync, readFileSync } from "fs";

/**
 * 解析最近的 N 条对话
 * @param {string} transcriptPath - transcript.jsonl 文件路径
 * @param {number} count - 要获取的对话数量
 * @param {boolean} includeAssistant - 是否包含 assistant 回复（默认 false）
 * @returns {Array|null>} - 对话数组，格式:
 *   - includeAssistant=false: [{ user: string, timestamp: string }]
 *   - includeAssistant=true: [{ user: string, assistant: string, timestamp: string }]
 */
export function parseRecentConversations(transcriptPath, count = 3, includeAssistant = false) {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  try {
    // 读取整个文件，简化逻辑并正确配对
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const conversations = [];
    let pendingAssistant = null; // 保存遇到的第一个 assistant（最新的）
    // 从后往前遍历
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      try {
        const data = JSON.parse(line);

        if (data.type === 'assistant' && includeAssistant) {
          // 只保存第一条遇到的 assistant（即最新的）
          if (pendingAssistant === null) {
            const msg = data.message || {};
            const contentArray = msg.content || [];
            const textParts = [];
            for (const item of contentArray) {
              if (item.type === 'text' && item.text) {
                textParts.push(item.text);
              }
            }
            if (textParts.length > 0) {
              pendingAssistant = textParts.join('\n\n');
            }
          }
        } else if (data.type === 'user') {
          const msg = data.message || {};
          const rawContent = msg.content;
          let userText = '';

          if (typeof rawContent === 'string') {
            userText = rawContent;
          } else if (Array.isArray(rawContent)) {
            const parts = [];
            for (const item of rawContent) {
              if (item.type === 'text' && item.text) {
                parts.push(item.text);
              }
            }
            userText = parts.join('\n\n');
          }

          if (!userText) continue;

          const timestamp = data.timestamp || '';

          if (includeAssistant) {
            if (pendingAssistant) {
              conversations.unshift({
                user: userText,
                assistant: pendingAssistant,
                timestamp
              });
              pendingAssistant = null;
              if (conversations.length >= count) break;
            } else {
              // 没有找到对应的 assistant，跳过（保证配对完整）
              continue;
            }
          } else {
            conversations.unshift({
              user: userText,
              timestamp
            });
            if (conversations.length >= count) break;
          }
        }
      } catch (e) {
        continue;
      }
    }

    return conversations.length > 0 ? conversations : null;
  } catch (err) {
    console.error('parseRecentConversations error:', err);
    return null;
  }
}

/**
 * 解析最近一条 Assistant 回复的文本内容
 * @param {string} transcriptPath - transcript.jsonl 文件路径
 * @param {number} maxLines - 最多检查的行数
 * @returns {string|null} - Assistant 回复文本（只提取 text 类型内容）
 */
export function parseLatestAssistantReply(transcriptPath, maxLines = 1000) {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n');
    let linesChecked = 0;
    let targetMessageId = null;
    const textBlocks = []; // 只收集 text 类型的内容块

    // 从后往前扫描，找到最新的 assistant 回复
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      linesChecked++;
      if (maxLines && linesChecked > maxLines) {
        break;
      }

      try {
        const data = JSON.parse(line);

        if (data.type === 'assistant') {
          const msg = data.message || {};
          const msgId = msg.id;

          if (!targetMessageId) {
            targetMessageId = msgId;
          }

          if (msgId === targetMessageId) {
            const contentArray = msg.content || [];
            for (const item of contentArray) {
              // 只提取 text 类型的内容
              if (item.type === 'text' && item.text) {
                textBlocks.push(item.text);
              }
            }
          } else {
            // 遇到不同 ID 的 assistant，说明已经收集完最新回复的所有 text 块
            break;
          }
        } else {
          if (targetMessageId && textBlocks.length > 0) {
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }

    if (textBlocks.length === 0) {
      return null;
    }

    // 反转以恢复原始顺序，然后合并
    return textBlocks.reverse().join('\n\n');

  } catch (err) {
    console.error('parseLatestAssistantReply error:', err);
    return null;
  }
}

/**
 * 解析最近一次待处理的工具调用
 * @param {string} transcriptPath - transcript.jsonl 文件路径
 * @param {number} maxLines - 最多检查的行数
 * @returns {Object|null} - 工具调用信息 { name: string, input: object }
 */
export function parsePendingToolUse(transcriptPath, maxLines = 100) {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  try {
    const fd = openSync(transcriptPath, 'r');
    const stats = fstatSync(fd);
    const fileSize = stats.size;

    if (fileSize === 0) {
      closeSync(fd);
      return null;
    }

    const chunkSize = 8192;
    let buffer = Buffer.alloc(0);
    let position = fileSize;
    let linesChecked = 0;

    while (position > 0 && linesChecked < maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;

      const chunk = Buffer.alloc(readSize);
      readSync(fd, chunk, 0, readSize, position);

      buffer = Buffer.concat([chunk, buffer]);

      const text = buffer.toString('utf-8');
      const lines = text.split('\n');

      const startIdx = position > 0 ? 1 : 0;

      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        linesChecked++;

        try {
          const data = JSON.parse(line);

          if (data.type === 'assistant') {
            const msg = data.message || {};
            const content = msg.content || [];

            for (const item of content) {
              if (item.type === 'tool_use') {
                closeSync(fd);
                return {
                  name: item.name,
                  input: item.input
                };
              }
            }
          }
        } catch (parseErr) {
          continue;
        }
      }

      if (position > 0 && lines.length > 0) {
        buffer = Buffer.from(lines[0], 'utf-8');
      } else {
        buffer = Buffer.alloc(0);
      }
    }

    closeSync(fd);
    return null;

  } catch (err) {
    return null;
  }
}
