/**
 * Channel 基础接口 - 所有渠道需要实现的方法
 *
 * 新渠道开发指南：
 * 1. 继承 BaseChannel 类
 * 2. 实现所有抽象方法
 * 3. 在 src/channels/index.js 中注册
 * 4. 更新 config.js 以支持新渠道的配置
 */

export class BaseChannel {
  /**
   * @param {object} config - 渠道特定的配置对象
   */
  constructor(config) {
    this.config = config;
    this.type = this.constructor.type;
  }

  /**
   * 渠道类型标识（静态属性，必须覆盖）
   * @type {string}
   */
  static type = "base";

  /**
   * 渠道名称（用于显示）
   * @type {string}
   */
  static displayName = "Base Channel";

  /**
   * 初始化渠道
   * 建立连接、启动服务等
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error("start() must be implemented");
  }

  /**
   * 停止渠道
   * 清理资源、关闭连接等
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error("stop() must be implemented");
  }

  /**
   * 发送消息到渠道
   * @param {string|object} message - 消息内容
   * @param {object} options - 发送选项
   * @param {string} [options.parseMode] - 解析模式 (HTML, MarkdownV2, plain)
   * @param {string} [options.recipientId] - 接收者ID（如果需要）
   * @returns {Promise<void>}
   */
  async sendMessage(message, options = {}) {
    throw new Error("sendMessage() must be implemented");
  }

  /**
   * 批量发送消息到所有授权用户
   * @param {string|object} message - 消息内容
   * @param {object} options - 发送选项
   * @returns {Promise<void>}
   */
  async broadcast(message, options = {}) {
    throw new Error("broadcast() must be implemented");
  }

  /**
   * 注册消息处理器
   * @param {function} handler - 消息处理函数 (message, context) => Promise<void>
   */
  onMessage(handler) {
    throw new Error("onMessage() must be implemented");
  }

  /**
   * 注册命令处理器
   * @param {string} command - 命令名称 (不含前缀)
   * @param {function} handler - 命令处理函数 (context) => Promise<void>
   */
  onCommand(command, handler) {
    throw new Error("onCommand() must be implemented");
  }

  /**
   * 注册回调/交互处理器
   * @param {string} prefix - 回调数据前缀
   * @param {function} handler - 处理函数 (data, context) => Promise<void>
   */
  onCallback(prefix, handler) {
    throw new Error("onCallback() must be implemented");
  }

  /**
   * 验证配置是否有效
   * @param {object} config - 配置对象
   * @returns {boolean}
   */
  static validateConfig(config) {
    return !!config;
  }

  /**
   * 获取此渠道的授权用户ID列表
   * @returns {string[]}
   */
  getAuthorizedRecipients() {
    return [];
  }

  /**
   * 检查用户是否授权
   * @param {string} recipientId - 用户/接收者ID
   * @returns {boolean}
   */
  isAuthorized(recipientId) {
    return this.getAuthorizedRecipients().includes(recipientId);
  }

  /**
   * 注册全局错误处理器
   * @param {function} handler - 错误处理函数 (error, context) => void
   */
  onError(handler) {
    this.errorHandler = handler;
  }

  /**
   * 触发错误处理
   * @param {Error} error - 错误对象
   * @param {object} context - 上下文
   * @protected
   */
  emitError(error, context) {
    if (this.errorHandler) {
      this.errorHandler(error, context);
    } else {
      console.error(`[${this.type}] Error:`, error);
    }
  }
}
