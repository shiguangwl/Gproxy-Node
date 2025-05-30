const express = require('express');
const configLoader = require('../config/config-loader');
const logger = require('../src/utils/logger');
const { 
  Upstream, 
  requestBaseConvert, 
  requestProxyConvert, 
  extractTargetSiteFromProxyUrl 
} = require('../src/entities');
const { 
  proxyHandler, 
  streamProxyHandler, 
  shouldUseStreamProcessing 
} = require('../src/proxy-handler');

// 导入处理器
const {
  preHandler,
  mediaPreHandler,
  createCustomHomePathHandler,
  securityHeaderHandler,
  requestBodyHandler,
  youtubeHeaderHandler,
  cloudflarePreHandler,
  antiDetectionPreHandler
} = require('../src/handlers/pre-handlers');

const {
  postHandler,
  postReplaceContentHandler,
  postInjectHandler,
  postDecompressHandler,
  postOptimizeHeadersHandler,
  postErrorPageHandler
} = require('../src/handlers/post-handlers');

// 导入自定义错误类
const {
  ProxyError,
  InvalidTargetUrlError,
  AccessDeniedError,
  TargetNotFoundError,
  TargetConnectionRefusedError,
  RequestTimeoutError
} = require('../src/utils/errors'); // 确保路径正确

const router = express.Router();

/**
 * 检测域名是否可能受Cloudflare保护
 * @param {string} hostname 主机名
 * @param {string[]} cloudflareHostsList 配置文件中读取的Cloudflare域名列表
 * @returns {boolean} 是否可能受保护
 */
function isLikelyCloudflareProtected(hostname, cloudflareHostsList) {
  if (!hostname || !Array.isArray(cloudflareHostsList)) {
    return false;
  }
  return cloudflareHostsList.some(host => hostname.includes(host));
}

/**
 * 处理代理请求的统一函数
 * @param {import('express').Request} req Express请求对象
 * @param {import('express').Response} res Express响应对象
 * @param {string} mode 代理模式：'base' 或 'global'
 */
async function handleProxyRequest(req, res, mode) {
  const currentConfig = configLoader.getConfig();
  try {
    let proxyRequest;
    let upstream;

    if (mode === 'global') {
      try {
        const targetSite = extractTargetSiteFromProxyUrl(req.url, currentConfig.globalProxyPath);
        upstream = new Upstream(targetSite);
        proxyRequest = requestProxyConvert(req, currentConfig.globalProxyPath);
        logger.debug('全局代理请求', { targetSite: targetSite, path: proxyRequest.urlNoSite, method: req.method });
      } catch (error) {
        logger.error('解析全局代理URL失败:', { url: req.url, error: error.message });
        return res.status(400).json({ 
          error: '无效的代理URL',
          message: '请检查URL格式是否正确',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      if (!currentConfig.baseUpstream) {
        logger.error('基础上游服务器未配置');
        return res.status(500).json({ error: '代理服务器配置错误' });
      }
      upstream = currentConfig.baseUpstream;
      proxyRequest = requestBaseConvert(req);
    }

    if (shouldUseStreamProcessing(proxyRequest)) {
      logger.debug('使用流式代理处理', { path: proxyRequest.urlNoSite, method: req.method });
      return await streamProxyHandler(
        proxyRequest, upstream, res,
        [
          securityHeaderHandler,
          preHandler,
          mediaPreHandler,
          youtubeHeaderHandler,
          requestBodyHandler
        ]
      );
    }

    logger.debug('使用常规代理处理', { upstream: upstream.site, path: proxyRequest.urlNoSite, method: req.method });
    
    const needsCloudflareHandling = isLikelyCloudflareProtected(upstream.host, currentConfig.cloudflareProtectedHosts);
    
    const preHandlers = [
      securityHeaderHandler,
      antiDetectionPreHandler,
      needsCloudflareHandling ? cloudflarePreHandler : null,
      mode === 'base' ? createCustomHomePathHandler(currentConfig.homePath) : null,
      preHandler,
      mediaPreHandler,
      youtubeHeaderHandler,
      requestBodyHandler
    ].filter(Boolean);

    const postHandlers = [
      postDecompressHandler,
      postHandler,
      postReplaceContentHandler,
      mode === 'base' ? postInjectHandler : null, // 确保 postInjectHandler 存在或正确导入
      postOptimizeHeadersHandler,
      postErrorPageHandler
    ].filter(Boolean);

    const proxyResponse = await proxyHandler(proxyRequest, upstream, preHandlers, postHandlers);

    res.status(proxyResponse.statusCode);
    if (proxyResponse.headers) {
      Object.entries(proxyResponse.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          value.forEach(v => res.append(key, v));
        } else {
          res.set(key, value);
        }
      });
    }

    if (Buffer.isBuffer(proxyResponse.content)) {
      res.send(proxyResponse.content);
    } else if (typeof proxyResponse.content === 'string') {
      res.send(proxyResponse.content);
    } else {
      res.json(proxyResponse.content);
    }

    logger.info('代理请求处理完成', {
      method: req.method,
      url: req.url,
      status: proxyResponse.statusCode,
      upstream: upstream.site,
      contentType: proxyResponse.headers['content-type'],
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection?.remoteAddress, // req.connection might be undefined
      processingTime: Date.now() - (req._startTime || Date.now()) // Ensure req._startTime exists
    });

  } catch (error) {
    logger.error('处理代理请求时发生错误:', { method: req.method, url: req.url, error: error.message, stack: error.stack });
    if (!res.headersSent) {
      let statusCode = 500;
      let errorMessage = '代理服务器内部错误';

      // TODO: 理想情况下，应该在错误发生源头抛出特定的自定义错误实例，
      // 然后在这里使用 instanceof 进行判断，而不是依赖 error.message 字符串匹配。
      // 例如: if (error instanceof InvalidTargetUrlError) { ... }
      // 当前保留字符串匹配作为过渡，待相关模块（如 proxyHandler）改造后更新。

      if (error instanceof ProxyError) {
        statusCode = error.statusCode;
        errorMessage = error.message;
      } else {
        // Fallback to message checking if not a known ProxyError instance
        // This section can be removed once all relevant errors are instances of ProxyError subtypes
        if (error.message?.includes('无效的目标URL')) {
          statusCode = 400;
          errorMessage = '无效的目标URL';
        } else if (error.message?.includes('ACCESS_DENIED')) {
          statusCode = 403;
          errorMessage = '访问被拒绝';
        } else if (error.message?.includes('ENOTFOUND') || error.code === 'ENOTFOUND') { // Also check error.code
          statusCode = 502;
          errorMessage = '无法解析目标服务器';
        } else if (error.message?.includes('ECONNREFUSED') || error.code === 'ECONNREFUSED') { // Also check error.code
          statusCode = 502;
          errorMessage = '目标服务器拒绝连接';
        } else if (error.message?.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') { // Also check error.code
          statusCode = 504;
          errorMessage = '请求超时';
        } else if (error.message?.includes('证书') || error.message?.toLowerCase().includes('certificate')) {
          statusCode = 502; // Bad Gateway, as it's an issue with the upstream server's SSL
          errorMessage = '目标服务器证书错误';
        }
        // Add more specific error checks if needed
      }
      
      res.status(statusCode).json({
        error: errorMessage,
        message: process.env.NODE_ENV === 'development' ? error.message : '请稍后重试',
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-gproxy-request-id'] || 'unknown'
      });
    }
  }
}

// 主代理路由
router.all('/', async (req, res) => {
  await handleProxyRequest(req, res, 'base');
});

router.all('/*', async (req, res) => {
  const currentConfig = configLoader.getConfig(); // Ensure config is loaded for path check
  if (req.path.startsWith(`/${currentConfig.globalProxyPath}/`)) {
    await handleProxyRequest(req, res, 'global');
  } else {
    // For any other path not matching global proxy path, consider it as base proxy if needed,
    // or return 404 if it is not intended to be handled by base proxy.
    // Current logic defaults to base, which might be too broad.
    // For now, keeping original logic.
    await handleProxyRequest(req, res, 'base');
  }
});

module.exports = router; 