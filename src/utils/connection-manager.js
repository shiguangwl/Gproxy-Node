const http = require('http');
const https = require('https');
const logger = require('./logger');
const browserFingerprint = require('./browser-fingerprint');
const cloudflareHandler = require('./cloudflare-handler');

/**
 * 增强的连接池管理器
 * 提供HTTP/HTTPS连接池、智能重试、性能监控、Cloudflare支持等功能
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
      cloudflareBypass: options.cloudflareBypass !== false,
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
      cloudflareBypassAttempts: 0,
      cloudflareBypassSuccesses: 0,
      errors: new Map(), // 错误类型统计
      startTime: Date.now()
    };

    // 创建增强的HTTP代理
    this.httpAgent = new http.Agent({
      keepAlive: this.options.keepAlive,
      keepAliveMsecs: this.options.keepAliveMsecs,
      timeout: this.options.timeout,
      freeSocketTimeout: this.options.freeSocketTimeout,
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets
    });

    // 创建增强的HTTPS代理，支持现代TLS配置
    this.httpsAgent = new https.Agent({
      keepAlive: this.options.keepAlive,
      keepAliveMsecs: this.options.keepAliveMsecs,
      timeout: this.options.timeout,
      freeSocketTimeout: this.options.freeSocketTimeout,
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets,
      // 增强的TLS配置
      rejectUnauthorized: false, // 改回false以兼容更多网站
      minVersion: 'TLSv1.2', // 保持最低TLS版本要求
      // maxVersion: 'TLSv1.3', // 暂时注释掉，让Node自动协商
      // ciphers: [
      //   'TLS_AES_128_GCM_SHA256',
      //   'TLS_AES_256_GCM_SHA384',
      //   'TLS_CHACHA20_POLY1305_SHA256',
      //   'ECDHE-ECDSA-AES128-GCM-SHA256',
      //   'ECDHE-RSA-AES128-GCM-SHA256',
      //   'ECDHE-ECDSA-AES256-GCM-SHA384',
      //   'ECDHE-RSA-AES256-GCM-SHA384',
      //   'ECDHE-ECDSA-CHACHA20-POLY1305',
      //   'ECDHE-RSA-CHACHA20-POLY1305',
      //   'DHE-RSA-AES128-GCM-SHA256',
      //   'DHE-RSA-AES256-GCM_SHA384'
      // ].join(':'), // 暂时注释掉自定义密码套件
      // honorCipherOrder: true, // 暂时注释掉
      // ALPNProtocols: ['h2', 'http/1.1'] // 暂时注释掉ALPN
    });

    // 监听连接事件
    this.setupEventListeners();

    // 定期清理和统计
    this.setupMaintenanceTasks();

    logger.info('增强连接管理器初始化完成', {
      maxSockets: this.options.maxSockets,
      maxFreeSockets: this.options.maxFreeSockets,
      timeout: this.options.timeout,
      keepAlive: this.options.keepAlive,
      cloudflareBypass: this.options.cloudflareBypass
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

    // TLS错误处理
    this.httpsAgent.on('error', (error) => {
      logger.warn('HTTPS Agent错误:', error.message);
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

    // 每小时更新浏览器指纹
    setInterval(() => {
      browserFingerprint.clearCache();
      logger.debug('浏览器指纹缓存已清理');
    }, 3600000);
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
   * 智能重试策略（增强版，支持Cloudflare检测）
   * @param {Function} operation 要执行的操作
   * @param {Object} context 上下文信息
   * @returns {Promise} 操作结果
   */
  async executeWithRetry(operation, context = {}) {
    const startTime = Date.now();
    this.stats.totalRequests++;

    let lastError;
    let attempt = 0;
    let response = null;

    // 获取域名用于指纹管理
    const domain = context.url ? new URL(context.url).hostname : null;

    while (attempt <= this.options.maxRetries) {
      try {
        // 应用浏览器指纹
        if (context.headers && domain) {
          context.headers = browserFingerprint.applyFingerprint(context.headers, domain);
        }

        // 添加随机延迟以模拟人类行为
        if (attempt > 0) {
          const delay = browserFingerprint.getRandomDelay();
          await this.sleep(delay);
        }

        response = await this.executeOperation(operation, context, attempt);
        
        // 检查是否遇到Cloudflare验证
        if (this.options.cloudflareBypass && this.isCloudflareResponse(response)) {
          logger.info('检测到Cloudflare验证，尝试绕过', {
            url: context.url,
            status: response.status
          });

          this.stats.cloudflareBypassAttempts++;

          try {
            const bypassResult = await cloudflareHandler.bypassCloudflare(context.url);
            if (bypassResult.success) {
              this.stats.cloudflareBypassSuccesses++;
              
              // 更新请求头部以包含获取的Cookie
              if (context.headers && bypassResult.cookies.length > 0) {
                const cookieString = cloudflareHandler.formatCookiesForRequest(bypassResult.cookies);
                context.headers['cookie'] = context.headers['cookie'] ? 
                  context.headers['cookie'] + '; ' + cookieString : cookieString;
              }

              // 重新执行原始请求
              response = await this.executeOperation(operation, context, attempt);
              
              logger.info('Cloudflare绕过成功，重新请求完成', {
                url: context.url,
                newStatus: response.status
              });
            }
          } catch (bypassError) {
            logger.warn('Cloudflare绕过失败:', bypassError.message);
            // 继续使用原始响应
          }
        }

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
          responseTime: responseTime,
          status: response.status
        });

        return response;

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
   * 检查是否是Cloudflare响应
   */
  isCloudflareResponse(response) {
    if (!response) return false;

    // 检查状态码
    const cloudflareStatusCodes = [403, 503, 520, 521, 522, 523, 524, 525, 526, 527, 530];
    if (cloudflareStatusCodes.includes(response.status)) {
      return true;
    }

    // 检查响应头
    const headers = response.headers || {};
    if (headers['server'] && headers['server'].toLowerCase().includes('cloudflare')) {
      return true;
    }

    if (headers['cf-ray'] || headers['cf-cache-status']) {
      return true;
    }

    // 检查响应内容
    if (response.data) {
      const content = Buffer.isBuffer(response.data) ? 
        response.data.toString() : response.data;
      
      if (typeof content === 'string') {
        const cloudflarePatterns = [
          /cloudflare/i,
          /checking your browser/i,
          /ddos protection/i,
          /ray id:/i,
          /__cf_chl_jschl_tk__/i
        ];
        
        return cloudflarePatterns.some(pattern => pattern.test(content));
      }
    }

    return false;
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
      'EHOSTUNREACH',
      'EPIPE',
      'EPROTO'
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
      const retryableStatusCodes = [408, 429, 503]; // 请求超时、请求过多、服务不可用
      if (retryableStatusCodes.includes(status)) {
        return true;
      }

      // Cloudflare相关状态码
      const cloudflareStatusCodes = [520, 521, 522, 523, 524, 525, 526, 527, 530];
      if (cloudflareStatusCodes.includes(status)) {
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
    
    return Math.min(exponentialDelay + jitter, 30000); // 最大30秒
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

    const cloudflareBypassRate = this.stats.cloudflareBypassAttempts > 0 
      ? ((this.stats.cloudflareBypassSuccesses / this.stats.cloudflareBypassAttempts) * 100).toFixed(2)
      : '0.00';

    logger.info('增强连接管理器统计', {
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
      cloudflareBypassAttempts: this.stats.cloudflareBypassAttempts,
      cloudflareBypassSuccesses: this.stats.cloudflareBypassSuccesses,
      cloudflareBypassRate: `${cloudflareBypassRate}%`,
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
      cloudflareBypassRate: this.stats.cloudflareBypassAttempts > 0 
        ? (this.stats.cloudflareBypassSuccesses / this.stats.cloudflareBypassAttempts) * 100 
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
      cloudflareBypassAttempts: 0,
      cloudflareBypassSuccesses: 0,
      errors: new Map(),
      startTime: Date.now()
    };
    
    logger.info('连接管理器统计信息已重置');
  }

  /**
   * 优雅关闭连接管理器
   */
  async shutdown() {
    logger.info('正在关闭增强连接管理器...');
    
    try {
      // 关闭Cloudflare处理器
      await cloudflareHandler.close();
      
      // 销毁所有连接
      this.httpAgent.destroy();
      this.httpsAgent.destroy();
      
      // 记录最终统计
      this.logStatistics();
      
      logger.info('增强连接管理器已关闭');
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
  maxRetries: process.env.MAX_RETRIES || 3,
  cloudflareBypass: process.env.CLOUDFLARE_BYPASS !== 'false'
});

module.exports = connectionManager; 