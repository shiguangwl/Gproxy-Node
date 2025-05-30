const axios = require('axios');
const { ProxyResponse } = require('./entities');
const logger = require('./utils/logger');
const connectionManager = require('./utils/connection-manager');
const configLoader = require('../config/config-loader');
const cloudflareHandler = require('./utils/cloudflare-handler');
const browserFingerprint = require('./utils/browser-fingerprint');

/**
 * 增强的代理处理器核心函数
 * @param {ProxyRequest} requestInfo 代理请求信息
 * @param {Upstream} upstream 上游服务器信息
 * @param {Array} preHandlers 前置处理器数组
 * @param {Array} postHandlers 后置处理器数组
 * @returns {ProxyResponse} 代理响应对象
 */
async function proxyHandler(requestInfo, upstream, preHandlers = [], postHandlers = []) {
  try {
    // 执行前置处理器
    let processedRequest = requestInfo;
    for (const handler of preHandlers) {
      if (typeof handler === 'function') {
        processedRequest = handler(upstream, processedRequest);
      }
    }

    // 构建上游URL
    const upstreamUrl = upstream.site + processedRequest.urlNoSite;

    // 检查拒绝列表
    const denyRequestList = configLoader.denyRequestList;
    for (const denyPattern of denyRequestList) {
      if (new RegExp(denyPattern).test(processedRequest.urlNoSite)) {
        logger.warn('请求被拒绝列表阻止:', processedRequest.urlNoSite);
        throw new Error('ACCESS_DENIED');
      }
    }

    // 检查是否是媒体请求，使用不同的配置
    const isMedia = isMediaRequest(processedRequest.urlNoSite);
    const isLargeFile = isLargeFileRequest(processedRequest.urlNoSite);
    
    logger.debug('发起增强代理请求', {
      method: processedRequest.method,
      url: upstreamUrl,
      isMedia: isMedia,
      isLargeFile: isLargeFile,
      headers: Object.keys(processedRequest.headers)
    });

    let response = null;
    let cloudflareAttempted = false;

    try {
      // 使用连接管理器执行请求
      response = await connectionManager.executeWithRetry(
        async (context) => {
          return await performHttpRequest(context);
        },
        {
          url: upstreamUrl,
          method: processedRequest.method,
          headers: processedRequest.headers,
          data: processedRequest.data,
          isMedia: isMedia,
          isLargeFile: isLargeFile,
          requestInfo: processedRequest
        }
      );

    } catch (error) {
      // 如果是Cloudflare相关错误，尝试使用浏览器绕过
      if (shouldAttemptCloudflareBypass(error, response)) {
        logger.info('检测到可能的Cloudflare阻止，尝试浏览器绕过', {
          url: upstreamUrl,
          error: error.message
        });

        try {
          cloudflareAttempted = true;
          const bypassResult = await cloudflareHandler.bypassCloudflare(upstreamUrl);
          
          if (bypassResult.success) {
            logger.info('Cloudflare绕过成功，使用获取的内容', {
              url: upstreamUrl,
              contentLength: bypassResult.content.length
            });

            // 创建模拟的axios响应对象
            response = {
              data: Buffer.from(bypassResult.content),
              status: 200,
              statusText: 'OK',
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'content-length': bypassResult.content.length.toString(),
                ...bypassResult.headers
              },
              config: { url: upstreamUrl }
            };
          } else {
            throw error; // 绕过失败，抛出原错误
          }
        } catch (bypassError) {
          logger.warn('Cloudflare绕过失败:', bypassError.message);
          throw error; // 抛出原错误
        }
      } else {
        throw error; // 不是Cloudflare相关错误，直接抛出
      }
    }

    // 创建代理响应对象
    const proxyResponse = new ProxyResponse(response);
    proxyResponse.proxyRequest = processedRequest;
    proxyResponse.cloudflareBypassUsed = cloudflareAttempted;

    // 记录响应信息
    logger.info('代理请求完成', {
      url: upstreamUrl,
      status: response.status,
      contentType: response.headers['content-type'],
      contentLength: response.headers['content-length'],
      isMedia: isMedia,
      isLargeFile: isLargeFile,
      cloudflareBypassUsed: cloudflareAttempted
    });

    // 执行后置处理器
    let processedResponse = proxyResponse;
    for (const handler of postHandlers) {
      if (typeof handler === 'function') {
        processedResponse = handler(upstream, processedResponse);
      }
    }

    return processedResponse;

  } catch (error) {
    logger.error('代理请求失败:', {
      url: upstream.site + requestInfo.urlNoSite,
      method: requestInfo.method,
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText
    });

    // 处理特定错误类型
    if (error.message === 'ACCESS_DENIED') {
      const errorResponse = createErrorResponse(403, 'Access Denied');
      errorResponse.proxyRequest = requestInfo;
      return errorResponse;
    }

    if (error.code === 'ECONNREFUSED') {
      const errorResponse = createErrorResponse(502, 'Bad Gateway - Connection Refused');
      errorResponse.proxyRequest = requestInfo;
      return errorResponse;
    }

    if (error.code === 'ENOTFOUND') {
      const errorResponse = createErrorResponse(502, 'Bad Gateway - DNS Resolution Failed');
      errorResponse.proxyRequest = requestInfo;
      return errorResponse;
    }

    if (error.code === 'ETIMEDOUT') {
      const errorResponse = createErrorResponse(504, 'Gateway Timeout');
      errorResponse.proxyRequest = requestInfo;
      return errorResponse;
    }

    // 处理Cloudflare特定错误
    if (isCloudflareError(error)) {
      const errorResponse = createCloudflareErrorResponse(error);
      errorResponse.proxyRequest = requestInfo;
      return errorResponse;
    }

    // 如果是HTTP响应错误，尝试返回原始响应
    if (error.response) {
      const proxyResponse = new ProxyResponse(error.response);
      proxyResponse.proxyRequest = requestInfo;
      return proxyResponse;
    }

    // 默认错误响应
    const errorResponse = createErrorResponse(500, 'Internal Server Error');
    errorResponse.proxyRequest = requestInfo;
    return errorResponse;
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
 * 创建Cloudflare错误响应
 */
function createCloudflareErrorResponse(error) {
  const status = error.response?.status || 503;
  const statusText = getCloudflareErrorMessage(status);
  
  const errorHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <title>Cloudflare 错误 ${status}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0; padding: 40px; 
            background: linear-gradient(135deg, #ff7b7b 0%, #ff416c 100%);
            color: #333; min-height: 100vh;
            display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; border-radius: 10px; 
            padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            max-width: 600px; text-align: center;
        }
        .error-code { 
            font-size: 4em; font-weight: bold; 
            color: #ff416c; margin-bottom: 20px;
        }
        .error-message { 
            font-size: 1.2em; margin-bottom: 30px; 
            color: #555;
        }
        .details { 
            background: #f8f9fa; padding: 20px; 
            border-radius: 5px; margin: 20px 0;
            text-align: left; font-family: monospace;
            font-size: 0.9em;
        }
        .retry-btn {
            background: #ff416c; color: white;
            padding: 12px 24px; border: none;
            border-radius: 5px; cursor: pointer;
            font-size: 1em; margin: 10px;
            transition: background 0.3s;
        }
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
            <strong>代理服务器:</strong> Gproxy-Node v2.1.0<br>
            <strong>建议:</strong> 网站可能正在维护或遇到流量限制
        </div>
        <button class="retry-btn" onclick="location.reload()">重试</button>
        <button class="retry-btn" onclick="history.back()">返回</button>
        <div class="footer">
            这是一个Cloudflare服务错误，通常是临时性的<br>
            代理服务器已尝试自动处理，如果问题持续请稍后重试
        </div>
    </div>
</body>
</html>`;

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
 * 执行HTTP请求（增强版）
 * @param {Object} context 请求上下文
 * @returns {Promise} axios响应对象
 */
async function performHttpRequest(context) {
  const { url, method, headers, data, isMedia, isLargeFile, requestInfo } = context;
  
  // 获取合适的HTTP代理
  const urlObj = new URL(url);
  const agent = connectionManager.getAgent(urlObj.protocol);
  
  // 应用浏览器指纹伪装
  const domain = urlObj.hostname;
  const enhancedHeaders = browserFingerprint.applyFingerprint({ ...headers }, domain);
  
  // 配置axios请求选项
  const axiosConfig = {
    method: method,
    url: url,
    headers: enhancedHeaders,
    httpAgent: agent,
    httpsAgent: agent,
    timeout: isMedia ? 60000 : (isLargeFile ? 120000 : 30000), // 不同类型使用不同超时
    maxRedirects: isMedia ? 3 : 5, // 媒体请求较少重定向
    validateStatus: function (status) {
      // 接受所有状态码，让应用层处理
      return true;
    },
    responseType: 'arraybuffer', // 使用arraybuffer以正确处理二进制内容
    decompress: true, // 让axios自动处理解压缩
    maxContentLength: isLargeFile ? Infinity : 50 * 1024 * 1024, // 50MB限制，大文件无限制
    maxBodyLength: isLargeFile ? Infinity : 50 * 1024 * 1024,
    transformResponse: [function (data) {
      // 不对响应数据进行任何转换，保持原始格式
      return data;
    }]
  };

  // 针对不同类型的请求进行优化
  if (isMedia) {
    // 媒体请求优化
    axiosConfig.maxRedirects = 0; // 禁用自动重定向以避免签名失效
    axiosConfig.httpVersion = '1.1'; // 强制使用HTTP/1.1
    
    // 媒体请求的特殊头部
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'accept': '*/*',
      'cache-control': 'no-cache',
      'connection': 'keep-alive'
    };
  } else if (isLargeFile) {
    // 大文件请求优化
    axiosConfig.timeout = 300000; // 5分钟超时
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'accept-encoding': 'gzip, deflate', // 允许压缩以节省带宽
      'connection': 'keep-alive'
    };
  } else {
    // 普通请求
    axiosConfig.headers = {
      ...axiosConfig.headers,
      'accept-encoding': 'gzip, deflate, br' // 支持所有压缩格式
    };
  }

  // 添加请求体（如果有）
  if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    axiosConfig.data = data;
  }

  // 添加请求标识
  axiosConfig.headers['x-gproxy-request-id'] = generateRequestId();
  axiosConfig.headers['x-gproxy-timestamp'] = Date.now().toString();

  // 添加一些随机延迟以模拟人类行为
  const delay = browserFingerprint.getRandomDelay();
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

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
  const mediaPatterns = [
    /\.(mp4|avi|mkv|mov|wmv|flv|webm)(\?|$)/i, // 视频文件
    /\.(mp3|wav|flac|aac|ogg|m4a)(\?|$)/i,     // 音频文件
    /videoplayback/i,                           // YouTube视频播放
    /googlevideo\.com/i,                        // Google视频服务器
    /ytimg\.com.*\.(jpg|jpeg|png|webp)/i,      // YouTube图片
    /\/stream\//i,                              // 流媒体路径
    /\/video\//i,                               // 视频路径
    /\/audio\//i,                               // 音频路径
    /\/media\//i,                               // 媒体路径
    /manifest\.(m3u8|mpd)/i,                   // 流媒体清单文件
    /\.ts(\?|$)/i,                             // HLS分片文件
    /chunk.*\.m4s/i,                           // DASH分片
    /segment.*\.(ts|m4s)/i                     // 流媒体分片
  ];
  
  return mediaPatterns.some(pattern => pattern.test(urlPath));
}

/**
 * 判断是否是大文件请求
 * @param {string} urlPath URL路径
 * @returns {boolean} 是否是大文件请求
 */
function isLargeFileRequest(urlPath) {
  const largeFilePatterns = [
    /\.(zip|rar|7z|tar|gz|bz2)(\?|$)/i,        // 压缩文件
    /\.(iso|img|dmg)(\?|$)/i,                  // 磁盘镜像
    /\.(pdf|doc|docx|ppt|pptx|xls|xlsx)(\?|$)/i, // 文档文件
    /\/download\//i,                            // 下载路径
    /\/files\//i,                               // 文件路径
    /\.exe(\?|$)/i,                             // 可执行文件
    /\.msi(\?|$)/i,                             // Windows安装包
    /\.pkg(\?|$)/i,                             // macOS包
    /\.deb(\?|$)/i,                             // Debian包
    /\.rpm(\?|$)/i                              // RPM包
  ];
  
  return largeFilePatterns.some(pattern => pattern.test(urlPath));
}

/**
 * 创建错误响应对象
 * @param {number} statusCode HTTP状态码
 * @param {string} message 错误消息
 * @returns {ProxyResponse} 错误响应对象
 */
function createErrorResponse(statusCode, message) {
  const errorResponse = {
    content: Buffer.from(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <title>代理错误 ${statusCode}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0; padding: 40px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333; min-height: 100vh;
            display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; border-radius: 10px; 
            padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            max-width: 600px; text-align: center;
        }
        .error-code { 
            font-size: 4em; font-weight: bold; 
            color: #e74c3c; margin-bottom: 20px;
        }
        .error-message { 
            font-size: 1.2em; margin-bottom: 30px; 
            color: #555;
        }
        .details { 
            background: #f8f9fa; padding: 20px; 
            border-radius: 5px; margin: 20px 0;
            text-align: left; font-family: monospace;
            font-size: 0.9em;
        }
        .retry-btn {
            background: #3498db; color: white;
            padding: 12px 24px; border: none;
            border-radius: 5px; cursor: pointer;
            font-size: 1em; margin: 10px;
            transition: background 0.3s;
        }
        .retry-btn:hover { background: #2980b9; }
        .btn-danger { background: #e74c3c; }
        .btn-danger:hover { background: #c0392b; }
        .footer { margin-top: 30px; color: #7f8c8d; font-size: 0.9em; }
        .metrics { font-size: 0.8em; color: #95a5a6; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-code">${statusCode}</div>
        <div class="error-message">${message}</div>
        <div class="details">
            <strong>时间:</strong> ${new Date().toLocaleString('zh-CN')}<br>
            <strong>代理服务器:</strong> Gproxy-Node v2.1.0 Enhanced<br>
            <strong>请求ID:</strong> ${generateRequestId()}<br>
            <strong>错误类型:</strong> ${getErrorType(statusCode)}<br>
            <strong>Cloudflare支持:</strong> ✅ 已启用
        </div>
        <button class="retry-btn" onclick="location.reload()">重试</button>
        <button class="retry-btn" onclick="history.back()">返回</button>
        <div class="footer">
            如果问题持续存在，请联系管理员或稍后重试<br>
            增强版代理支持自动Cloudflare绕过
        </div>
        <div class="metrics">
            连接管理器统计: ${JSON.stringify(connectionManager.getMetrics(), null, 2)}
        </div>
    </div>
</body>
</html>`),
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

  return errorResponse;
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
  try {
    // 执行前置处理器
    let processedRequest = requestInfo;
    for (const handler of preHandlers) {
      if (typeof handler === 'function') {
        processedRequest = handler(upstream, processedRequest);
      }
    }

    // 构建上游URL
    const upstreamUrl = upstream.site + processedRequest.urlNoSite;

    // 检查拒绝列表
    const denyRequestList = configLoader.denyRequestList;
    for (const denyPattern of denyRequestList) {
      if (new RegExp(denyPattern).test(processedRequest.urlNoSite)) {
        logger.warn('请求被拒绝列表阻止:', processedRequest.urlNoSite);
        res.status(403).send('Access Denied');
        return;
      }
    }

    logger.debug('发起流式代理请求', {
      method: processedRequest.method,
      url: upstreamUrl
    });

    // 应用浏览器指纹伪装
    const domain = new URL(upstreamUrl).hostname;
    processedRequest.headers = browserFingerprint.applyFingerprint(processedRequest.headers, domain);

    // 使用连接管理器执行流式请求
    const response = await connectionManager.executeWithRetry(
      async (context) => {
        const urlObj = new URL(context.url);
        const agent = connectionManager.getAgent(urlObj.protocol);
        
        return await axios({
          method: context.method,
          url: context.url,
          headers: context.headers,
          data: context.data,
          httpAgent: agent,
          httpsAgent: agent,
          timeout: 300000, // 5分钟超时
          responseType: 'stream',
          validateStatus: function (status) {
            return true;
          }
        });
      },
      {
        url: upstreamUrl,
        method: processedRequest.method,
        headers: processedRequest.headers,
        data: processedRequest.data
      }
    );

    // 设置响应头
    res.status(response.status);
    
    // 复制必要的响应头
    const allowedHeaders = [
      'content-type',
      'content-length',
      'content-disposition',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
      'cache-control'
    ];

    allowedHeaders.forEach(header => {
      if (response.headers[header]) {
        res.set(header, response.headers[header]);
      }
    });

    // 添加CORS头部
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Credentials', 'true');

    // 添加流式传输优化头部
    res.set('X-Accel-Buffering', 'no'); // Nginx优化
    res.set('Cache-Control', 'no-cache'); // 禁用缓存以实时传输

    // 管道传输响应流
    response.data.pipe(res);

    // 监听流事件
    response.data.on('error', (error) => {
      logger.error('流式传输错误:', error);
      if (!res.headersSent) {
        res.status(500).end('Stream Error');
      }
    });

    response.data.on('end', () => {
      logger.info('流式代理请求完成', {
        url: upstreamUrl,
        status: response.status
      });
    });

  } catch (error) {
    logger.error('流式代理请求失败:', {
      url: upstream.site + requestInfo.urlNoSite,
      error: error.message
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Stream proxy failed',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * 判断是否应该使用流式处理
 * @param {ProxyRequest} requestInfo 代理请求信息
 * @returns {boolean} 是否使用流式处理
 */
function shouldUseStreamProcessing(requestInfo) {
  // 对于某些大文件类型或特定路径使用流式处理
  const streamPatterns = [
    /\.(mp4|avi|mkv|mov|wmv|flv|webm)$/i, // 视频文件
    /\.(mp3|wav|flac|aac|ogg)$/i,         // 音频文件
    /\.(zip|rar|7z|tar|gz|bz2)$/i,        // 压缩文件
    /\.(pdf|doc|docx|ppt|pptx)$/i,        // 文档文件
    /\.(iso|img|dmg)$/i,                  // 磁盘镜像
    /\/download\//i,                       // 下载路径
    /\/stream\//i,                         // 流媒体路径
    /\/files\//i                           // 文件路径
  ];

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