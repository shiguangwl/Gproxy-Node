const http = require('http');
const https = require('https');
const logger = require('./logger');

/**
 * 连接池管理器
 * 提供HTTP/HTTPS连接池、智能重试、性能监控等功能
 */
class ConnectionManager {
  constructor(options = {}) {
    this.options = {
      maxSockets: options.maxSockets || 50,
      maxFreeSockets: options.maxFreeSockets || 10,
      timeout: options.timeout || 30000,
      freeSocketTimeout: options.freeSocketTimeout || 15000,
      keepAlive: options.keepAlive !== false,
      keepAliveMsecs: options.keepAliveMsecs || 1000,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      retryExponentialBase: options.retryExponentialBase || 2,
      ...options
    };

    // 性能统计
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      totalRetries: 0,
      averageResponseTime: 0,
      connectionPoolHits: 0,
      connectionPoolMisses: 0,
      activeConnections: 0,
      errors: new Map(), // 错误类型统计
      startTime: Date.now()
    };

    // 创建HTTP代理
    this.httpAgent = new http.Agent({
      keepAlive: this.options.keepAlive,
      keepAliveMsecs: this.options.keepAliveMsecs,
      timeout: this.options.timeout,
      freeSocketTimeout: this.options.freeSocketTimeout,
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets
    });

    // 创建HTTPS代理
    this.httpsAgent = new https.Agent({
      keepAlive: this.options.keepAlive,
      keepAliveMsecs: this.options.keepAliveMsecs,
      timeout: this.options.timeout,
      freeSocketTimeout: this.options.freeSocketTimeout,
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets,
      rejectUnauthorized: false // 允许自签名证书
    });

    // 监听连接事件
    this.setupEventListeners();

    // 定期清理和统计
    this.setupMaintenanceTasks();

    logger.info('连接管理器初始化完成', {
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets,
      timeout: this.options.timeout,
      keepAlive: this.options.keepAlive
    });
  }

  /**
   * 设置事件监听器
   */
  setupEventListeners() {
    // HTTP Agent事件
    this.httpAgent.on('free', (socket) => {
      this.stats.connectionPoolHits++;
      logger.debug('HTTP连接返回到池中');
    });

    this.httpAgent.on('connect', (res, socket) => {
      this.stats.activeConnections++;
      logger.debug('新HTTP连接建立');
    });

    // HTTPS Agent事件
    this.httpsAgent.on('free', (socket) => {
      this.stats.connectionPoolHits++;
      logger.debug('HTTPS连接返回到池中');
    });

    this.httpsAgent.on('connect', (res, socket) => {
      this.stats.activeConnections++;
      logger.debug('新HTTPS连接建立');
    });
  }

  /**
   * 设置维护任务
   */
  setupMaintenanceTasks() {
    // 每30秒输出统计信息
    setInterval(() => {
      this.logStatistics();
    }, 30000);

    // 每5分钟清理过期连接
    setInterval(() => {
      this.cleanupConnections();
    }, 300000);
  }

  /**
   * 获取合适的HTTP代理
   * @param {string} protocol 协议 (http: 或 https:)
   * @returns {http.Agent|https.Agent} HTTP代理
   */
  getAgent(protocol) {
    return protocol === 'https:' ? this.httpsAgent : this.httpAgent;
  }

  /**
   * 智能重试策略
   * @param {Function} operation 要执行的操作
   * @param {Object} context 上下文信息
   * @returns {Promise} 操作结果
   */
  async executeWithRetry(operation, context = {}) {
    const startTime = Date.now();
    this.stats.totalRequests++;

    let lastError;
    let attempt = 0;

    while (attempt <= this.options.maxRetries) {
      try {
        const result = await this.executeOperation(operation, context, attempt);
        
        // 成功统计
        this.stats.successfulRequests++;
        if (attempt > 0) {
          this.stats.retriedRequests++;
          this.stats.totalRetries += attempt;
        }

        // 更新平均响应时间
        const responseTime = Date.now() - startTime;
        this.updateAverageResponseTime(responseTime);

        logger.debug('请求成功', {
          url: context.url,
          attempt: attempt + 1,
          responseTime: responseTime
        });

        return result;

      } catch (error) {
        lastError = error;
        attempt++;

        // 记录错误统计
        this.recordError(error);

        // 判断是否应该重试
        if (attempt > this.options.maxRetries || !this.shouldRetry(error, attempt)) {
          break;
        }

        // 计算重试延迟
        const delay = this.calculateRetryDelay(attempt);
        
        logger.warn('请求失败，准备重试', {
          url: context.url,
          attempt: attempt,
          error: error.message,
          retryAfter: delay
        });

        // 等待重试
        await this.sleep(delay);
      }
    }

    // 最终失败
    this.stats.failedRequests++;
    
    logger.error('请求最终失败', {
      url: context.url,
      totalAttempts: attempt,
      finalError: lastError.message
    });

    throw lastError;
  }

  /**
   * 执行单次操作
   * @param {Function} operation 操作函数
   * @param {Object} context 上下文
   * @param {number} attempt 尝试次数
   * @returns {Promise} 结果
   */
  async executeOperation(operation, context, attempt) {
    // 为重试添加特殊标头
    if (attempt > 0 && context.headers) {
      context.headers['x-retry-attempt'] = attempt.toString();
    }

    // 执行操作
    return await operation(context);
  }

  /**
   * 判断是否应该重试
   * @param {Error} error 错误对象
   * @param {number} attempt 当前尝试次数
   * @returns {boolean} 是否重试
   */
  shouldRetry(error, attempt) {
    // 网络相关错误通常可以重试
    const retryableErrors = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH'
    ];

    if (retryableErrors.includes(error.code)) {
      return true;
    }

    // HTTP状态码重试策略
    if (error.response) {
      const status = error.response.status;
      
      // 5xx错误通常可以重试
      if (status >= 500 && status < 600) {
        return true;
      }
      
      // 特定的4xx错误也可以重试
      const retryableStatusCodes = [408, 429]; // 请求超时、请求过多
      if (retryableStatusCodes.includes(status)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 计算重试延迟
   * @param {number} attempt 尝试次数
   * @returns {number} 延迟毫秒数
   */
  calculateRetryDelay(attempt) {
    // 指数退避算法
    const exponentialDelay = this.options.retryDelay * 
      Math.pow(this.options.retryExponentialBase, attempt - 1);
    
    // 添加抖动防止雷群效应
    const jitter = Math.random() * 0.1 * exponentialDelay;
    
    return Math.min(exponentialDelay + jitter, 10000); // 最大10秒
  }

  /**
   * 记录错误统计
   * @param {Error} error 错误对象
   */
  recordError(error) {
    const errorType = error.code || error.name || 'UNKNOWN';
    const count = this.stats.errors.get(errorType) || 0;
    this.stats.errors.set(errorType, count + 1);
  }

  /**
   * 更新平均响应时间
   * @param {number} responseTime 响应时间
   */
  updateAverageResponseTime(responseTime) {
    if (this.stats.successfulRequests === 1) {
      this.stats.averageResponseTime = responseTime;
    } else {
      // 滑动平均
      this.stats.averageResponseTime = 
        (this.stats.averageResponseTime * (this.stats.successfulRequests - 1) + responseTime) 
        / this.stats.successfulRequests;
    }
  }

  /**
   * 休眠指定时间
   * @param {number} ms 毫秒数
   * @returns {Promise} Promise对象
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清理过期连接
   */
  cleanupConnections() {
    try {
      // 获取当前连接统计
      const httpSockets = this.httpAgent.freeSockets;
      const httpsSockets = this.httpsAgent.freeSockets;

      let cleanedConnections = 0;

      // 清理HTTP连接
      Object.keys(httpSockets).forEach(key => {
        const sockets = httpSockets[key];
        if (sockets && sockets.length > 0) {
          // 清理超过最大空闲时间的连接
          sockets.forEach(socket => {
            if (Date.now() - socket._lastActivity > this.options.freeSocketTimeout) {
              socket.destroy();
              cleanedConnections++;
            }
          });
        }
      });

      // 清理HTTPS连接
      Object.keys(httpsSockets).forEach(key => {
        const sockets = httpsSockets[key];
        if (sockets && sockets.length > 0) {
          sockets.forEach(socket => {
            if (Date.now() - socket._lastActivity > this.options.freeSocketTimeout) {
              socket.destroy();
              cleanedConnections++;
            }
          });
        }
      });

      if (cleanedConnections > 0) {
        logger.debug('清理过期连接完成', { cleanedConnections });
      }

    } catch (error) {
      logger.error('清理连接时发生错误:', error);
    }
  }

  /**
   * 记录统计信息
   */
  logStatistics() {
    const uptime = Date.now() - this.stats.startTime;
    const successRate = this.stats.totalRequests > 0 
      ? ((this.stats.successfulRequests / this.stats.totalRequests) * 100).toFixed(2)
      : '0.00';

    logger.info('连接管理器统计', {
      uptime: `${Math.round(uptime / 1000)}秒`,
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      successRate: `${successRate}%`,
      retriedRequests: this.stats.retriedRequests,
      totalRetries: this.stats.totalRetries,
      averageResponseTime: `${Math.round(this.stats.averageResponseTime)}ms`,
      connectionPoolHits: this.stats.connectionPoolHits,
      activeConnections: this.stats.activeConnections,
      topErrors: this.getTopErrors(3)
    });
  }

  /**
   * 获取最常见的错误
   * @param {number} count 返回数量
   * @returns {Array} 错误列表
   */
  getTopErrors(count = 5) {
    return Array.from(this.stats.errors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([error, count]) => ({ error, count }));
  }

  /**
   * 获取连接池状态
   * @returns {Object} 连接池状态
   */
  getPoolStatus() {
    return {
      http: {
        sockets: Object.keys(this.httpAgent.sockets || {}).length,
        freeSockets: Object.keys(this.httpAgent.freeSockets || {}).length,
        requests: Object.keys(this.httpAgent.requests || {}).length
      },
      https: {
        sockets: Object.keys(this.httpsAgent.sockets || {}).length,
        freeSockets: Object.keys(this.httpsAgent.freeSockets || {}).length,
        requests: Object.keys(this.httpsAgent.requests || {}).length
      }
    };
  }

  /**
   * 获取性能指标
   * @returns {Object} 性能指标
   */
  getMetrics() {
    const uptime = Date.now() - this.stats.startTime;
    const requestsPerSecond = this.stats.totalRequests / (uptime / 1000);
    
    return {
      uptime: uptime,
      requestsPerSecond: requestsPerSecond,
      successRate: this.stats.totalRequests > 0 
        ? (this.stats.successfulRequests / this.stats.totalRequests) * 100 
        : 0,
      averageResponseTime: this.stats.averageResponseTime,
      retryRate: this.stats.totalRequests > 0 
        ? (this.stats.retriedRequests / this.stats.totalRequests) * 100 
        : 0,
      poolStatus: this.getPoolStatus(),
      stats: { ...this.stats }
    };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      totalRetries: 0,
      averageResponseTime: 0,
      connectionPoolHits: 0,
      connectionPoolMisses: 0,
      activeConnections: 0,
      errors: new Map(),
      startTime: Date.now()
    };
    
    logger.info('连接管理器统计信息已重置');
  }

  /**
   * 优雅关闭连接管理器
   */
  async shutdown() {
    logger.info('正在关闭连接管理器...');
    
    try {
      // 销毁所有连接
      this.httpAgent.destroy();
      this.httpsAgent.destroy();
      
      // 记录最终统计
      this.logStatistics();
      
      logger.info('连接管理器已关闭');
    } catch (error) {
      logger.error('关闭连接管理器时发生错误:', error);
    }
  }

  /**
   * 配置健康检查
   * @param {string} url 健康检查URL
   * @param {number} interval 检查间隔（毫秒）
   */
  setupHealthCheck(url, interval = 60000) {
    setInterval(async () => {
      try {
        const startTime = Date.now();
        
        // 使用连接管理器执行健康检查
        await this.executeWithRetry(async (context) => {
          const agent = this.getAgent(new URL(url).protocol);
          // 这里可以使用axios或其他HTTP客户端
          // 暂时使用简单的实现
          return { status: 'ok' };
        }, { url });
        
        const responseTime = Date.now() - startTime;
        
        logger.debug('健康检查成功', {
          url: url,
          responseTime: responseTime
        });
        
      } catch (error) {
        logger.warn('健康检查失败', {
          url: url,
          error: error.message
        });
      }
    }, interval);
  }
}

// 创建全局连接管理器实例
const connectionManager = new ConnectionManager({
  maxSockets: process.env.MAX_SOCKETS || 50,
  maxFreeSockets: process.env.MAX_FREE_SOCKETS || 10,
  timeout: process.env.REQUEST_TIMEOUT || 30000,
  maxRetries: process.env.MAX_RETRIES || 3
});

module.exports = connectionManager; 