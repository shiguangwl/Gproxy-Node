const axios = require('axios');
const { ProxyResponse } = require('./entities');
const logger = require('./utils/logger');
const connectionManager = require('./utils/connection-manager');
const configLoader = require('../config/config-loader');
const cloudflareHandler = require('./utils/cloudflare-handler');
const browserFingerprint = require('./utils/browser-fingerprint');
const {
  ProxyError,
  AccessDeniedError,
  TargetConnectionRefusedError, 
  TargetNotFoundError, 
  RequestTimeoutError,
  ConfigurationError,
  HandlerError
} = require('./utils/errors');

/**
 * 增强的代理处理器核心函数
 * @param {ProxyRequest} requestInfo 代理请求信息
 * @param {Upstream} upstream 上游服务器信息
 * @param {Array} preHandlers 前置处理器数组
 * @param {Array} postHandlers 后置处理器数组
 * @returns {ProxyResponse} 代理响应对象
 */
async function proxyHandler(requestInfo, upstream, preHandlers = [], postHandlers = []) {
  let processedRequest = requestInfo;
  let mainProxyResponse;

  try {
    // Stage 1: Pre-handlers
    for (const handler of preHandlers) {
      if (typeof handler === 'function') {
        processedRequest = handler(upstream, processedRequest);
      }
    }

    // Stage 2: Deny list
    const upstreamUrl = upstream.site + processedRequest.urlNoSite;
    const denyRequestList = configLoader.getConfig().denyRequestList;
    for (const denyPattern of denyRequestList) {
      if (new RegExp(denyPattern).test(processedRequest.urlNoSite)) {
        logger.warn('请求被拒绝列表阻止 (proxyHandler):', processedRequest.urlNoSite);
        throw new AccessDeniedError('请求被策略拒绝 (proxyHandler)');
      }
    }
    logger.debug('代理请求（前置处理后）:', { url: upstreamUrl, method: processedRequest.method });

    // Stage 3: Execute request
    const rawResponse = await connectionManager.executeWithRetry(
      async (context) => performHttpRequest(context),
      {
        url: upstreamUrl,
        method: processedRequest.method,
        headers: processedRequest.headers,
        data: processedRequest.data,
        isMedia: isMediaRequest(processedRequest.urlNoSite, configLoader.getConfig().mediaRequestUrlPatterns),
        isLargeFile: isLargeFileRequest(processedRequest.urlNoSite, configLoader.getConfig().largeFileUrlPatterns),
        requestInfo: processedRequest
      }
    );
    mainProxyResponse = new ProxyResponse(rawResponse);
    mainProxyResponse.proxyRequest = processedRequest;
    mainProxyResponse.cloudflareBypassUsed = rawResponse.headers?.['x-gproxy-cf-bypass-used'] === 'true';
    logger.info('从上游接收到响应', { status: mainProxyResponse.statusCode });

    // Stage 4: Post-handlers
    let finalResponse = mainProxyResponse;
    for (const handler of postHandlers) {
      if (typeof handler === 'function') {
        finalResponse = await handler(upstream, finalResponse);
      }
    }
    return finalResponse;

  } catch (error) {
    const errorContextUrl = upstream ? (upstream.site + (processedRequest?.urlNoSite || requestInfo.urlNoSite)) : requestInfo.url;
    logger.error('代理处理流程错误:', {
      url: errorContextUrl,
      method: requestInfo.method,
      errorName: error.name,
      errorMessage: error.message,
      handlerName: error instanceof HandlerError ? error.handlerName : undefined,
      statusCodeFromError: error.statusCode, // Log the status code from the error itself if present
      originalStack: error.originalError ? error.originalError.stack : error.stack 
    });

    if (error instanceof AccessDeniedError) {
      return createErrorResponse(error.statusCode, error.message, requestInfo, error.name);
    }
    if (error instanceof HandlerError) {
      return createErrorResponse(error.statusCode || 500, 
        `处理环节 '${error.handlerName}' 执行失败: ${error.message}`,
        requestInfo, error.name);
    }
    // Check for specific ProxyError subtypes from ConnectionManager or entities.js before generic ProxyError
    if (error instanceof TargetNotFoundError || 
        error instanceof TargetConnectionRefusedError || 
        error instanceof RequestTimeoutError || 
        error instanceof InvalidUrlError || 
        error instanceof RequestConversionError ||
        error instanceof ConfigurationError) {
      return createErrorResponse(error.statusCode, error.message, requestInfo, error.name);
    }
    // Generic ProxyError if not caught by more specific types above
    if (error instanceof ProxyError) { 
      return createErrorResponse(error.statusCode, error.message, requestInfo, error.name);
    }
    if (error.isAxiosError && error.response) {
      const upstreamErrorResponse = new ProxyResponse(error.response);
      upstreamErrorResponse.proxyRequest = requestInfo; 
      return createErrorResponse(upstreamErrorResponse.statusCode, 
                                 upstreamErrorResponse.response?.statusText || '上游服务器返回错误', 
                                 requestInfo, 
                                 'UpstreamHTTPError');
    }
    return createErrorResponse(500, '代理服务器发生未知内部错误', requestInfo, 'UnknownProxyError');
  }
}

/**
 * 判断是否应该尝试Cloudflare绕过
 */
function shouldAttemptCloudflareBypass(error, response) {
  // 检查错误状态码
  if (error.response) {
    const status = error.response.status;
    const cloudflareStatusCodes = [403, 503, 520, 521, 522, 523, 524, 525, 526, 527, 530];
    if (cloudflareStatusCodes.includes(status)) {
      return true;
    }

    // 检查响应头
    const headers = error.response.headers || {};
    if (headers['server'] && headers['server'].toLowerCase().includes('cloudflare')) {
      return true;
    }

    if (headers['cf-ray'] || headers['cf-cache-status']) {
      return true;
    }
  }

  // 检查错误消息
  const errorMessage = error.message.toLowerCase();
  const cloudflareKeywords = ['cloudflare', 'cf-ray', 'ddos protection', 'checking your browser'];
  return cloudflareKeywords.some(keyword => errorMessage.includes(keyword));
}

/**
 * 判断是否是Cloudflare错误
 */
function isCloudflareError(error) {
  if (error.response) {
    const status = error.response.status;
    const cloudflareStatusCodes = [520, 521, 522, 523, 524, 525, 526, 527, 530];
    return cloudflareStatusCodes.includes(status);
  }
  return false;
}

/**
 * 生成通用错误页面的HTML
 * @private
 */
function _generateGenericErrorHtml(statusCode, message, requestInfo, errorType) {
  const errorRequestId = requestInfo?.headers?.['x-gproxy-request-id'] || generateRequestId();
  const serverVersion = process.env.npm_package_version || '2.1.0'; // 尝试从 package.json 获取版本

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <title>代理错误 ${statusCode}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 600px; text-align: center; }
        .error-code { font-size: 4em; font-weight: bold; color: #e74c3c; margin-bottom: 20px; }
        .error-message { font-size: 1.2em; margin-bottom: 30px; color: #555; }
        .details { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: left; font-family: monospace; font-size: 0.9em; word-break: break-all; }
        .retry-btn { background: #3498db; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 1em; margin: 10px; transition: background 0.3s; }
        .retry-btn:hover { background: #2980b9; }
        .footer { margin-top: 30px; color: #7f8c8d; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-code">${statusCode}</div>
        <div class="error-message">${message}</div>
        <div class="details">
            <strong>时间:</strong> ${new Date().toLocaleString('zh-CN')}<br>
            <strong>代理服务器:</strong> Gproxy-Node v${serverVersion}<br>
            <strong>请求ID:</strong> ${errorRequestId}<br>
            <strong>错误类型:</strong> ${errorType || getErrorType(statusCode)}
        </div>
        <button class="retry-btn" onclick="location.reload()">重试</button>
        <button class="retry-btn" onclick="history.back()">返回</button>
        <div class="footer">
            如果问题持续存在，请联系管理员或稍后重试。
        </div>
    </div>
</body>
</html>`;
}

/**
 * 生成Cloudflare错误页面的HTML
 * @private
 */
function _generateCloudflareErrorHtml(status, statusText, requestInfo) {
  const errorRequestId = requestInfo?.headers?.['x-gproxy-request-id'] || generateRequestId();
  const serverVersion = process.env.npm_package_version || '2.1.0';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <title>Cloudflare 错误 ${status}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 40px; background: linear-gradient(135deg, #ff7b7b 0%, #ff416c 100%); color: #333; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 600px; text-align: center; }
        .error-code { font-size: 4em; font-weight: bold; color: #ff416c; margin-bottom: 20px; }
        .error-message { font-size: 1.2em; margin-bottom: 30px; color: #555; }
        .details { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: left; font-family: monospace; font-size: 0.9em; word-break: break-all; }
        .retry-btn { background: #ff416c; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 1em; margin: 10px; transition: background 0.3s; }
        .retry-btn:hover { background: #e73c57; }
        .footer { margin-top: 30px; color: #7f8c8d; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-code">${status}</div>
        <div class="error-message">${statusText}</div>
        <div class="details">
            <strong>错误类型:</strong> Cloudflare 服务错误<br>
            <strong>时间:</strong> ${new Date().toLocaleString('zh-CN')}<br>
            <strong>代理服务器:</strong> Gproxy-Node v${serverVersion}<br>
            <strong>请求ID:</strong> ${errorRequestId}<br>
            <strong>建议:</strong> 网站可能正在维护或遇到流量限制。
        </div>
        <button class="retry-btn" onclick="location.reload()">重试</button>
        <button class="retry-btn" onclick="history.back()">返回</button>
        <div class="footer">
            这是一个Cloudflare服务错误，通常是临时性的。<br>
            代理服务器已尝试自动处理，如果问题持续请稍后重试。
        </div>
    </div>
</body>
</html>`;
}

/**
 * 创建Cloudflare错误响应
 */
function createCloudflareErrorResponse(error, requestInfo) {
  const status = error.response?.status || 503;
  const statusText = getCloudflareErrorMessage(status);
  
  const errorHtml = _generateCloudflareErrorHtml(status, statusText, requestInfo);

  return {
    content: Buffer.from(errorHtml),
    statusCode: status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-gproxy-error': 'cloudflare',
      'x-gproxy-error-code': status.toString()
    },
    isRedirect: false,
    contentType: 'text/html; charset=utf-8'
  };
}

/**
 * 获取Cloudflare错误消息
 */
function getCloudflareErrorMessage(status) {
  const messages = {
    520: '未知错误 - 网站返回了未知错误',
    521: '网站服务器离线 - 网站服务器拒绝连接',
    522: '连接超时 - 网站服务器响应超时',
    523: '源站不可达 - 无法连接到网站服务器',
    524: '超时发生 - 网站服务器未及时响应',
    525: 'SSL握手失败 - SSL/TLS握手失败',
    526: '无效的SSL证书 - 网站SSL证书无效',
    527: 'Railgun错误 - Railgun连接错误',
    530: '冻结网站 - 网站已被冻结'
  };
  
  return messages[status] || '服务暂时不可用';
}

/**
 * 构建 Axios 请求配置的辅助函数
 * @private
 * @param {Object} context 请求上下文 (url, method, headers, data, isMedia, isLargeFile, requestInfo)
 * @param {http.Agent | https.Agent} agent 要使用的 Agent
 * @returns {import('axios').AxiosRequestConfig}
 */
function _buildAxiosConfig(context, agent) {
  const { url, method, headers, data, isMedia, isLargeFile } = context;
  // const urlObj = new URL(url); // 不再需要，domain由ConnectionManager处理
  // const domain = urlObj.hostname;

  // 基础 Axios 配置
  const axiosConfig = {
    method: method,
    url: url,
    // headers: browserFingerprint.applyFingerprint({ ...headers }, domain), // <--- 移除这里的指纹应用
    headers: { ...headers }, // 直接使用传入的、可能已被ConnectionManager处理过的headers
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 30000, // 默认超时
    maxRedirects: 5,
    validateStatus: () => true, // 接受所有状态码
    responseType: 'arraybuffer',
    decompress: true,
    maxContentLength: 50 * 1024 * 1024, // 50MB 默认限制
    maxBodyLength: 50 * 1024 * 1024,
    transformResponse: [(data) => data] // 不转换响应数据
  };

  // 根据请求类型调整配置
  if (isMedia) {
    axiosConfig.timeout = 60000;
    axiosConfig.maxRedirects = 0; // 媒体请求通常不应自动重定向
    // axiosConfig.httpVersion = '1.1'; // 通常不需要强制，除非特定场景
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'accept': '*/*',
      // 'cache-control': 'no-cache', // 可能过于激进，除非特定需求
      // 'connection': 'keep-alive' // axios 会自动处理
    };
  } else if (isLargeFile) {
    axiosConfig.timeout = 300000; // 5分钟超时
    axiosConfig.maxContentLength = Infinity;
    axiosConfig.maxBodyLength = Infinity;
    axiosConfig.headers = {
      ...axiosConfig.headers,
      // 'accept-encoding': 'gzip, deflate', // axios 默认会处理 accept-encoding
      // 'connection': 'keep-alive'
    };
  } else {
    // 普通请求
    axiosConfig.headers = {
      ...axiosConfig.headers,
      // 'accept-encoding': 'gzip, deflate, br' // axios 默认会处理
    };
  }

  // 添加请求体
  if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    axiosConfig.data = data;
  }

  // 添加自定义请求头
  axiosConfig.headers['x-gproxy-request-id'] = generateRequestId();
  axiosConfig.headers['x-gproxy-timestamp'] = Date.now().toString();

  return axiosConfig;
}

/**
 * 执行HTTP请求（增强版）
 * @param {Object} context 请求上下文
 * @returns {Promise} axios响应对象
 */
async function performHttpRequest(context) {
  const { url } = context; 
  const urlObj = new URL(url);
  const agent = connectionManager.getAgent(urlObj.protocol);
  
  const axiosConfig = _buildAxiosConfig(context, agent);
  
  // 添加一些随机延迟以模拟人类行为 (移到 connectionManager.executeWithRetry 循环中更合适)
  // const delay = browserFingerprint.getRandomDelay();
  // if (delay > 0) {
  //   await new Promise(resolve => setTimeout(resolve, delay));
  // }

  return await axios(axiosConfig);
}

/**
 * 生成请求ID
 * @returns {string} 请求ID
 */
function generateRequestId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

/**
 * 判断是否是媒体请求
 * @param {string} urlPath URL路径
 * @returns {boolean} 是否是媒体请求
 */
function isMediaRequest(urlPath) {
  const config = configLoader.getConfig();
  const mediaPatterns = config.mediaRequestUrlPatterns || [];
  if (mediaPatterns.length === 0) {
    // Fallback to hardcoded if not in config or empty, or log a warning
    logger.warn('media_request_url_patterns not configured or empty, using internal defaults.');
    const defaultMediaPatterns = [
        /\.(mp4|avi|mkv|mov|wmv|flv|webm)(\?|$)/i, 
        /\.(mp3|wav|flac|aac|ogg|m4a)(\?|$)/i,    
        /videoplayback/i,                           
        /googlevideo\.com/i,                        
        /ytimg\.com.*\.(jpg|jpeg|png|webp)/i,      
        /\/stream\//i,                              
        /\/video\//i,                               
        /\/audio\//i,                               
        /\/media\//i,                               
        /manifest\.(m3u8|mpd)/i,                   
        /\.ts(\?|$)/i,                             
        /chunk.*\.m4s/i,                           
        /segment.*\.(ts|m4s)/i                     
      ];
    return defaultMediaPatterns.some(pattern => pattern.test(urlPath));
  }
  return mediaPatterns.some(pattern => pattern.test(urlPath));
}

/**
 * 判断是否是大文件请求
 * @param {string} urlPath URL路径
 * @returns {boolean} 是否是大文件请求
 */
function isLargeFileRequest(urlPath) {
  const config = configLoader.getConfig();
  const largeFilePatterns = config.largeFileUrlPatterns || [];
  if (largeFilePatterns.length === 0) {
    logger.warn('large_file_url_patterns not configured or empty, using internal defaults.');
    const defaultLargeFilePatterns = [
        /\.(zip|rar|7z|tar|gz|bz2)(\?|$)/i,        
        /\.(iso|img|dmg)(\?|$)/i,                  
        /\.(pdf|doc|docx|ppt|pptx|xls|xlsx)(\?|$)/i, 
        /\/download\//i,                            
        /\/files\//i,                               
        /\.exe(\?|$)/i,                             
        /\.msi(\?|$)/i,                             
        /\.pkg(\?|$)/i,                             
        /\.deb(\@|$)/i,                             
        /\.rpm(\@|$)/i                              
      ];
    return defaultLargeFilePatterns.some(pattern => pattern.test(urlPath));
  }
  return largeFilePatterns.some(pattern => pattern.test(urlPath));
}

/**
 * 创建错误响应对象
 * @param {number} statusCode HTTP状态码
 * @param {string} message 错误消息
 * @returns {ProxyResponse} 错误响应对象
 */
function createErrorResponse(statusCode, message, requestInfo, errorType = 'ProxyError') {
  const errorHtml = _generateGenericErrorHtml(statusCode, message, requestInfo, errorType);
 
  return {
    content: Buffer.from(errorHtml),
    statusCode: statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-gproxy-error': 'true',
      'x-gproxy-error-code': statusCode.toString(),
      'x-gproxy-version': '2.1.0'
    },
    isRedirect: false,
    contentType: 'text/html; charset=utf-8'
  };
}

/**
 * 获取错误类型描述
 * @param {number} statusCode 状态码
 * @returns {string} 错误类型
 */
function getErrorType(statusCode) {
  if (statusCode >= 500) return '服务器错误';
  if (statusCode >= 400) return '客户端错误';
  if (statusCode >= 300) return '重定向';
  return '未知错误';
}

/**
 * 流式代理处理器（用于大文件）
 * @param {ProxyRequest} requestInfo 代理请求信息
 * @param {Upstream} upstream 上游服务器信息
 * @param {Response} res Express响应对象
 * @param {Array} preHandlers 前置处理器数组
 */
async function streamProxyHandler(requestInfo, upstream, res, preHandlers = []) {
  let processedRequest = requestInfo;
  try {
    // Execute pre-handlers for the stream request
    for (const handler of preHandlers) {
      if (typeof handler === 'function') {
        processedRequest = handler(upstream, processedRequest);
      }
    }

    // Deny list check specifically for stream handler (after its pre-handlers)
    const upstreamUrlForStream = upstream.site + processedRequest.urlNoSite;
    const denyRequestListStream = configLoader.getConfig().denyRequestList;
    for (const denyPattern of denyRequestListStream) {
      if (new RegExp(denyPattern).test(processedRequest.urlNoSite)) {
        logger.warn('流式请求被拒绝列表阻止 (streamProxyHandler):', processedRequest.urlNoSite);
        if (!res.headersSent) {
          res.status(403).json({ error: 'Access Denied by policy (stream)', message: '请求被策略拒绝' });
        }
        return; // Stop processing
      }
    }

    logger.debug('发起流式代理请求 (前置处理后)', { method: processedRequest.method, url: upstreamUrlForStream });

    // Original core streaming logic (with its own try-catch for streaming-specific errors)
    // This try-catch is for errors during the streaming setup or connectionManager call for stream.
    try {
      const response = await connectionManager.executeWithRetry(
        async (context) => {
          const urlObj = new URL(context.url);
          const agent = connectionManager.getAgent(urlObj.protocol);
          return axios({
            method: context.method,
            url: context.url,
            headers: context.headers, // Headers already processed by pre-handlers and fingerprinting
            data: context.data,
            httpAgent: agent,
            httpsAgent: agent,
            timeout: 300000, 
            responseType: 'stream',
            validateStatus: () => true
          });
        },
        {
          url: upstreamUrlForStream,
          method: processedRequest.method,
          headers: processedRequest.headers,
          data: processedRequest.data
        }
      );

      res.status(response.status);
      const allowedHeaders = [ /* ... as before ... */ 'content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control'];
      allowedHeaders.forEach(header => { if (response.headers[header]) res.set(header, response.headers[header]); });
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('X-Accel-Buffering', 'no'); 
      res.set('Cache-Control', 'no-cache');

      response.data.pipe(res);
      response.data.on('error', (streamError) => {
        logger.error('流式传输错误:', { url: upstreamUrlForStream, error: streamError.message });
        if (!res.headersSent) res.status(500).json({ error: 'Stream Error', details: streamError.message });
        else if (!res.writableEnded) res.end();
      });
      response.data.on('end', () => {
        logger.info('流式代理请求完成', { url: upstreamUrlForStream, status: response.status });
      });

    } catch (streamCoreError) {
      logger.error('流式代理核心逻辑错误:', { url: upstreamUrlForStream, errorName: streamCoreError.name, error: streamCoreError.message, stack: streamCoreError.stack });
      if (!res.headersSent) {
        const statusCode = (streamCoreError instanceof ProxyError) ? streamCoreError.statusCode : 500;
        res.status(statusCode).json({ error: '流式代理核心错误', details: streamCoreError.message });
      }
    }

  } catch (handlerError) { // Catches errors from the preHandler loop specifically
    logger.error('流式代理的预处理环节失败:', { 
        url: requestInfo.originalUrl, // Use original requestInfo URL for context here
        errorName: handlerError.name,
        errorMessage: handlerError.message, 
        handlerName: handlerError instanceof HandlerError ? handlerError.handlerName : 'UnknownStreamPreHandler',
        stack: handlerError.stack 
    });
    if (!res.headersSent) {
      const statusCode = (handlerError instanceof ProxyError) ? handlerError.statusCode : 500; // ProxyError includes HandlerError
      const message = handlerError instanceof HandlerError ? 
        `处理环节 '${handlerError.handlerName}' 执行失败: ${handlerError.message}` : 
        '流式代理预处理错误';
      res.status(statusCode).json({ error: message, details: handlerError.message });
    }
  }
}

/**
 * 判断是否应该使用流式处理
 * @param {ProxyRequest} requestInfo 代理请求信息
 * @returns {boolean} 是否使用流式处理
 */
function shouldUseStreamProcessing(requestInfo) {
  const config = configLoader.getConfig();
  const streamPatterns = config.streamProcessingUrlPatterns || [];
  if (streamPatterns.length === 0) {
    logger.warn('stream_processing_url_patterns not configured or empty, using internal defaults.');
    const defaultStreamPatterns = [
        /\.(mp4|avi|mkv|mov|wmv|flv|webm)$/i, 
        /\.(mp3|wav|flac|aac|ogg)$/i,         
        /\.(zip|rar|7z|tar|gz|bz2)$/i,        
        /\.(pdf|doc|docx|ppt|pptx)$/i,        
        /\.(iso|img|dmg)$/i,                  
        /\/download\//i,                       
        /\/stream\//i,                         
        /\/files\//i                           
      ];
    return defaultStreamPatterns.some(pattern => pattern.test(requestInfo.urlNoSite));
  }
  return streamPatterns.some(pattern => pattern.test(requestInfo.urlNoSite));
}

/**
 * 预热连接池
 * @param {string} targetSite 目标站点
 */
async function warmupConnectionPool(targetSite) {
  try {
    logger.info('开始预热连接池', { targetSite });
    
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        connectionManager.executeWithRetry(
          async (context) => {
            const urlObj = new URL(context.url);
            const agent = connectionManager.getAgent(urlObj.protocol);
            
            return await axios({
              method: 'HEAD',
              url: context.url,
              httpAgent: agent,
              httpsAgent: agent,
              timeout: 5000
            });
          },
          { url: targetSite }
        ).catch(error => {
          logger.debug('连接池预热请求失败（正常）:', error.message);
        })
      );
    }
    
    await Promise.allSettled(promises);
    logger.info('连接池预热完成', { targetSite });
    
  } catch (error) {
    logger.warn('连接池预热失败:', error.message);
  }
}

module.exports = {
  proxyHandler,
  streamProxyHandler,
  shouldUseStreamProcessing,
  createErrorResponse,
  isMediaRequest,
  isLargeFileRequest,
  warmupConnectionPool,
  generateRequestId
}; 