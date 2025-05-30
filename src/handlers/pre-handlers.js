const CookieManager = require('../utils/cookie-parser');
const logger = require('../utils/logger');
const browserFingerprint = require('../utils/browser-fingerprint');

const cookieManager = new CookieManager();

/**
 * 增强的基础前置处理器 - 处理请求头
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

    // 应用浏览器指纹伪装
    const domain = upstream.host;
    const enhancedHeaders = browserFingerprint.applyFingerprint(lowercaseHeaders, domain);

    // 修改Host头部
    enhancedHeaders['host'] = upstream.host;

    // 修改Referer头部
    if (enhancedHeaders['referer']) {
      enhancedHeaders['referer'] = enhancedHeaders['referer']
        .replace(proxyRequest.site, upstream.site);
    }

    // 修改Origin头部
    if (enhancedHeaders['origin']) {
      enhancedHeaders['origin'] = enhancedHeaders['origin']
        .replace(proxyRequest.site, upstream.site);
    }

    // 处理Cookie头部
    if (enhancedHeaders['cookie']) {
      enhancedHeaders['cookie'] = cookieManager.convertRequestCookies(
        enhancedHeaders['cookie'],
        proxyRequest.site,
        upstream.site
      );
    }

    // 保留重要的浏览器特征头部（Cloudflare需要）
    const preserveHeaders = [
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user'
    ];

    // 移除可能干扰但保留重要特征的头部
    const headersToRemove = [
      'content-length', // 会被axios自动设置
      'connection', // 连接管理由axios处理
      'upgrade-insecure-requests' // 某些情况下可能干扰
    ];

    headersToRemove.forEach(header => {
      delete enhancedHeaders[header];
    });

    // 设置必要的浏览器特征头部（如果缺失）
    if (!enhancedHeaders['accept']) {
      enhancedHeaders['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    }

    if (!enhancedHeaders['accept-language']) {
      enhancedHeaders['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    }

    if (!enhancedHeaders['accept-encoding']) {
      enhancedHeaders['accept-encoding'] = 'gzip, deflate, br';
    }

    // 确保缓存控制头部存在
    if (!enhancedHeaders['cache-control']) {
      enhancedHeaders['cache-control'] = 'max-age=0';
    }

    // 设置DNT（Do Not Track）头部以增加真实性
    if (!enhancedHeaders['dnt']) {
      enhancedHeaders['dnt'] = '1';
    }

    // 设置Upgrade-Insecure-Requests（在HTTPS下）
    if (upstream.protocol === 'https:' && !enhancedHeaders['upgrade-insecure-requests']) {
      enhancedHeaders['upgrade-insecure-requests'] = '1';
    }

    proxyRequest.headers = enhancedHeaders;
    
    // 记录调试信息
    logger.debug('增强前置处理器执行完成', {
      upstream: upstream.site,
      path: proxyRequest.urlNoSite,
      method: proxyRequest.method,
      userAgent: enhancedHeaders['user-agent']?.substring(0, 50) + '...',
      hasSecHeaders: Object.keys(enhancedHeaders).some(h => h.startsWith('sec-'))
    });

    return proxyRequest;
  } catch (error) {
    logger.error('前置处理器执行失败:', error);
    throw error;
  }
}

/**
 * Cloudflare专用前置处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function cloudflarePreHandler(upstream, proxyRequest) {
  try {
    logger.debug('应用Cloudflare专用头部处理', {
      url: proxyRequest.urlNoSite,
      host: upstream.host
    });

    // 生成专门针对Cloudflare的指纹
    const fingerprint = browserFingerprint.generateFingerprint(upstream.host);
    
    // 设置完整的Chrome浏览器头部集合
    const cloudflareHeaders = {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'max-age=0',
      'dnt': '1',
      'sec-ch-ua': '"Google Chrome";v="120", "Chromium";v="120", "Not_A Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'user-agent': fingerprint.userAgent
    };

    // 合并现有头部与Cloudflare优化头部
    Object.assign(proxyRequest.headers, cloudflareHeaders);

    // 特殊处理某些Cloudflare敏感网站
    const cloudflareHosts = [
      'discord.com',
      'github.com',
      'reddit.com',
      'stackoverflow.com',
      'medium.com'
    ];

    if (cloudflareHosts.some(host => upstream.host.includes(host))) {
      // 为这些网站设置更保守的头部
      proxyRequest.headers['sec-fetch-site'] = 'same-origin';
      proxyRequest.headers['referer'] = upstream.site + '/';
      
      // 添加一些常见的浏览器Cookie
      const browseCookies = [
        '_ga=GA1.1.000000000.0000000000',
        '_gid=GA1.1.000000000.0000000000'
      ];
      
      if (proxyRequest.headers['cookie']) {
        proxyRequest.headers['cookie'] += '; ' + browseCookies.join('; ');
      } else {
        proxyRequest.headers['cookie'] = browseCookies.join('; ');
      }
    }

    logger.debug('Cloudflare专用头部处理完成', {
      host: upstream.host,
      headerCount: Object.keys(proxyRequest.headers).length
    });

    return proxyRequest;
  } catch (error) {
    logger.error('Cloudflare前置处理器执行失败:', error);
    return proxyRequest; // 出错时返回原请求
  }
}

/**
 * 增强的媒体/视频专用前置处理器
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
      
      // 生成媒体请求专用的浏览器指纹
      const fingerprint = browserFingerprint.generateFingerprint(upstream.host + '_media');
      
      // 设置媒体请求的完整浏览器特征
      proxyRequest.headers['user-agent'] = fingerprint.userAgent;
      proxyRequest.headers['accept'] = '*/*';
      proxyRequest.headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
      proxyRequest.headers['cache-control'] = 'no-cache';
      proxyRequest.headers['pragma'] = 'no-cache';
      
      // 保留重要的Sec-* 头部
      proxyRequest.headers['sec-ch-ua'] = fingerprint.headers['Sec-Ch-Ua'];
      proxyRequest.headers['sec-ch-ua-mobile'] = fingerprint.headers['Sec-Ch-Ua-Mobile'];
      proxyRequest.headers['sec-ch-ua-platform'] = fingerprint.headers['Sec-Ch-Ua-Platform'];
      proxyRequest.headers['sec-fetch-dest'] = 'video';
      proxyRequest.headers['sec-fetch-mode'] = 'no-cors';
      proxyRequest.headers['sec-fetch-site'] = 'cross-site';
      
      // 对于YouTube视频，设置特殊的Referer和Origin
      if (upstream.host.includes('googlevideo.com') || upstream.host.includes('youtube.com')) {
        proxyRequest.headers['referer'] = 'https://www.youtube.com/';
        proxyRequest.headers['origin'] = 'https://www.youtube.com';
        
        // 添加YouTube专用头部
        proxyRequest.headers['x-youtube-client-name'] = '1';
        proxyRequest.headers['x-youtube-client-version'] = '2.20231212.01.00';
        
        // YouTube特定的Accept-Encoding
        proxyRequest.headers['accept-encoding'] = 'gzip, deflate';
      } else {
        // 通用媒体请求
        proxyRequest.headers['referer'] = upstream.site + '/';
        delete proxyRequest.headers['origin']; // 某些媒体服务器不喜欢Origin头部
        proxyRequest.headers['accept-encoding'] = 'identity'; // 禁用压缩以避免处理复杂性
      }
      
      // 优化Cookie处理
      if (proxyRequest.headers['cookie']) {
        const cookies = proxyRequest.headers['cookie'].split(';')
          .map(c => c.trim())
          .filter(c => {
            const name = c.split('=')[0].toLowerCase();
            // 保留必要的Cookie，移除可能干扰的会话Cookie
            return !['session', 'auth', 'csrf', 'xsrf'].some(key => name.includes(key));
          });
        proxyRequest.headers['cookie'] = cookies.join('; ');
      }
      
      // 确保连接保持活跃
      proxyRequest.headers['connection'] = 'keep-alive';
      
      logger.debug('媒体请求头部优化完成', {
        host: upstream.host,
        hasRange: !!proxyRequest.headers['range'],
        userAgent: proxyRequest.headers['user-agent']?.substring(0, 30) + '...'
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
    /\.(mp4|m4v|webm|avi|mkv|mov|wmv|flv)(\?|$)/i, // 视频文件
    /\.(mp3|m4a|wav|flac|aac|ogg)(\?|$)/i,         // 音频文件
    /videoplayback/i,                               // YouTube视频播放
    /googlevideo\.com/i,                            // Google视频服务器
    /ytimg\.com.*\.(jpg|jpeg|png|webp)/i,          // YouTube图片
    /\/stream\//i,                                  // 流媒体路径
    /\/video\//i,                                   // 视频路径
    /\/audio\//i,                                   // 音频路径
    /\/media\//i,                                   // 媒体路径
    /manifest\.(m3u8|mpd)/i,                       // 流媒体清单文件
    /\.ts(\?|$)/i,                                 // HLS分片文件
    /chunk.*\.m4s/i,                               // DASH分片
    /segment.*\.(ts|m4s)/i                         // 流媒体分片
  ];
  
  return mediaPatterns.some(pattern => pattern.test(url));
}

/**
 * 反爬虫检测前置处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function antiDetectionPreHandler(upstream, proxyRequest) {
  try {
    // 移除所有可能暴露代理身份的头部
    const proxyHeaders = [
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'forwarded',
      'via',
      'x-gproxy-request-id',
      'x-gproxy-timestamp',
      'proxy-connection',
      'proxy-authorization'
    ];

    proxyHeaders.forEach(header => {
      delete proxyRequest.headers[header.toLowerCase()];
    });

    // 添加一些随机性以避免指纹识别
    const randomDelay = Math.random() * 100;
    if (randomDelay < 10) {
      // 10%的概率修改Accept头部的顺序
      if (proxyRequest.headers['accept']) {
        const acceptParts = proxyRequest.headers['accept'].split(',');
        if (acceptParts.length > 1) {
          // 轻微调整顺序
          const shuffled = [...acceptParts];
          if (Math.random() > 0.5 && shuffled.length > 2) {
            [shuffled[1], shuffled[2]] = [shuffled[2], shuffled[1]];
          }
          proxyRequest.headers['accept'] = shuffled.join(',');
        }
      }
    }

    // 设置真实的Accept-CH头部
    proxyRequest.headers['accept-ch'] = 'Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform';

    logger.debug('反检测处理完成');
    return proxyRequest;
  } catch (error) {
    logger.error('反检测前置处理器执行失败:', error);
    return proxyRequest;
  }
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
 * 增强的安全头部处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function securityHeaderHandler(upstream, proxyRequest) {
  // 不再简单删除所有代理头部，而是智能处理
  // 因为某些Sec-*头部对Cloudflare验证很重要
  
  const dangerousHeaders = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'forwarded',
    'via'
  ];

  dangerousHeaders.forEach(header => {
    delete proxyRequest.headers[header.toLowerCase()];
  });

  // 添加一些安全相关的头部以增加真实性
  if (!proxyRequest.headers['dnt']) {
    proxyRequest.headers['dnt'] = '1';
  }

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
 * YouTube专用头部处理器（增强版）
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyRequest} proxyRequest 代理请求对象
 * @returns {ProxyRequest} 处理后的代理请求对象
 */
function youtubeHeaderHandler(upstream, proxyRequest) {
  if (upstream.host.includes('youtube.com') || upstream.host.includes('googlevideo.com')) {
    // YouTube特定的完整浏览器头部设置
    proxyRequest.headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    
    // 设置YouTube相关的cookies
    const youtubeCookies = [
      'CONSENT=YES+cb.20210720-07-p0.en+FX+000',
      'VISITOR_INFO1_LIVE=Plq0ZBNk7Sw',
      'YSC=vQZNLVh0H9M',
      'PREF=tz=Asia.Shanghai'
    ];
    
    if (proxyRequest.headers['cookie']) {
      proxyRequest.headers['cookie'] += '; ' + youtubeCookies.join('; ');
    } else {
      proxyRequest.headers['cookie'] = youtubeCookies.join('; ');
    }

    // YouTube特定的Sec-Fetch头部
    if (proxyRequest.urlNoSite.includes('videoplayback')) {
      proxyRequest.headers['sec-fetch-dest'] = 'video';
      proxyRequest.headers['sec-fetch-mode'] = 'no-cors';
    } else {
      proxyRequest.headers['sec-fetch-dest'] = 'document';
      proxyRequest.headers['sec-fetch-mode'] = 'navigate';
    }
    
    logger.debug('应用YouTube专用头部处理');
  }
  
  return proxyRequest;
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