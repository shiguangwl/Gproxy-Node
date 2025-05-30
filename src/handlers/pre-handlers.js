const CookieManager = require('../utils/cookie-parser');
const logger = require('../utils/logger');
const configLoader = require('../../config/config-loader');
const { HandlerError } = require('../utils/errors');

const cookieManager = new CookieManager();

/**
 * 基础前置处理器 - 处理特定于代理转发的请求头转换。
 * 主要负责修改 Host, Referer, Origin 以匹配上游，并使用 CookieManager 处理请求 Cookie。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function preHandler(upstream, proxyRequest) {
  try {
    // Base fingerprint (UA, Sec-CH-UA, Accept*, etc.) is assumed to be applied by ConnectionManager.
    // Headers are also assumed to be lowercased by ConnectionManager or fingerprint utility.

    proxyRequest.headers['host'] = upstream.host;

    if (proxyRequest.headers['referer']) {
      try {
        const originalRefererUrl = new URL(proxyRequest.headers['referer']);
        const proxySiteUrl = new URL(proxyRequest.site);
        if (originalRefererUrl.host === proxySiteUrl.host) {
          proxyRequest.headers['referer'] = proxyRequest.headers['referer']
            .replace(proxyRequest.site, upstream.site);
        }
      } catch (e) {
        logger.warn('无法解析或修改Referer URL:', { referer: proxyRequest.headers['referer'], error: e.message });
      }
    }

    if (proxyRequest.headers['origin']) {
      try {
        const originalOriginUrl = new URL(proxyRequest.headers['origin']);
        const proxySiteUrl = new URL(proxyRequest.site);
        if (originalOriginUrl.host === proxySiteUrl.host) {
          proxyRequest.headers['origin'] = upstream.site; // Origin is scheme://host[:port]
        }
      } catch (e) {
         logger.warn('无法解析或修改Origin URL:', { origin: proxyRequest.headers['origin'], error: e.message });
      }
    }

    // Get cookies for upstream from the jar
    // The proxyRequest.headers['cookie'] initially comes from the client request to the proxy.
    // We need to decide policy: 
    // 1. Forward client's cookies (after domain rewrite) AND add any relevant from jar?
    // 2. Or, only use cookies from jar that match upstream (ignoring what client sent for proxy domain)?
    // Option 2 is cleaner and how browsers work with a cookie jar.
    // However, if client explicitly sets cookies for the PROXY domain that are meant for upstream,
    // simple domain rewriting might be needed if not using a jar for client->proxy cookies.

    // Current approach: Get cookies specifically for the upstream from our managed jar.
    // This implies the jar is populated by responses from the upstream.
    // Any cookies client sent to proxy *for the proxy's domain* are not automatically forwarded unless also in jar for upstream.
    proxyRequest.headers['cookie'] = cookieManager.getCookiesForUpstream(upstream.site + proxyRequest.urlNoSite);
    
    delete proxyRequest.headers['content-length'];
    delete proxyRequest.headers['connection'];

    logger.debug('基础前置处理器(preHandler)执行完成', {
      upstream: upstream.site,
      path: proxyRequest.urlNoSite,
      hasCookie: !!proxyRequest.headers['cookie']
    });
    return proxyRequest;
  } catch (error) {
    logger.error('preHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`preHandler 失败: ${error.message}`, 'preHandler', error);
  }
}

/**
 * Cloudflare专用前置处理器。
 * 如果目标主机在配置的敏感列表中，则应用特定的头部（如sec-fetch-site, referer）并添加配置的默认Cookie。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function cloudflarePreHandler(upstream, proxyRequest) {
  try {
    const config = configLoader.getConfig();
    // Assumes config.cloudflareSensitiveHosts and config.cloudflareDefaultCookies exist
    const cfSensitiveHosts = config.cloudflareSensitiveHosts || []; 
    const defaultCookies = config.cloudflareDefaultCookies || [];

    if (cfSensitiveHosts.some(host => upstream.host.includes(host))) {
      logger.debug('应用Cloudflare敏感站点特定头部处理', { host: upstream.host });
      proxyRequest.headers['sec-fetch-site'] = 'same-origin'; // Override fingerprint's default
      proxyRequest.headers['referer'] = upstream.site + '/';    
      
      if (defaultCookies.length > 0) {
          const cookieString = defaultCookies.join('; ');
          let existingCookies = proxyRequest.headers['cookie'] || '';
          if (existingCookies) {
            proxyRequest.headers['cookie'] = existingCookies + '; ' + cookieString;
          } else {
            proxyRequest.headers['cookie'] = cookieString;
          }
      }
    }
    return proxyRequest;
  } catch (error) {
    logger.error('Cloudflare前置处理器执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`cloudflarePreHandler 失败: ${error.message}`, 'cloudflarePreHandler', error);
  }
}

/**
 * 媒体/视频专用前置处理器。
 * 如果识别为媒体请求，则修改Accept和Sec-Fetch-*头部以适应媒体流。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。  
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function mediaPreHandler(upstream, proxyRequest) {
  try {
    const config = configLoader.getConfig();
    // Assumes config.mediaUrlPatterns is an array of RegExp from configLoader
    if (!isMediaUrl(proxyRequest.urlNoSite, config.mediaUrlPatterns)) {
        return proxyRequest;
    }

    logger.debug('检测到媒体请求，应用媒体优化头部', { url: proxyRequest.urlNoSite });
      
    proxyRequest.headers['accept'] = '*/*'; 
    // Cache-Control and Pragma for media can be aggressive, ensure they are intended.
    // proxyRequest.headers['cache-control'] = 'no-cache';
    // proxyRequest.headers['pragma'] = 'no-cache';
      
    proxyRequest.headers['sec-fetch-dest'] = 'video'; // More specific like 'audio' or 'track' if possible
    proxyRequest.headers['sec-fetch-mode'] = 'no-cors';
    proxyRequest.headers['sec-fetch-site'] = 'cross-site';
      
    // YouTube specific logic moved to youtubeHeaderHandler
    if (!upstream.host.includes('youtube.com') && !upstream.host.includes('googlevideo.com')) {
      if (!proxyRequest.headers['referer']) {
         proxyRequest.headers['referer'] = upstream.site + '/';
      }
      // Consider if accept-encoding: identity is truly needed. Axios handles decompression.
      // proxyRequest.headers['accept-encoding'] = 'identity'; 
    }
    return proxyRequest;
  } catch (error) {
    logger.error('媒体前置处理器执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`mediaPreHandler 失败: ${error.message}`, 'mediaPreHandler', error);
  }
}

/**
 * 判断URL是否为媒体URL。
 * @param {string} url URL路径。
 * @param {RegExp[]} [patternsToUse=[]] 从配置加载的正则表达式模式数组。
 * @returns {boolean} 如果URL匹配任何媒体模式则返回true，否则返回false。
 */
function isMediaUrl(url, patternsToUse = []) {
  if (!patternsToUse || patternsToUse.length === 0) {
    logger.warn('mediaUrlPatterns not configured or empty for isMediaUrl, detection might be ineffective.');
    return false; 
  }
  return patternsToUse.some(pattern => pattern.test(url));
}

/**
 * 反爬虫检测前置处理器。
 * 移除已知的代理暴露头部，并可能轻微修改Accept头部顺序以增加随机性。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function antiDetectionPreHandler(upstream, proxyRequest) {
  try {
    const headersToLower = {};
    Object.keys(proxyRequest.headers).forEach(k => headersToLower[k.toLowerCase()] = proxyRequest.headers[k]);
    proxyRequest.headers = headersToLower;

    const proxyHeaders = [
      'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
      'x-real-ip', 'forwarded', 'via',
      'proxy-connection', 'proxy-authorization'
      // 'x-gproxy-request-id', 'x-gproxy-timestamp' // These are added later by proxy-handler
    ];
    proxyHeaders.forEach(header => delete proxyRequest.headers[header]);

    // Subtle modification to Accept header - effectiveness varies.
    if (Math.random() < 0.1 && proxyRequest.headers['accept']) {
      const acceptParts = proxyRequest.headers['accept'].split(',');
      if (acceptParts.length > 2) {
        const temp = acceptParts[1];
        acceptParts[1] = acceptParts[2];
        acceptParts[2] = temp;
        proxyRequest.headers['accept'] = acceptParts.join(',');
      }
    }
    // Sec-CH-Accept-CH is better for client hints, but let fingerprint handle CH headers.
    // proxyRequest.headers['accept-ch'] = 'Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform';

    logger.debug('反检测处理(antiDetectionPreHandler)完成');
    return proxyRequest;
  } catch (error) {
    logger.error('反检测前置处理器执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`antiDetectionPreHandler 失败: ${error.message}`, 'antiDetectionPreHandler', error);
  }
}

/**
 * 禁用缓存的前置处理器。
 * 设置 Cache-Control, Pragma, Expires 头部以指示不缓存响应。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function preDisableCache(upstream, proxyRequest) {
  try {
    proxyRequest.headers['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    proxyRequest.headers['pragma'] = 'no-cache';
    proxyRequest.headers['expires'] = '0';
    logger.debug('缓存禁用头部已设置');
    return proxyRequest;
  } catch (error) {
    logger.error('preDisableCache 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`preDisableCache 失败: ${error.message}`, 'preDisableCache', error);
  }
}

/**
 * 自定义主页路径处理器工厂函数。
 * 创建一个前置处理器，如果请求的是根路径('/')，则将其重写到配置中指定的 homePath。
 * @param {string} homePath 用户配置的主页路径。
 * @returns {function(import('../entities').Upstream, import('../entities').ProxyRequest): import('../entities').ProxyRequest} 前置处理器函数。
 */
function createCustomHomePathHandler(homePath) {
  return function customHomePathHandler(upstream, proxyRequest) {
    try {
      if (proxyRequest.path === '/' && homePath && homePath !== '/') {
        proxyRequest.path = homePath;
        proxyRequest.urlNoSite = homePath + (proxyRequest.query || '');
        logger.debug('主页路径已重定向', { newPath: homePath });
      }
      return proxyRequest;
    } catch (error) {
      logger.error('customHomePathHandler 执行失败:', { error: error.message, stack: error.stack });
      throw new HandlerError(`customHomePathHandler 失败: ${error.message}`, 'customHomePathHandler', error);
    }
  };
}

/**
 * 安全头部处理器。
 * (当前版本作用较小，主要依赖 antiDetectionPreHandler 移除代理相关头部)。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function securityHeaderHandler(upstream, proxyRequest) {
  // This handler's role is reduced as antiDetectionPreHandler also removes proxy headers.
  // It primarily ensures DNT if not set by fingerprint.
  // Fingerprint should set DNT if appropriate for the UA.
  // if (!proxyRequest.headers['dnt']) {
  //   proxyRequest.headers['dnt'] = '1'; 
  // }
  // Most dangerous headers are removed by antiDetectionPreHandler.
  try {
    logger.debug('安全头部处理器(securityHeaderHandler)执行');
    return proxyRequest;
  } catch (error) {
    logger.error('securityHeaderHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`securityHeaderHandler 失败: ${error.message}`, 'securityHeaderHandler', error);
  }
}

/**
 * 请求体处理器。
 * 如果请求体是JSON，则尝试将请求体中匹配代理服务器地址的字符串替换为上游服务器地址。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function requestBodyHandler(upstream, proxyRequest) {
  try {
    if (!proxyRequest.data) return proxyRequest;
    const contentType = proxyRequest.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        let bodyStr = Buffer.isBuffer(proxyRequest.data) ? proxyRequest.data.toString() : 
                      (typeof proxyRequest.data === 'string' ? proxyRequest.data : JSON.stringify(proxyRequest.data));
        // Ensure proxyRequest.site is a valid base for RegExp
        const sitePattern = (proxyRequest.site || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (sitePattern) { // Only replace if sitePattern is not empty
            const replacedBody = bodyStr.replace(new RegExp(sitePattern, 'g'), upstream.site);
            if (replacedBody !== bodyStr) {
              proxyRequest.data = Buffer.from(replacedBody); // Store as buffer
              logger.debug('JSON请求体域名已替换');
            }
        }
    }
    return proxyRequest;
  } catch (error) {
    // JSON.stringify or RegExp might throw, or Buffer.from
    logger.error('requestBodyHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`requestBodyHandler 失败: ${error.message}`, 'requestBodyHandler', error);
  }
}

/**
 * YouTube专用头部处理器。
 * 为YouTube和GoogleVideo的请求设置特定的Cookie, x-youtube-client-* 头部，以及必要的Referer/Origin。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyRequest} proxyRequest 代理请求信息对象。
 * @returns {import('../entities').ProxyRequest} 修改后的代理请求对象。
 */
function youtubeHeaderHandler(upstream, proxyRequest) {
  try {
    const config = configLoader.getConfig();
    const defaultCookies = config.youtubeDefaultCookies || []; 

    if (upstream.host.includes('youtube.com') || upstream.host.includes('googlevideo.com')) {
      if (defaultCookies.length > 0) {
          const cookieString = defaultCookies.join('; ');
          let existingCookies = proxyRequest.headers['cookie'] || '';
          if (existingCookies) {
            proxyRequest.headers['cookie'] = existingCookies + '; ' + cookieString;
          } else {
            proxyRequest.headers['cookie'] = cookieString;
          }
      }

      if (proxyRequest.urlNoSite.includes('videoplayback')) {
        proxyRequest.headers['sec-fetch-dest'] = 'video';
        proxyRequest.headers['sec-fetch-mode'] = 'no-cors'; 
        proxyRequest.headers['referer'] = 'https://www.youtube.com/'; 
        proxyRequest.headers['origin'] = 'https://www.youtube.com/';
      }
      
      proxyRequest.headers['x-youtube-client-name'] = '1';
      proxyRequest.headers['x-youtube-client-version'] = config.youtubeClientVersion || '2.20240110.01.00'; 

      logger.debug('应用YouTube专用头部处理');
    }
    return proxyRequest;
  } catch (error) {
    logger.error('youtubeHeaderHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`youtubeHeaderHandler 失败: ${error.message}`, 'youtubeHeaderHandler', error);
  }
}

module.exports = {
  preHandler,
  cloudflarePreHandler,
  mediaPreHandler,
  preDisableCache,
  createCustomHomePathHandler,
  securityHeaderHandler,
  requestBodyHandler,
  youtubeHeaderHandler,
  antiDetectionPreHandler,
  isMediaUrl
}; 