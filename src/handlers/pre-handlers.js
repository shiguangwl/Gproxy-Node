const CookieManager = require('../utils/cookie-parser');
const logger = require('../utils/logger');

const cookieManager = new CookieManager();

/**
 * 基础前置处理器 - 处理请求头
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function preHandler(upstream, proxyRequest) {
  try {
    // 转换所有请求头键为小写
    const lowercaseHeaders = {};
    Object.keys(proxyRequest.headers).forEach(key => {
      lowercaseHeaders[key.toLowerCase()] = proxyRequest.headers[key];
    });

    // 修改Host头部
    if (lowercaseHeaders['host']) {
      lowercaseHeaders['host'] = upstream.host;
    }

    // 修改Referer头部
    if (lowercaseHeaders['referer']) {
      lowercaseHeaders['referer'] = lowercaseHeaders['referer']
        .replace(proxyRequest.site, upstream.site);
    }

    // 修改Origin头部
    if (lowercaseHeaders['origin']) {
      lowercaseHeaders['origin'] = lowercaseHeaders['origin']
        .replace(proxyRequest.site, upstream.site);
    }

    // 处理Cookie头部
    if (lowercaseHeaders['cookie']) {
      lowercaseHeaders['cookie'] = cookieManager.convertRequestCookies(
        lowercaseHeaders['cookie'],
        proxyRequest.site,
        upstream.site
      );
    }

    // 移除可能干扰的头部
    const headersToRemove = [
      'content-length', // 会被axios自动设置
      'connection', // 连接管理由axios处理
      'upgrade-insecure-requests', // 可能引起问题
      'sec-fetch-site', // 浏览器安全头部
      'sec-fetch-mode',
      'sec-fetch-user',
      'sec-fetch-dest'
    ];

    headersToRemove.forEach(header => {
      delete lowercaseHeaders[header];
    });

    // 设置User-Agent（如果没有的话）
    if (!lowercaseHeaders['user-agent']) {
      lowercaseHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    }

    // 设置Accept头部（如果没有的话）
    if (!lowercaseHeaders['accept']) {
      lowercaseHeaders['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    }

    // 设置Accept-Language头部（如果没有的话）
    if (!lowercaseHeaders['accept-language']) {
      lowercaseHeaders['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    }

    proxyRequest.headers = lowercaseHeaders;
    
    // 记录调试信息
    logger.debug('前置处理器执行完成', {
      upstream: upstream.site,
      path: proxyRequest.urlNoSite,
      method: proxyRequest.method
    });

    return proxyRequest;
  } catch (error) {
    logger.error('前置处理器执行失败:', error);
    throw error;
  }
}

/**
 * 媒体/视频专用前置处理器
 * @param {Upstream} upstream 上游服务器信息  
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function mediaPreHandler(upstream, proxyRequest) {
  try {
    // 检查是否是视频/音频请求
    const isMediaRequest = isMediaUrl(proxyRequest.urlNoSite);
    
    if (isMediaRequest) {
      logger.debug('检测到媒体请求，应用媒体优化', {
        url: proxyRequest.urlNoSite
      });
      
      // 保持Range头部用于视频分片请求
      // 这个头部对视频流很重要，不应该被移除
      
      // 设置更真实的User-Agent，模拟真实浏览器
      proxyRequest.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      
      // 移除所有可能暴露代理的头部
      const mediaHeadersToRemove = [
        'sec-ch-ua',
        'sec-ch-ua-mobile', 
        'sec-ch-ua-platform',
        'sec-fetch-site',
        'sec-fetch-mode',
        'sec-fetch-dest',
        'sec-fetch-user',
        'upgrade-insecure-requests',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-real-ip',
        'forwarded',
        'via'
      ];
      
      mediaHeadersToRemove.forEach(header => {
        delete proxyRequest.headers[header];
      });
      
      // 设置关键的媒体头部
      proxyRequest.headers['accept'] = '*/*';
      proxyRequest.headers['accept-encoding'] = 'identity';
      proxyRequest.headers['accept-language'] = 'en-US,en;q=0.9';
      proxyRequest.headers['cache-control'] = 'no-cache';
      proxyRequest.headers['pragma'] = 'no-cache';
      
      // 对于YouTube视频，设置特殊的Referer和Origin
      if (upstream.host.includes('googlevideo.com') || upstream.host.includes('youtube.com')) {
        proxyRequest.headers['referer'] = 'https://www.youtube.com/';
        proxyRequest.headers['origin'] = 'https://www.youtube.com';
        
        // 添加YouTube专用头部
        proxyRequest.headers['x-youtube-client-name'] = '1';
        proxyRequest.headers['x-youtube-client-version'] = '2.20231212.01.00';
      } else {
        // 通用媒体请求
        proxyRequest.headers['referer'] = upstream.site + '/';
        delete proxyRequest.headers['origin']; // 某些媒体服务器不喜欢Origin头部
      }
      
      // 删除可能干扰的Cookie，只保留必要的
      if (proxyRequest.headers['cookie']) {
        const cookies = proxyRequest.headers['cookie'].split(';')
          .map(c => c.trim())
          .filter(c => !c.toLowerCase().includes('session') && !c.toLowerCase().includes('auth'));
        proxyRequest.headers['cookie'] = cookies.join('; ');
      }
      
      // 对于视频播放请求，确保连接保持活跃
      proxyRequest.headers['connection'] = 'keep-alive';
      
      logger.debug('媒体请求头部优化完成', {
        host: upstream.host,
        hasRange: !!proxyRequest.headers['range']
      });
    }
    
    return proxyRequest;
  } catch (error) {
    logger.error('媒体前置处理器执行失败:', error);
    return proxyRequest; // 出错时返回原请求
  }
}

/**
 * 判断是否是媒体URL
 * @param {string} url URL路径
 * @returns {boolean} 是否是媒体URL
 */
function isMediaUrl(url) {
  const mediaPatterns = [
    /\.mp4(\?|$)/i,
    /\.m4v(\?|$)/i,
    /\.webm(\?|$)/i,
    /\.avi(\?|$)/i,
    /\.mkv(\?|$)/i,
    /\.mp3(\?|$)/i,
    /\.m4a(\?|$)/i,
    /\.wav(\?|$)/i,
    /\.flac(\?|$)/i,
    /videoplayback/i,
    /googlevideo\.com/i,
    /ytimg\.com.*\.jpg/i,
    /\/stream\//i,
    /\/video\//i,
    /\/audio\//i
  ];
  
  return mediaPatterns.some(pattern => pattern.test(url));
}

/**
 * 禁用缓存的前置处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function preDisableCache(upstream, proxyRequest) {
  proxyRequest.headers['cache-control'] = 'no-store, no-cache, must-revalidate';
  proxyRequest.headers['pragma'] = 'no-cache';
  proxyRequest.headers['expires'] = '0';
  return proxyRequest;
}

/**
 * 自定义主页路径处理器工厂函数
 * @param {string} homePath 自定义主页路径
 * @returns {Function} 前置处理器函数
 */
function createCustomHomePathHandler(homePath) {
  return function customHomePathHandler(upstream, proxyRequest) {
    if (proxyRequest.path === '/' && homePath && homePath !== '/') {
      proxyRequest.path = homePath;
      proxyRequest.urlNoSite = homePath + (proxyRequest.query || '');
      
      logger.debug('主页路径重定向', {
        originalPath: '/',
        newPath: homePath
      });
    }
    return proxyRequest;
  };
}

/**
 * 安全头部处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function securityHeaderHandler(upstream, proxyRequest) {
  // 移除可能暴露代理信息的头部
  const securityHeaders = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'forwarded'
  ];

  securityHeaders.forEach(header => {
    delete proxyRequest.headers[header.toLowerCase()];
  });

  return proxyRequest;
}

/**
 * 请求体处理器 - 处理JSON请求体中的域名替换
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function requestBodyHandler(upstream, proxyRequest) {
  if (!proxyRequest.data) {
    return proxyRequest;
  }

  const contentType = proxyRequest.headers['content-type'] || '';
  
  // 处理JSON请求体
  if (contentType.includes('application/json')) {
    try {
      let bodyStr;
      if (Buffer.isBuffer(proxyRequest.data)) {
        bodyStr = proxyRequest.data.toString();
      } else if (typeof proxyRequest.data === 'string') {
        bodyStr = proxyRequest.data;
      } else {
        bodyStr = JSON.stringify(proxyRequest.data);
      }

      // 替换请求体中的域名
      const replacedBody = bodyStr.replace(
        new RegExp(proxyRequest.site, 'g'),
        upstream.site
      );

      proxyRequest.data = replacedBody;
      
      logger.debug('JSON请求体域名替换完成');
    } catch (error) {
      logger.warn('JSON请求体处理失败:', error.message);
    }
  }

  return proxyRequest;
}

/**
 * YouTube专用头部处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function youtubeHeaderHandler(upstream, proxyRequest) {
  if (upstream.host.includes('youtube.com') || upstream.host.includes('googlevideo.com')) {
    // YouTube特定的头部设置
    proxyRequest.headers['accept-language'] = 'en-US,en;q=0.9';
    
    // 设置YouTube相关的cookies
    const youtubeCookies = [
      'CONSENT=YES+cb',
      'VISITOR_INFO1_LIVE=Plq0ZBNk7Sw',
      'YSC=vQZNLVh0H9M'
    ];
    
    if (proxyRequest.headers['cookie']) {
      proxyRequest.headers['cookie'] += '; ' + youtubeCookies.join('; ');
    } else {
      proxyRequest.headers['cookie'] = youtubeCookies.join('; ');
    }
    
    logger.debug('应用YouTube专用头部处理');
  }
  
  return proxyRequest;
}

module.exports = {
  preHandler,
  mediaPreHandler,
  preDisableCache,
  createCustomHomePathHandler,
  securityHeaderHandler,
  requestBodyHandler,
  youtubeHeaderHandler,
  isMediaUrl
}; 