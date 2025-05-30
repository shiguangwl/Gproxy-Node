const { URL } = require('url');
const zlib = require('zlib');
const CookieManager = require('../utils/cookie-parser');
const logger = require('../utils/logger');
const configLoader = require('../config/config-loader');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const { HandlerError } = require('../utils/errors');

const cookieManager = new CookieManager();

// 压缩方法的Promise版本
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * 智能内容类型检测，结合Content-Type头部和内容启发式分析。
 * @param {object} headers 响应头部对象。
 * @param {Buffer} content 响应内容Buffer。
 * @returns {object} 包含isHtml, isCss, isJavaScript, isJson, isXml等布尔标志以及contentType字符串的对象。
 */
function detectContentType(headers, content) {
  const contentTypeHeader = headers['content-type'] || '';
  
  if (contentTypeHeader) {
    return {
      isHtml: contentTypeHeader.includes('text/html'),
      isCss: contentTypeHeader.includes('text/css'),
      isJavaScript: contentTypeHeader.includes('application/javascript') || contentTypeHeader.includes('text/javascript'),
      isJson: contentTypeHeader.includes('application/json'),
      isXml: contentTypeHeader.includes('application/xml') || contentTypeHeader.includes('text/xml'),
      isImage: contentTypeHeader.includes('image/'),
      isVideo: contentTypeHeader.includes('video/'),
      isAudio: contentTypeHeader.includes('audio/'),
      isPdf: contentTypeHeader.includes('application/pdf'),
      isBinary: contentTypeHeader.includes('application/octet-stream') || 
                contentTypeHeader.includes('image/') || 
                contentTypeHeader.includes('video/') || 
                contentTypeHeader.includes('audio/') ||
                contentTypeHeader.includes('application/pdf') ||
                contentTypeHeader.includes('application/zip'),
      isText: contentTypeHeader.includes('text/') || 
              contentTypeHeader.includes('application/json') || 
              contentTypeHeader.includes('application/javascript') ||
              contentTypeHeader.includes('application/xml'),
      contentType: contentTypeHeader
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
      return { isBinary: true, isText: false, contentType: 'application/octet-stream', isHtml: false, isCss: false, isJavaScript: false, isJson: false, isXml: false };
    }
    
    const contentStr = content.slice(0, 1024).toString('utf8', 0, Math.min(1024, content.length));
    
    // 检测HTML
    if (contentStr.includes('<!DOCTYPE') || contentStr.includes('<html') || 
        contentStr.includes('<HTML') || contentStr.includes('<head>')) {
      return { isHtml: true, isText: true, contentType: 'text/html', isJson: false, isXml: false };
    }
    
    // 检测CSS
    if (contentStr.includes('@import') || contentStr.includes('@media') || 
        /\.[a-zA-Z-]+\s*\{/.test(contentStr)) {
      return { isCss: true, isText: true, contentType: 'text/css', isJson: false, isXml: false };
    }
    
    // 检测JavaScript
    if (contentStr.includes('function') || contentStr.includes('var ') || 
        contentStr.includes('const ') || contentStr.includes('let ') ||
        contentStr.includes('=>')) {
      return { isJavaScript: true, isText: true, contentType: 'application/javascript', isJson: false, isHtml: false, isCss: false, isXml: false };
    }
    
    // 检测XML
    if (contentStr.includes('<?xml') || contentStr.includes('<rss') || 
        contentStr.includes('<feed')) {
      return { isXml: true, isText: true, contentType: 'application/xml', isJson: false, isHtml: false, isCss: false };
    }
    
    // In heuristic JS detection, if it looks like JSON (starts with { or [), flag isJson
    const trimmedContent = contentStr.trim();
    if ((trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) || (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))) {
      try {
        JSON.parse(trimmedContent); // Validate if it's actual JSON
        return { isJson: true, isText: true, contentType: 'application/json', isJavaScript: false, isHtml: false, isCss: false, isXml: false };
      } catch (e) { /* Not valid JSON */ }
    }
  }
  
  return { isText: false, isBinary: true, contentType: 'application/octet-stream', isHtml: false, isCss: false, isJavaScript: false, isJson: false, isXml: false };
}

/**
 * 响应内容解压缩处理器。
 * 支持gzip, deflate, brotli编码。解压后更新响应内容和相关头部。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {Promise<import('../entities').ProxyResponse>} 处理后的响应对象。
 */
async function postDecompressHandler(upstream, proxyResponse) {
  try {
    const contentEncoding = proxyResponse.headers['content-encoding'];
    
    if (!contentEncoding || !Buffer.isBuffer(proxyResponse.content) || proxyResponse.content.length === 0) {
      return proxyResponse;
    }

    const encoding = contentEncoding.toLowerCase();
    
    // 同步解压缩处理
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
    
    return proxyResponse;
  } catch (error) {
    logger.error('postDecompressHandler 执行失败:', { error: error.message, stack: error.stack });
    // If decompression fails, it's often better to return the original content if possible, 
    // but remove the content-encoding header to prevent client from trying to decompress corrupted data.
    delete proxyResponse.headers['content-encoding'];
    // throw new HandlerError(`postDecompressHandler 失败: ${error.message}`, 'postDecompressHandler', error); 
    // Decided to return proxyResponse on decompression error to allow client to potentially still use it.
    return proxyResponse;
  }
}

/**
 * 增强的URL替换函数。
 * 替换内容中的绝对URL、协议相对URL，并将其他域名的URL转换为全局代理格式。
 * @param {string} content 要处理的内容字符串。
 * @param {string} originalSite 原始站点URL (e.g., https://original.com)。
 * @param {string} proxySite 代理站点URL (e.g., https://proxy.com)。
 * @param {string} globalProxyPath 全局代理路径段。
 * @returns {string} URL替换后的内容字符串。
 */
function enhancedUrlReplace(content, originalSite, proxySite, globalProxyPath) {
  try {
    if (!content || typeof content !== 'string') {
      return content;
    }
    
    // Base64编码函数
    function _safeBase64EncodeUrl(str) {
      try {
        // Directly encode the UTF-8 string to Base64
        return Buffer.from(str, 'utf8').toString('base64');
      } catch (error) {
        // Fallback for safety, though Buffer.from should handle typical strings.
        // Original fallback was encodeURIComponent, which is not a Base64 encoding.
        // If an error occurs here, it's likely an issue with `str` itself.
        // Returning the original string تغييرات  or a marker might be better than encodeURIComponent.
        logger.warn('safeBase64EncodeUrl failed for input:', str, error);
        return str; // Or perhaps a URL-safe version of the original string if base64 fails
      }
    }
    
    // 1. 替换绝对URL（http://、https://）
    // Ensure originalSite and proxySite are properly escaped for RegExp if they contain special chars
    const escapedOriginalSite = originalSite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(escapedOriginalSite, 'g'), proxySite);
    
    // 2. 处理协议相对URL（//example.com）
    const originalHost = new URL(originalSite).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const protocolRelativePattern = new RegExp(`//(?:www\\.)?${originalHost}`, 'g');
    content = content.replace(protocolRelativePattern, `//${new URL(proxySite).host}`);
    
    // 3. 处理其他域名的URL，转换为全局代理格式
    const urlPattern = /(https?:\/\/[^\s"'<>()]+)/g;
    content = content.replace(urlPattern, (match) => {
      if (match.startsWith(proxySite) || match.includes(`/${globalProxyPath}/`)) {
        return match;
      }
      // Avoid re-proxying URLs that are already pointing to common CDNs or known safe external domains if needed.
      // For now, all external URLs not matching proxySite are re-proxied.
      const encodedUrl = _safeBase64EncodeUrl(match);
      return `${proxySite}/${globalProxyPath}/${encodedUrl}`;
    });
    
    return content;
  } catch (error) {
    logger.error('URL替换失败:', error);
    return content;
  }
}

/**
 * CSS特定内容处理函数。
 * 调用 enhancedUrlReplace 并额外处理CSS中的 @import 和 url() 语句。
 * @param {string} cssContent CSS内容字符串。
 * @param {string} originalSite 原始站点URL。
 * @param {string} proxySite 代理站点URL。
 * @param {string} globalProxyPath 全局代理路径段。
 * @returns {string} 处理后的CSS内容字符串。
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
 * JavaScript特定内容处理函数。
 * 调用 enhancedUrlReplace 并额外处理JS中常见的URL模式，如fetch, XMLHttpRequest.open, location.href, window.open。
 * @param {string} jsContent JavaScript内容字符串。
 * @param {string} originalSite 原始站点URL。
 * @param {string} proxySite 代理站点URL。
 * @param {string} globalProxyPath 全局代理路径段。
 * @returns {string} 处理后的JavaScript内容字符串。
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
 * HTML特定内容处理函数。
 * 调用 enhancedUrlReplace 并额外处理HTML标签的属性如href, src, action以及内联style中的URL。
 * @param {string} htmlContent HTML内容字符串。
 * @param {string} originalSite 原始站点URL。
 * @param {string} proxySite 代理站点URL。
 * @param {string} globalProxyPath 全局代理路径段。
 * @returns {string} 处理后的HTML内容字符串。
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
 * 基础后置处理器 - 主要处理响应头。
 * 移除潜在冲突的安全头部，添加CORS头部，转换Location和Set-Cookie头部，确保文本类型编码。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {import('../entities').ProxyResponse} 处理后的响应对象。
 */
function postHandler(upstream, proxyResponse) {
  try {
    const headers = { ...proxyResponse.headers };
    const request = proxyResponse.proxyRequest;
    const upstreamSite = upstream.site;
    const proxySite = request?.site; // request might be null if proxyResponse was an error created early

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
      if (proxySite) {
        headers['location'] = headers['location'].replace(upstreamSite, proxySite);
        logger.debug('重定向URL转换:', { newLocation: headers['location'] });
      } else {
        logger.warn('无法转换Location头：缺少proxyRequest.site信息');
      }
    }

    // 处理Set-Cookie头部
    if (headers['set-cookie']) {
      if (proxySite) {
        headers['set-cookie'] = cookieManager.handleSetCookieFromUpstream(
          headers['set-cookie'], 
          upstreamSite, // URL the cookie was received from (upstream)
          proxySite     // URL the client is talking to (proxy)
        );
      } else {
        logger.warn('无法转换Set-Cookie头：缺少proxyRequest.site信息');
        // Decide: pass through original Set-Cookie, or remove, or attempt partial modification?
        // Passing through is risky as domain/path will be for upstream.
        // Removing is safest if proxySite is unknown.
        delete headers['set-cookie'];
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
    logger.error('postHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`postHandler 失败: ${error.message}`, 'postHandler', error);
  }
}

/**
 * 内容替换后置处理器。
 * 根据检测到的内容类型（HTML, CSS, JS）调用相应的处理函数进行URL替换，
 * 并应用配置文件中的自定义替换规则。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {import('../entities').ProxyResponse} 处理后的响应对象。
 */
function postReplaceContentHandler(upstream, proxyResponse) {
  try {
    if (!proxyResponse.content) {
      return proxyResponse;
    }
    const contentInfo = detectContentType(proxyResponse.headers, proxyResponse.content);
    if (contentInfo.isBinary || !(contentInfo.isText || contentInfo.isJson || contentInfo.isJavaScript)) {
      logger.debug('跳过非文本/JSON/JS内容处理', { contentType: contentInfo.contentType });
      return proxyResponse;
    }
    let content = Buffer.isBuffer(proxyResponse.content) 
      ? proxyResponse.content.toString('utf-8')
      : proxyResponse.content.toString();
    if (!content) {
      return proxyResponse;
    }
    const request = proxyResponse.proxyRequest;
    const config = configLoader.getConfig();
    const proxySite = request.site;
    const globalProxyPath = config.globalProxyPath;

    if (contentInfo.isHtml) {
      content = processHtmlContent(content, upstream.site, proxySite, globalProxyPath);
    } else if (contentInfo.isCss) {
      content = processCssContent(content, upstream.site, proxySite, globalProxyPath);
    } else if (contentInfo.isJavaScript) {
      content = processJavaScriptContent(content, upstream.site, proxySite, globalProxyPath);
    } else if (contentInfo.isJson) {
      content = enhancedUrlReplace(content, upstream.site, proxySite, globalProxyPath);
    } else {
      content = enhancedUrlReplace(content, upstream.site, proxySite, globalProxyPath);
    }

    const replaceList = config.replaceList || [];
    for (const replaceItem of replaceList) {
      try {
        if (replaceItem.urlMatch && !new RegExp(replaceItem.urlMatch).test(request.urlNoSite)) continue;
        if (replaceItem.urlExclude && new RegExp(replaceItem.urlExclude).test(request.urlNoSite)) continue;
        if (replaceItem.contentType && !contentInfo.contentType.includes(replaceItem.contentType)) continue;
        let searchStr = replaceItem.search.replace(/\$upstream/g, upstream.site).replace(/\$custom_site/g, proxySite).replace(/\$scheme/g, new URL(proxySite).protocol.slice(0, -1)).replace(/\$host/g, new URL(proxySite).host).replace(/\$PROXY/g, globalProxyPath);
        let replaceStr = replaceItem.replace.replace(/\$upstream/g, upstream.site).replace(/\$custom_site/g, proxySite).replace(/\$scheme/g, new URL(proxySite).protocol.slice(0, -1)).replace(/\$host/g, new URL(proxySite).host).replace(/\$PROXY/g, globalProxyPath);
        content = content.replace(new RegExp(searchStr, replaceItem.matchType === 2 ? 'g' : 'gi'), replaceStr); // use 'gi' for string replace for consistency if desired, or just 'g'
      } catch (ruleError) {
        logger.warn('替换规则执行失败:', { rule: replaceItem, error: ruleError.message });
      }
    }
    proxyResponse.content = Buffer.from(content, 'utf-8');
    if (proxyResponse.headers['content-length']) {
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
    }
    logger.debug('内容替换处理完成', { contentType: contentInfo.contentType, rulesApplied: replaceList.length });
    return proxyResponse;
  } catch (error) {
    logger.error('postReplaceContentHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`postReplaceContentHandler 失败: ${error.message}`, 'postReplaceContentHandler', error);
  }
}

/**
 * JavaScript注入后置处理器。
 * 向HTML响应中注入位于 static/inject.js 的脚本，并传递代理相关信息。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {import('../entities').ProxyResponse} 处理后的响应对象。
 */
function postInjectHandler(upstream, proxyResponse) {
  try {
    const contentType = proxyResponse.headers['content-type'] || '';
    if (!contentType.includes('text/html') || !proxyResponse.content) {
      return proxyResponse;
    }
    let content = Buffer.isBuffer(proxyResponse.content) ? proxyResponse.content.toString('utf-8') : proxyResponse.content.toString();
    const injectJsPath = path.join(__dirname, '../../static/inject.js');
    if (!fs.existsSync(injectJsPath)) {
      logger.warn('注入脚本文件不存在:', injectJsPath);
      return proxyResponse;
    }
    let injectScript = fs.readFileSync(injectJsPath, 'utf-8');
    const config = configLoader.getConfig();
    injectScript = injectScript.replace(/#global_proxy_path#/g, config.globalProxyPath || 'proxy-dGltZWhv');
    const siteInfo = `\nwindow.__GPROXY_INFO__ = { upstream: '${upstream.site}', proxy: '${proxyResponse.proxyRequest.site}', globalPath: '${config.globalProxyPath}', timestamp: ${Date.now()} };\n`;
    injectScript = siteInfo + injectScript;
    const fullInjectScript = `\n<script type="text/javascript">\n(function() { if (window.__GPROXY_INJECTED__) return; window.__GPROXY_INJECTED__ = true; ${injectScript} })();\n</script>\n`;
    let injectionPoint = content.indexOf('</head>');
    if (injectionPoint !== -1) {
      content = content.slice(0, injectionPoint) + fullInjectScript + content.slice(injectionPoint);
    } else {
      injectionPoint = content.indexOf('<body');
      if (injectionPoint !== -1) {
        const bodyEnd = content.indexOf('>', injectionPoint);
        if (bodyEnd !== -1) content = content.slice(0, bodyEnd + 1) + fullInjectScript + content.slice(bodyEnd + 1);
        else content += fullInjectScript; 
      } else {
        injectionPoint = content.indexOf('</html>');
        if (injectionPoint !== -1) content = content.slice(0, injectionPoint) + fullInjectScript + content.slice(injectionPoint);
        else content += fullInjectScript;
      }
    }
    proxyResponse.content = Buffer.from(content, 'utf-8');
    if (proxyResponse.headers['content-length']) {
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
    }
    logger.debug('JavaScript注入完成', { injectionPoint: injectionPoint !== -1 ? 'found' : 'appended' });
    return proxyResponse;
  } catch (error) {
    logger.error('postInjectHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`postInjectHandler 失败: ${error.message}`, 'postInjectHandler', error);
  }
}

/**
 * 响应头优化后置处理器。
 * 根据内容类型设置不同的Cache-Control策略，并在开发模式下添加调试头部。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {import('../entities').ProxyResponse} 处理后的响应对象。
 */
function postOptimizeHeadersHandler(upstream, proxyResponse) {
  try {
    const headers = proxyResponse.headers;
    const contentType = headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      headers['cache-control'] = 'public, max-age=300';
    } else if (contentType.includes('application/javascript') || contentType.includes('text/css')) {
      headers['cache-control'] = 'public, max-age=86400';
    } else if (contentType.includes('image/')) {
      headers['cache-control'] = 'public, max-age=604800';
    }
    if (process.env.NODE_ENV === 'development') {
      headers['x-gproxy-version'] = process.env.npm_package_version || '2.1.0'; // Use package version
      headers['x-gproxy-processed'] = new Date().toISOString();
    }
    // proxyResponse.headers is already a reference to headers, so modification is direct.
    return proxyResponse;
  } catch (error) {
    logger.error('postOptimizeHeadersHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`postOptimizeHeadersHandler 失败: ${error.message}`, 'postOptimizeHeadersHandler', error);
  }
}

/**
 * 智能错误页面后置处理器。
 * 如果响应是错误状态码且为简单HTML页面，则替换为自定义的、更友好的错误页面。
 * @param {import('../entities').Upstream} upstream 上游服务器信息对象。
 * @param {import('../entities').ProxyResponse} proxyResponse 代理响应对象。
 * @returns {import('../entities').ProxyResponse} 处理后的响应对象。
 */
function postErrorPageHandler(upstream, proxyResponse) {
  try {
    if (proxyResponse.statusCode < 400) return proxyResponse;
    const contentType = proxyResponse.headers['content-type'] || '';
    if (!contentType.includes('text/html')) return proxyResponse;
    let currentContent = Buffer.isBuffer(proxyResponse.content) 
      ? proxyResponse.content.toString('utf-8')
      : proxyResponse.content.toString();
    if (currentContent.length < 500 || !currentContent.toLowerCase().includes('<html')) {
      const requestPath = proxyResponse.proxyRequest?.urlNoSite || '/';
      const enhancedErrorPageHtml = _generateProxyErrorPageHtml(proxyResponse.statusCode, upstream.site, requestPath);
      proxyResponse.content = Buffer.from(enhancedErrorPageHtml, 'utf-8');
      proxyResponse.headers['content-type'] = 'text/html; charset=utf-8';
      proxyResponse.headers['content-length'] = proxyResponse.content.length.toString();
      logger.debug('已生成自定义错误页面', { statusCode: proxyResponse.statusCode });
    }
    return proxyResponse;
  } catch (error) {
    logger.error('postErrorPageHandler 执行失败:', { error: error.message, stack: error.stack });
    throw new HandlerError(`postErrorPageHandler 失败: ${error.message}`, 'postErrorPageHandler', error);
  }
}

/**
 * @private
 * Generates HTML for a custom proxy error page.
 */
function _generateProxyErrorPageHtml(statusCode, upstreamSite, requestPath) {
  const friendlyMessage = getErrorMessage(statusCode);
  const serverVersion = process.env.npm_package_version || '2.1.0'; // Try to get version from package.json

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>代理错误 ${statusCode}</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { background: white; border-radius: 10px; padding: 40px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 600px; text-align: center; }
        .error-code { font-size: 4em; font-weight: bold; color: #e74c3c; margin-bottom: 20px; }
        .error-message { font-size: 1.2em; margin-bottom: 30px; color: #555; }
        .details { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: left; font-family: monospace; word-break: break-all; }
        .retry-btn { background: #3498db; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 1em; margin: 10px; transition: background 0.3s; }
        .retry-btn:hover { background: #2980b9; }
        .footer { margin-top: 30px; color: #7f8c8d; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-code">${statusCode}</div>
        <div class="error-message">${friendlyMessage}</div>
        <div class="details">
            <strong>请求地址:</strong> ${upstreamSite}${requestPath || '/'}<br>
            <strong>代理服务器:</strong> Gproxy-Node v${serverVersion}<br>
            <strong>时间:</strong> ${new Date().toLocaleString('zh-CN')}
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
  detectContentType
}; 