const http = require('http');
const https = require('https');
const logger = require('./logger');
const browserFingerprint = require('./browser-fingerprint');
const cloudflareHandler = require('./cloudflare-handler');
const {
  ProxyError,
  InvalidTargetUrlError, // 虽然这里不直接抛出，但保持引入的完整性
  AccessDeniedError,     // 同上
  TargetNotFoundError,
  TargetConnectionRefusedError,
  RequestTimeoutError,
  ConfigurationError
} = require('./errors'); // 引入自定义错误

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
      rejectUnauthorized: true, // <--- 修改：默认为 true 以增强安全性
      minVersion: 'TLSv1.2', // 保持最低TLS版本要求
      // maxVersion: 'TLSv1.3', // Node.js会自动协商，通常不需要显式设置上限
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
      // ].join(':'), // 移除，让Node.js自动协商
      // honorCipherOrder: true, // 移除，让Node.js自动协商
      // ALPNProtocols: ['h2', 'http/1.1'] // 移除，让Node.js自动协商
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
   * 尝试处理Cloudflare质询并重新执行操作
   * @private
   * @param {Function} operation 原始操作
   * @param {Object} context 请求上下文
   * @param {number} attempt 当前尝试次数 (用于日志)
   * @param {Object} initialResponse 触发Cloudflare检测的初始响应
   * @returns {Promise<Object>} 如果绕过成功，返回新响应；否则返回初始响应或抛出错误
   */
  async _handleCloudflareChallenge(operation, context, attempt, initialResponse) {
    logger.info('检测到Cloudflare验证，尝试绕过', { url: context.url, status: initialResponse.status });
    this.stats.cloudflareBypassAttempts++;

    // Prepare fingerprint data for CloudflareHandler
    // context.headers already contains the User-Agent and other fingerprinted headers
    const fingerprintForCfHandler = {
      userAgent: context.headers['user-agent'], // Extract UA from current context headers
      headers: { ...context.headers } // Pass a copy of all current headers
    };

    try {
      const bypassResult = await cloudflareHandler.bypassCloudflare(context.url, fingerprintForCfHandler);
      if (bypassResult.success) {
        this.stats.cloudflareBypassSuccesses++;
        logger.info('Cloudflare绕过成功', { url: context.url, cookies: bypassResult.cookies ? bypassResult.cookies.length : 0 });

        // 更新请求头部以包含获取的Cookie和更新后的指纹/UA
        if (context.headers) {
          if (bypassResult.cookies && bypassResult.cookies.length > 0) {
            const cookieString = cloudflareHandler.formatCookiesForRequest(bypassResult.cookies);
            context.headers['cookie'] = context.headers['cookie'] ? 
              `${context.headers['cookie']}; ${cookieString}` : cookieString;
          }
          if (bypassResult.userAgent) { // 如果CF处理器返回了新的UA
            context.headers['user-agent'] = bypassResult.userAgent;
          }
        }
        
        // 重新执行原始请求
        const newResponse = await this.executeOperation(operation, context, attempt, true); // pass a flag indicating it's a post-CF-bypass request
        logger.info('Cloudflare绕过后重新请求完成', { url: context.url, newStatus: newResponse.status });
        return newResponse;
      } else {
        logger.warn('Cloudflare绕过未能成功，使用原始响应', { url: context.url, reason: bypassResult.error });
        return initialResponse; // 返回原始响应如果绕过不成功但没有抛错
      }
    } catch (bypassError) {
      logger.warn('Cloudflare绕过过程中发生错误:', { url: context.url, error: bypassError.message });
      // 发生错误时，也返回原始响应，让外层重试逻辑处理
      return initialResponse; 
    }
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
        if (this.options.cloudflareBypass && this.isCloudflareResponse(response) && !context.isPostCloudflareBypass) {
          response = await this._handleCloudflareChallenge(operation, context, attempt, response);
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
      finalError: lastError.message,
      errorCode: lastError.code,
      errorStack: lastError.stack // 添加堆栈信息以便调试
    });

    // 将常见的底层错误转换为自定义的 ProxyError 子类
    if (lastError.code) {
      switch (lastError.code) {
        case 'ENOTFOUND':
          throw new TargetNotFoundError(`无法解析目标服务器: ${context.url}`, lastError);
        case 'ECONNREFUSED':
          throw new TargetConnectionRefusedError(`目标服务器拒绝连接: ${context.url}`, lastError);
        case 'ETIMEDOUT': // 通常由axios的timeout选项触发
        case 'ESOCKETTIMEDOUT': // Node.js net.Socket timeout
          throw new RequestTimeoutError(`请求超时: ${context.url}`, lastError);
        // 可以根据需要添加更多 case，例如 'ECONNRESET', 'EHOSTUNREACH' 等
        // case 'ECONNRESET':
        //   throw new ProxyError('连接被重置', 502, lastError);
      }
    }
    
    // 如果是 axios 错误，并且有响应 (例如 4xx, 5xx 错误且 validateStatus 返回 true)
    // 这种错误通常应该由 performHttpRequest -> proxyHandler 直接处理，而不是在这里包装
    // 但如果 validateStatus 导致 axios 抛出错误，可以考虑包装
    if (lastError.isAxiosError && lastError.response) {
        // 这种情况通常意味着上游返回了一个错误，但我们并未在 shouldRetry 中处理它
        // 或者 shouldRetry 返回 false。此时，将原始 axios 错误抛出，让 proxyHandler 处理
        throw lastError; 
    }

    // 对于其他未明确转换的错误，可以抛出通用的 ProxyError 或原始错误
    // 抛出原始错误，让 proxyHandler 的 catch 块做最后的判断
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
   * @param {boolean} [isPostCloudflareBypass=false] 是否是CF绕过后的请求
   * @returns {Promise} 结果
   */
  async executeOperation(operation, context, attempt, isPostCloudflareBypass = false) {
    // 为重试添加特殊标头
    if (attempt > 0 && context.headers) {
      context.headers['x-retry-attempt'] = attempt.toString();
    }
    context.isPostCloudflareBypass = isPostCloudflareBypass; // 标记是否CF绕过后的请求

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
      if (cloudflareHandler && typeof cloudflareHandler.close === 'function') { // 安全检查
        await cloudflareHandler.close();
      }
      
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
    if (!url) {
      logger.info('未配置健康检查URL，跳过设置。');
      return;
    }
    logger.info('设置健康检查', { url, intervalMs: interval });

    const healthCheckOperation = async (context) => {
      return new Promise((resolve, reject) => {
        const requestUrl = new URL(context.url);
        const agent = this.getAgent(requestUrl.protocol);
        const requestModule = requestUrl.protocol === 'https:' ? https : http;

        const options = {
          agent: agent,
          method: 'GET',
          timeout: this.options.timeout / 2, // 使用连接超时的一半作为健康检查超时
          headers: browserFingerprint.applyFingerprint({}, requestUrl.hostname) // 应用基础指纹
        };

        const req = requestModule.request(requestUrl, options, (res) => {
          let responseData = '';
          res.on('data', chunk => responseData += chunk);
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data: responseData, headers: res.headers });
            } else {
              logger.warn('健康检查响应状态码异常', { url: context.url, statusCode: res.statusCode });
              // 仍然 resolve，但可以被 shouldRetry 捕获（如果配置了对特定状态码的重试）
              // 或者在外层 executeWithRetry 中根据状态码决定是否为失败
              resolve({ status: res.statusCode, data: responseData, headers: res.headers }); 
            }
          });
        });

        req.on('error', (e) => {
          logger.warn('健康检查请求错误', { url: context.url, error: e.message });
          reject(e);
        });

        req.on('timeout', () => {
          req.abort();
          logger.warn('健康检查请求超时', { url: context.url });
          reject(new Error('Health check request timed out'));
        });
        req.end();
      });
    };

    setInterval(async () => {
      try {
        const startTime = Date.now();
        logger.debug('执行健康检查...', { url });

        // 使用 executeWithRetry 执行健康检查，但不进行Cloudflare处理
        const currentMaxRetries = this.options.maxRetries;
        const currentCfBypass = this.options.cloudflareBypass;
        this.options.maxRetries = 1; // 健康检查通常不需要多次重试或快速失败
        this.options.cloudflareBypass = false; // 健康检查不应触发CF绕过

        const healthResponse = await this.executeWithRetry(healthCheckOperation, { url });
        
        this.options.maxRetries = currentMaxRetries; // 恢复原始设置
        this.options.cloudflareBypass = currentCfBypass; // 恢复原始设置

        const responseTime = Date.now() - startTime;
        
        if (healthResponse.status >= 200 && healthResponse.status < 300) {
            logger.info('健康检查成功', { url, status: healthResponse.status, responseTime });
        } else {
            logger.warn('健康检查失败（最终状态码非2xx）', { url, status: healthResponse.status, responseTime });
        }
        
      } catch (error) {
        // 如果 executeWithRetry 最终抛出错误
        logger.warn('健康检查最终失败（异常）', { url, error: error.message });
        // 可以在这里添加更复杂的逻辑，例如标记服务不健康等
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