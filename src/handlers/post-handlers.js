const { URL } = require('url');
const zlib = require('zlib');
const CookieManager = require('../utils/cookie-parser');
const logger = require('../utils/logger');
const configLoader = require('../../config/config-loader');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');

const cookieManager = new CookieManager();

// 压缩方法的Promise版本
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * 智能内容类型检测
 */
function detectContentType(headers, content) {
  const contentType = headers['content-type'] || '';
  
  // 如果有明确的content-type，使用它
  if (contentType) {
    return {
      isHtml: contentType.includes('text/html'),
      isCss: contentType.includes('text/css'),
      isJavaScript: contentType.includes('javascript') || contentType.includes('application/json'),
      isXml: contentType.includes('xml'),
      isImage: contentType.includes('image/'),
      isVideo: contentType.includes('video/'),
      isAudio: contentType.includes('audio/'),
      isPdf: contentType.includes('application/pdf'),
      isBinary: contentType.includes('application/octet-stream') || 
                contentType.includes('image/') || 
                contentType.includes('video/') || 
                contentType.includes('audio/') ||
                contentType.includes('application/pdf') ||
                contentType.includes('application/zip'),
      isText: contentType.includes('text/') || 
              contentType.includes('application/json') || 
              contentType.includes('application/javascript') ||
              contentType.includes('application/xml'),
      contentType: contentType
    };
  }
  
  // 基于内容进行启发式检测
  if (Buffer.isBuffer(content)) {
    // 检查是否是二进制内容
    const sampleSize = Math.min(512, content.length);
    const sample = content.slice(0, sampleSize);
    
    // 二进制文件通常包含大量的null字节或非ASCII字符
    let binaryByteCount = 0;
    for (let i = 0; i < sample.length; i++) {
      const byte = sample[i];
      if (byte === 0 || byte > 127) {
        binaryByteCount++;
      }
    }
    
    // 如果超过30%的字节是二进制，认为是二进制文件
    if (binaryByteCount / sample.length > 0.3) {
      return { 
        isBinary: true, 
        isText: false, 
        contentType: 'application/octet-stream' 
      };
    }
    
    const contentStr = content.slice(0, 1024).toString('utf8', 0, Math.min(1024, content.length));
    
    // 检测HTML
    if (contentStr.includes('<!DOCTYPE') || contentStr.includes('<html') || 
        contentStr.includes('<HTML') || contentStr.includes('<head>')) {
      return { isHtml: true, isText: true, contentType: 'text/html' };
    }
    
    // 检测CSS
    if (contentStr.includes('@import') || contentStr.includes('@media') || 
        /\.[a-zA-Z-]+\s*\{/.test(contentStr)) {
      return { isCss: true, isText: true, contentType: 'text/css' };
    }
    
    // 检测JavaScript
    if (contentStr.includes('function') || contentStr.includes('var ') || 
        contentStr.includes('const ') || contentStr.includes('let ') ||
        contentStr.includes('=>') || contentStr.includes('JSON')) {
      return { isJavaScript: true, isText: true, contentType: 'application/javascript' };
    }
    
    // 检测XML
    if (contentStr.includes('<?xml') || contentStr.includes('<rss') || 
        contentStr.includes('<feed')) {
      return { isXml: true, isText: true, contentType: 'application/xml' };
    }
  }
  
  return { isText: false, isBinary: true, contentType: 'application/octet-stream' };
}

/**
 * 增强的解压缩处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
async function postDecompressHandler(upstream, proxyResponse) {
  try {
    const contentEncoding = proxyResponse.headers['content-encoding'];
    
    if (!contentEncoding || !Buffer.isBuffer(proxyResponse.content)) {
      return proxyResponse;
    }

    const encoding = contentEncoding.toLowerCase();
    
    // 同步解压缩处理
    try {
      let decompressed;
      
      switch (encoding) {
        case 'gzip':
          decompressed = await gunzip(proxyResponse.content);
          break;
        case 'deflate':
          decompressed = await inflate(proxyResponse.content);
          break;
        case 'br':
          decompressed = await brotliDecompress(proxyResponse.content);
          break;
        default:
          logger.warn('不支持的内容编码:', encoding);
          return proxyResponse;
      }
      
      logger.debug('内容解压缩成功', {
        encoding: encoding,
        originalSize: proxyResponse.content.length,
        decompressedSize: decompressed.length
      });
      
      // 更新内容和头部
      proxyResponse.content = decompressed;
      delete proxyResponse.headers['content-encoding'];
      proxyResponse.headers['content-length'] = decompressed.length.toString();
      
    } catch (error) {
      logger.error('内容解压缩失败:', error);
      // 解压缩失败时，移除压缩头部但保留原内容
      delete proxyResponse.headers['content-encoding'];
    }

    return proxyResponse;
  } catch (error) {
    logger.error('解压缩处理器失败:', error);
    return proxyResponse;
  }
}

/**
 * 增强的URL替换函数
 * @param {string} content 内容
 * @param {string} originalSite 原始站点
 * @param {string} proxySite 代理站点
 * @param {string} globalProxyPath 全局代理路径
 * @returns {string} 替换后的内容
 */
function enhancedUrlReplace(content, originalSite, proxySite, globalProxyPath) {
  try {
    if (!content || typeof content !== 'string') {
      return content;
    }
    
    // Base64编码函数
    function safeBase64Encode(str) {
      try {
        return Buffer.from(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
          function toSolidBytes(match, p1) {
            return String.fromCharCode('0x' + p1);
          })).toString('base64');
      } catch (error) {
        return encodeURIComponent(str);
      }
    }
    
    // 1. 替换绝对URL（http://、https://）
    content = content.replace(new RegExp(originalSite, 'g'), proxySite);
    
    // 2. 处理协议相对URL（//example.com）
    const originalHost = originalSite.replace(/https?:\/\//, '');
    const protocolRelativePattern = new RegExp(`//(?:www\\.)?${originalHost.replace(/\./g, '\\.')}`, 'g');
    content = content.replace(protocolRelativePattern, `//${proxySite.replace(/https?:\/\//, '')}`);
    
    // 3. 处理其他域名的URL，转换为全局代理格式
    const urlPattern = /(https?:\/\/[^\s"'<>()]+)/g;
    content = content.replace(urlPattern, (match) => {
      // 如果已经是代理URL，不再处理
      if (match.includes(proxySite) || match.includes(globalProxyPath)) {
        return match;
      }
      
      // 转换为全局代理URL
      const encodedUrl = safeBase64Encode(match);
      return `${proxySite}/${globalProxyPath}/${encodedUrl}`;
    });
    
    // 4. 处理相对URL（根据上下文）
    // 这里可以根据需要添加更多的相对URL处理逻辑
    
    return content;
  } catch (error) {
    logger.error('URL替换失败:', error);
    return content;
  }
}

/**
 * CSS特定处理函数
 * @param {string} cssContent CSS内容
 * @param {string} originalSite 原始站点
 * @param {string} proxySite 代理站点
 * @param {string} globalProxyPath 全局代理路径
 * @returns {string} 处理后的CSS内容
 */
function processCssContent(cssContent, originalSite, proxySite, globalProxyPath) {
  try {
    // 基础URL替换
    let processed = enhancedUrlReplace(cssContent, originalSite, proxySite, globalProxyPath);
    
    // 处理@import语句
    processed = processed.replace(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return `@import url(${quote}${modifiedUrl}${quote})`;
    });
    
    // 处理CSS中的url()函数
    processed = processed.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return `url(${quote}${modifiedUrl}${quote})`;
    });
    
    // 处理字体文件引用
    processed = processed.replace(/src:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return `src: url(${quote}${modifiedUrl}${quote})`;
    });
    
    return processed;
  } catch (error) {
    logger.error('CSS处理失败:', error);
    return cssContent;
  }
}

/**
 * JavaScript特定处理函数
 * @param {string} jsContent JavaScript内容
 * @param {string} originalSite 原始站点
 * @param {string} proxySite 代理站点
 * @param {string} globalProxyPath 全局代理路径
 * @returns {string} 处理后的JavaScript内容
 */
function processJavaScriptContent(jsContent, originalSite, proxySite, globalProxyPath) {
  try {
    // 基础URL替换
    let processed = enhancedUrlReplace(jsContent, originalSite, proxySite, globalProxyPath);
    
    // 处理fetch请求中的URL
    processed = processed.replace(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/gi, (match, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return match.replace(url, modifiedUrl);
    });
    
    // 处理XMLHttpRequest中的URL
    processed = processed.replace(/\.open\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/gi, (match, method, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return match.replace(url, modifiedUrl);
    });
    
    // 处理动态URL构建
    processed = processed.replace(/location\.href\s*=\s*['"`]([^'"`]+)['"`]/gi, (match, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return match.replace(url, modifiedUrl);
    });
    
    // 处理window.open
    processed = processed.replace(/window\.open\s*\(\s*['"`]([^'"`]+)['"`]/gi, (match, url) => {
      const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
      return match.replace(url, modifiedUrl);
    });
    
    return processed;
  } catch (error) {
    logger.error('JavaScript处理失败:', error);
    return jsContent;
  }
}

/**
 * HTML特定处理函数
 * @param {string} htmlContent HTML内容
 * @param {string} originalSite 原始站点
 * @param {string} proxySite 代理站点
 * @param {string} globalProxyPath 全局代理路径
 * @returns {string} 处理后的HTML内容
 */
function processHtmlContent(htmlContent, originalSite, proxySite, globalProxyPath) {
  try {
    // 基础URL替换
    let processed = enhancedUrlReplace(htmlContent, originalSite, proxySite, globalProxyPath);
    
    // 处理meta标签中的URL
    processed = processed.replace(/<meta([^>]*)(property|name)=["']?([^"'>]*url[^"'>]*)["']?([^>]*content=["']?)([^"'>]+)(["'][^>]*>)/gi, 
      (match, before, attrType, attrName, contentStart, url, contentEnd) => {
        const modifiedUrl = enhancedUrlReplace(url, originalSite, proxySite, globalProxyPath);
        return `<meta${before}${attrType}="${attrName}"${contentStart}${modifiedUrl}${contentEnd}`;
      });
    
    // 处理base标签
    processed = processed.replace(/<base\s+href=["']?([^"'>]+)["']?([^>]*)>/gi, (match, href, rest) => {
      const modifiedHref = enhancedUrlReplace(href, originalSite, proxySite, globalProxyPath);
      return `<base href="${modifiedHref}"${rest}>`;
    });
    
    // 处理link标签
    processed = processed.replace(/<link([^>]*href=["']?)([^"'>]+)(["'][^>]*>)/gi, (match, before, href, after) => {
      const modifiedHref = enhancedUrlReplace(href, originalSite, proxySite, globalProxyPath);
      return `<link${before}${modifiedHref}${after}`;
    });
    
    // 处理form action
    processed = processed.replace(/<form([^>]*action=["']?)([^"'>]+)(["'][^>]*>)/gi, (match, before, action, after) => {
      const modifiedAction = enhancedUrlReplace(action, originalSite, proxySite, globalProxyPath);
      return `<form${before}${modifiedAction}${after}`;
    });
    
    // 处理iframe src
    processed = processed.replace(/<iframe([^>]*src=["']?)([^"'>]+)(["'][^>]*>)/gi, (match, before, src, after) => {
      const modifiedSrc = enhancedUrlReplace(src, originalSite, proxySite, globalProxyPath);
      return `<iframe${before}${modifiedSrc}${after}`;
    });
    
    // 处理video/audio源文件
    processed = processed.replace(/<(video|audio|source)([^>]*src=["']?)([^"'>]+)(["'][^>]*>)/gi, (match, tag, before, src, after) => {
      const modifiedSrc = enhancedUrlReplace(src, originalSite, proxySite, globalProxyPath);
      return `<${tag}${before}${modifiedSrc}${after}`;
    });
    
    // 处理内联CSS中的URL
    processed = processed.replace(/style=["']([^"']*url\([^)]+\)[^"']*)["']/gi, (match, style) => {
      const modifiedStyle = processCssContent(style, originalSite, proxySite, globalProxyPath);
      return `style="${modifiedStyle}"`;
    });
    
    return processed;
  } catch (error) {
    logger.error('HTML处理失败:', error);
    return htmlContent;
  }
}

/**
 * 基础后置处理器 - 处理响应头
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
function postHandler(upstream, proxyResponse) {
  try {
    const headers = { ...proxyResponse.headers };
    const request = proxyResponse.proxyRequest;

    // 移除可能干扰的头部
    const headersToRemove = [
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'x-content-type-options',
      'strict-transport-security',
      'expect-ct',
      'referrer-policy',
      'feature-policy',
      'permissions-policy',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
      'origin-agent-cluster'
    ];

    headersToRemove.forEach(header => {
      delete headers[header];
    });

    // 添加CORS头部
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
    headers['access-control-allow-headers'] = 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control';

    // 处理Location头部（重定向）
    if (headers['location']) {
      headers['location'] = headers['location'].replace(upstream.site, request.site);
      logger.debug('重定向URL转换:', headers['location']);
    }

    // 处理Set-Cookie头部
    if (headers['set-cookie']) {
      if (Array.isArray(headers['set-cookie'])) {
        headers['set-cookie'] = headers['set-cookie'].map(cookie => 
          convertResponseCookie(cookie, upstream.site, request.site)
        );
      } else {
        headers['set-cookie'] = convertResponseCookie(headers['set-cookie'], upstream.site, request.site);
      }
    }

    // 处理Content-Type
    if (headers['content-type']) {
      // 确保字符编码
      if (headers['content-type'].includes('text/') && !headers['content-type'].includes('charset')) {
        headers['content-type'] += '; charset=utf-8';
      }
    }

    // 优化缓存策略
    if (headers['cache-control']) {
      // 为代理内容调整缓存策略
      if (headers['cache-control'].includes('no-store')) {
        headers['cache-control'] = 'no-cache, must-revalidate';
      }
    }

    proxyResponse.headers = headers;

    logger.debug('后置头部处理完成', {
      statusCode: proxyResponse.statusCode,
      contentType: headers['content-type']
    });

    return proxyResponse;
  } catch (error) {
    logger.error('后置处理器失败:', error);
    return proxyResponse;
  }
}

/**
 * 增强的内容替换处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
function postReplaceContentHandler(upstream, proxyResponse) {
  try {
    if (!proxyResponse.content) {
      return proxyResponse;
    }

    // 检测内容类型
    const contentInfo = detectContentType(proxyResponse.headers, proxyResponse.content);
    
    // 对于二进制内容，直接返回不做处理
    if (contentInfo.isBinary || !contentInfo.isText) {
      logger.debug('跳过二进制内容处理', {
        contentType: contentInfo.contentType,
        isBinary: contentInfo.isBinary,
        isText: contentInfo.isText
      });
      return proxyResponse;
    }

    // 转换为字符串
    let content = Buffer.isBuffer(proxyResponse.content) 
      ? proxyResponse.content.toString('utf-8')
      : proxyResponse.content.toString();

    if (!content) {
      return proxyResponse;
    }

    const request = proxyResponse.proxyRequest;
    const config = configLoader.getConfig();
    
    // 获取代理站点信息
    const proxySite = request.site;
    const globalProxyPath = config.globalProxyPath;

    // 根据内容类型进行特定处理
    if (contentInfo.isHtml) {
      content = processHtmlContent(content, upstream.site, proxySite, globalProxyPath);
    } else if (contentInfo.isCss) {
      content = processCssContent(content, upstream.site, proxySite, globalProxyPath);
    } else if (contentInfo.isJavaScript) {
      content = processJavaScriptContent(content, upstream.site, proxySite, globalProxyPath);
    } else {
      // 通用文本处理
      content = enhancedUrlReplace(content, upstream.site, proxySite, globalProxyPath);
    }

    // 执行配置中的替换规则
    const replaceList = config.replaceList || [];
    for (const replaceItem of replaceList) {
      try {
        if (replaceItem.urlMatch && !new RegExp(replaceItem.urlMatch).test(request.urlNoSite)) {
          continue;
        }
        
        if (replaceItem.urlExclude && new RegExp(replaceItem.urlExclude).test(request.urlNoSite)) {
          continue;
        }
        
        if (replaceItem.contentType && !contentInfo.contentType.includes(replaceItem.contentType)) {
          continue;
        }

        let searchStr = replaceItem.search;
        let replaceStr = replaceItem.replace;

        // 处理关键词替换
        searchStr = searchStr
          .replace(/\$upstream/g, upstream.site)
          .replace(/\$custom_site/g, proxySite)
          .replace(/\$scheme/g, new URL(proxySite).protocol.slice(0, -1))
          .replace(/\$host/g, new URL(proxySite).host)
          .replace(/\$PROXY/g, globalProxyPath);

        replaceStr = replaceStr
          .replace(/\$upstream/g, upstream.site)
          .replace(/\$custom_site/g, proxySite)
          .replace(/\$scheme/g, new URL(proxySite).protocol.slice(0, -1))
          .replace(/\$host/g, new URL(proxySite).host)
          .replace(/\$PROXY/g, globalProxyPath);

        if (replaceItem.matchType === 2) {
          // 正则表达式替换
          const regex = new RegExp(searchStr, 'g');
          content = content.replace(regex, replaceStr);
        } else {
          // 字符串替换
          content = content.replace(new RegExp(searchStr, 'g'), replaceStr);
        }
      } catch (error) {
        logger.warn('替换规则执行失败:', {
          rule: replaceItem,
          error: error.message
        });
      }
    }

    // 更新内容
    proxyResponse.content = Buffer.from(content, 'utf-8');
    
    // 更新Content-Length
    if (proxyResponse.headers['content-length']) {
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
    }

    logger.debug('内容替换处理完成', {
      contentType: contentInfo.contentType,
      originalSize: proxyResponse.content.length,
      rulesApplied: replaceList.length
    });

    return proxyResponse;
  } catch (error) {
    logger.error('内容替换处理器失败:', error);
    return proxyResponse;
  }
}

/**
 * 增强的JavaScript注入处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
function postInjectHandler(upstream, proxyResponse) {
  try {
    // 只对HTML内容注入
    const contentType = proxyResponse.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      return proxyResponse;
    }

    if (!proxyResponse.content) {
      return proxyResponse;
    }

    // 转换为字符串
    let content = Buffer.isBuffer(proxyResponse.content) 
      ? proxyResponse.content.toString('utf-8')
      : proxyResponse.content.toString();

    // 读取注入脚本
    const injectJsPath = path.join(__dirname, '../../static/inject.js');
    
    if (!fs.existsSync(injectJsPath)) {
      logger.warn('注入脚本文件不存在:', injectJsPath);
      return proxyResponse;
    }

    let injectScript = fs.readFileSync(injectJsPath, 'utf-8');
    
    // 替换配置占位符
    const config = configLoader.getConfig();
    injectScript = injectScript.replace(/#global_proxy_path#/g, config.globalProxyPath || 'proxy-dGltZWhv');

    // 添加当前站点信息到脚本中
    const siteInfo = `
    // 当前代理站点信息
    window.__GPROXY_INFO__ = {
      upstream: '${upstream.site}',
      proxy: '${proxyResponse.proxyRequest.site}',
      globalPath: '${config.globalProxyPath}',
      timestamp: ${Date.now()}
    };
    `;

    injectScript = siteInfo + injectScript;

    // 创建完整的注入内容
    const fullInjectScript = `
    <script type="text/javascript">
    (function() {
      // 确保脚本只执行一次
      if (window.__GPROXY_INJECTED__) return;
      window.__GPROXY_INJECTED__ = true;
      
      ${injectScript}
    })();
    </script>
    `;

    // 智能注入位置选择
    let injectionPoint = -1;
    
    // 优先在</head>之前注入
    injectionPoint = content.indexOf('</head>');
    if (injectionPoint !== -1) {
      content = content.slice(0, injectionPoint) + fullInjectScript + content.slice(injectionPoint);
    } else {
      // 其次在<body>之后注入
      injectionPoint = content.indexOf('<body');
      if (injectionPoint !== -1) {
        const bodyEnd = content.indexOf('>', injectionPoint);
        if (bodyEnd !== -1) {
          content = content.slice(0, bodyEnd + 1) + fullInjectScript + content.slice(bodyEnd + 1);
        }
      } else {
        // 最后在</html>之前注入
        injectionPoint = content.indexOf('</html>');
        if (injectionPoint !== -1) {
          content = content.slice(0, injectionPoint) + fullInjectScript + content.slice(injectionPoint);
        } else {
          // 如果都找不到，直接追加到末尾
          content += fullInjectScript;
        }
      }
    }

    // 更新内容
    proxyResponse.content = Buffer.from(content, 'utf-8');
    
    // 更新Content-Length
    if (proxyResponse.headers['content-length']) {
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
    }

    logger.debug('JavaScript注入完成', {
      injectionPoint: injectionPoint !== -1 ? 'found' : 'appended',
      scriptSize: fullInjectScript.length
    });

    return proxyResponse;
  } catch (error) {
    logger.error('JavaScript注入处理器失败:', error);
    return proxyResponse;
  }
}

/**
 * 转换响应Cookie
 * @param {string} cookie Cookie字符串
 * @param {string} upstreamSite 上游站点
 * @param {string} proxySite 代理站点
 * @returns {string} 转换后的Cookie
 */
function convertResponseCookie(cookie, upstreamSite, proxySite) {
  try {
    // 基础域名替换
    let converted = cookie.replace(
      new RegExp(new URL(upstreamSite).hostname, 'g'),
      new URL(proxySite).hostname
    );

    // 处理Domain属性
    converted = converted.replace(/Domain=([^;]+)/gi, (match, domain) => {
      const cleanDomain = domain.trim();
      if (cleanDomain.includes(new URL(upstreamSite).hostname)) {
        return `Domain=${new URL(proxySite).hostname}`;
      }
      return match;
    });

    // 处理Path属性 - 保持原有路径
    // 移除Secure属性（如果代理服务器不是HTTPS）
    if (new URL(proxySite).protocol === 'http:') {
      converted = converted.replace(/;\s*Secure\s*(;|$)/gi, ';');
    }

    // 修改SameSite属性以适应代理
    converted = converted.replace(/SameSite=Strict/gi, 'SameSite=Lax');
    converted = converted.replace(/SameSite=None/gi, 'SameSite=Lax');

    return converted;
  } catch (error) {
    logger.warn('Cookie转换失败:', error);
    return cookie;
  }
}

/**
 * 响应头优化处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
function postOptimizeHeadersHandler(upstream, proxyResponse) {
  try {
    const headers = proxyResponse.headers;
    
    // 优化缓存策略
    const contentType = headers['content-type'] || '';
    
    if (contentType.includes('text/html')) {
      // HTML页面：短期缓存
      headers['cache-control'] = 'public, max-age=300'; // 5分钟
    } else if (contentType.includes('application/javascript') || contentType.includes('text/css')) {
      // JS/CSS：长期缓存
      headers['cache-control'] = 'public, max-age=86400'; // 1天
    } else if (contentType.includes('image/')) {
      // 图片：长期缓存
      headers['cache-control'] = 'public, max-age=604800'; // 1周
    }
    
    // 添加代理标识（调试用）
    if (process.env.NODE_ENV === 'development') {
      headers['x-gproxy-version'] = '2.0.0';
      headers['x-gproxy-processed'] = new Date().toISOString();
    }
    
    return proxyResponse;
  } catch (error) {
    logger.error('响应头优化失败:', error);
    return proxyResponse;
  }
}

/**
 * 智能错误页面处理器
 * @param {Upstream} upstream 上游服务器信息
 * @param {ProxyResponse} proxyResponse 代理响应对象
 * @returns {ProxyResponse} 处理后的响应对象
 */
function postErrorPageHandler(upstream, proxyResponse) {
  try {
    // 只处理错误状态码
    if (proxyResponse.statusCode < 400) {
      return proxyResponse;
    }
    
    const contentType = proxyResponse.headers['content-type'] || '';
    
    // 只处理HTML错误页面
    if (!contentType.includes('text/html')) {
      return proxyResponse;
    }
    
    let content = Buffer.isBuffer(proxyResponse.content) 
      ? proxyResponse.content.toString('utf-8')
      : proxyResponse.content.toString();
    
    // 如果是简单的错误页面，增强它
    if (content.length < 500 || !content.includes('<html')) {
      const enhancedErrorPage = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>代理错误 ${proxyResponse.statusCode}</title>
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
        }
        .retry-btn {
            background: #3498db; color: white;
            padding: 12px 24px; border: none;
            border-radius: 5px; cursor: pointer;
            font-size: 1em; margin: 10px;
            transition: background 0.3s;
        }
        .retry-btn:hover { background: #2980b9; }
        .footer { margin-top: 30px; color: #7f8c8d; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-code">${proxyResponse.statusCode}</div>
        <div class="error-message">
            ${getErrorMessage(proxyResponse.statusCode)}
        </div>
        <div class="details">
            <strong>请求地址:</strong> ${upstream.site}<br>
            <strong>代理服务器:</strong> Gproxy-Node v2.0.0<br>
            <strong>时间:</strong> ${new Date().toLocaleString('zh-CN')}
        </div>
        <button class="retry-btn" onclick="location.reload()">重试</button>
        <button class="retry-btn" onclick="history.back()">返回</button>
        <div class="footer">
            如果问题持续存在，请联系管理员或稍后重试
        </div>
    </div>
</body>
</html>`;
      
      proxyResponse.content = Buffer.from(enhancedErrorPage, 'utf-8');
      proxyResponse.headers['content-type'] = 'text/html; charset=utf-8';
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
    }
    
    return proxyResponse;
  } catch (error) {
    logger.error('错误页面处理失败:', error);
    return proxyResponse;
  }
}

/**
 * 获取友好的错误消息
 * @param {number} statusCode HTTP状态码
 * @returns {string} 错误消息
 */
function getErrorMessage(statusCode) {
  const errorMessages = {
    400: '请求格式错误，请检查请求参数',
    401: '需要身份验证，请登录后重试',
    403: '访问被拒绝，可能是目标服务器的防护机制',
    404: '请求的资源不存在',
    429: '请求过于频繁，请稍后重试',
    500: '目标服务器内部错误',
    502: '网关错误，无法连接到目标服务器',
    503: '目标服务器暂时不可用',
    504: '网关超时，目标服务器响应过慢'
  };
  
  return errorMessages[statusCode] || `HTTP错误 ${statusCode}`;
}

module.exports = {
  postHandler,
  postReplaceContentHandler,
  postInjectHandler,
  postDecompressHandler,
  postOptimizeHeadersHandler,
  postErrorPageHandler,
  
  // 内容处理函数
  enhancedUrlReplace,
  processCssContent,
  processJavaScriptContent,
  processHtmlContent,
  detectContentType,
  
  // 工具函数
  convertResponseCookie
}; 