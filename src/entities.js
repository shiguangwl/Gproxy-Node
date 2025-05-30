const { URL } = require('url');
const {
  InvalidUrlError,
  RequestConversionError
} = require('./utils/errors'); // 引入自定义错误
const net = require('net'); // 引入 net 模块

/**
 * 上游服务器信息类
 */
class Upstream {
  constructor(url) {
    try {
      const parsedUrl = new URL(url);
      // 原始url
      this.url = url;
      // 协议和域名
      this.site = `${parsedUrl.protocol}//${parsedUrl.host}`;
      // 路径
      this.path = parsedUrl.pathname;
      // 域名
      this.host = parsedUrl.host;
      // 协议
      this.protocol = parsedUrl.protocol;
      
      // 顶级域名
      const hostParts = this.host.split('.');
      if (hostParts.length > 2) {
        this.hostTop = hostParts.slice(-2).join('.');
      } else {
        this.hostTop = this.host;
      }
    } catch (error) {
      throw new InvalidUrlError(`无效的上游URL: ${url}`, error);
    }
  }
}

/**
 * 内容替换规则类
 */
class ReplaceItem {
  constructor({
    search,
    replace,
    matchType,
    urlMatch = null,
    urlExclude = null,
    contentType = null
  }) {
    this.search = search;
    this.replace = replace;
    this.matchType = matchType; // 1 为字符串匹配 2 为正则匹配
    this.urlMatch = urlMatch;
    this.urlExclude = urlExclude;
    this.contentType = contentType;
  }
}

/**
 * 代理请求信息类
 */
class ProxyRequest {
  constructor() {
    this.site = null;           // 原始请求域名
    this.host = null;           // host
    this.urlNoSite = null;      // url除去site部分
    this.method = null;         // 请求方式
    this.headers = {};          // 请求头
    this.cookies = null;        // 请求cookies
    this.path = null;           // 请求路径
    this.data = null;           // 请求数据
    this.hostTop = null;        // 顶级域名
    this.query = null;          // 查询参数
    this.originalUrl = null;    // 原始完整URL
  }
}

/**
 * 代理响应信息类
 */
class ProxyResponse {
  constructor(axiosResponse) {
    this.response = axiosResponse;
    this.content = axiosResponse.data;
    this.statusCode = axiosResponse.status;
    this.headers = axiosResponse.headers;
    this.isRedirect = axiosResponse.status >= 300 && axiosResponse.status < 400;
    
    // 解析响应URL
    try {
      const parsedUrl = new URL(axiosResponse.config.url);
      this.site = `${parsedUrl.protocol}//${parsedUrl.host}`;
    } catch (error) {
      this.site = null;
    }
    
    this.proxyRequest = null;
    this.contentType = this.headers['content-type'] || '';
  }
}

/**
 * 安全的Base64解码函数
 * @param {string} encodedStr Base64编码的字符串
 * @returns {string} 解码后的字符串
 */
function safeBase64Decode(encodedStr) {
  try {
    // Node.js: Decode Base64 to a UTF-8 string
    const decoded = Buffer.from(encodedStr, 'base64').toString('utf8');
    // The original function then did a complex decodeURIComponent. 
    // If the base64 content itself is a URL or URL component, it might already be correctly formed.
    // If it was further URL-encoded *before* base64, then decodeURIComponent might be needed.
    // For simplicity and common use cases (base64 encoded URL string), 
    // we will try to decode it as URI component if it looks like it might be encoded.
    // However, a simple direct return of the base64 decoded string is often what's needed.
    
    // Let's assume the base64 content is the actual string and doesn't need further URI decoding by default.
    // If specific parts *within* the decoded string are URI encoded, they should be handled contexto-dependently.
    // The original function's multi-step decoding was quite specific.
    // Let's try a direct decode, and then a URI decode as a fallback for the original's intent.
    try {
        // Attempt to decode as URI component, in case the base64 content was URL encoded.
        // This mimics one path of the original function.
        return decodeURIComponent(decoded);
    } catch (uriError) {
        // If URI decoding fails, it means 'decoded' was likely not URL-encoded, so return it directly.
        return decoded; 
    }

  } catch (error) {
    // Fallback: if Base64 decoding itself fails, try to decode the original string as a URI component.
    // This was the second fallback in the original function.
    try {
      return decodeURIComponent(encodedStr);
    } catch (decodeError) {
      // If all fails, return the original string.
      return encodedStr;
    }
  }
}

/**
 * 验证URL是否合法且安全
 * @param {string} url 要验证的URL
 * @returns {boolean} 是否合法
 */
function isValidUrl(url) {
  try {
    const parsedUrl = new URL(url);
    
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }
    
    const hostname = parsedUrl.hostname.toLowerCase();

    // 检查是否为IP地址
    const ipVersion = net.isIP(hostname);

    if (ipVersion) {
      // IPv4 私有地址和保留地址范围
      // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      // 127.0.0.0/8 (loopback)
      // 169.254.0.0/16 (link-local)
      // 0.0.0.0 (any)
      const ipv4PrivateRanges = [
        /^10\.(\d{1,3}\.){2}\d{1,3}$/,
        /^172\.(1[6-9]|2\d|3[01])\.(\d{1,3}\.){1}\d{1,3}$/,
        /^192\.168\.\d{1,3}\.\d{1,3}$/,
        /^127\.(\d{1,3}\.){2}\d{1,3}$/,
        /^169\.254\.(\d{1,3}\.){1}\d{1,3}$/,
        /^0\.0\.0\.0$/
      ];
      if (ipVersion === 4 && ipv4PrivateRanges.some(range => range.test(hostname))) {
        return false;
      }

      // IPv6 私有地址和保留地址范围
      // ::1 (loopback)
      // fc00::/7 (unique local)
      // fe80::/10 (link-local)
      const ipv6PrivatePatterns = [
        /^::1$/,
        /^[fF][cC0-9a-fA-F]{2}:/ , // ULA fc00::/7
        /^[fF][eE][89aAbB][0-9a-fA-F]:/ // Link-local fe80::/10
      ];
      if (ipVersion === 6 && ipv6PrivatePatterns.some(pattern => pattern.test(hostname))) {
        return false;
      }
    } else {
      // 如果不是IP地址，检查是否是 localhost
      if (hostname === 'localhost') {
        return false;
      }
      // 可以在这里添加其他基于名称的黑名单，如果需要
    }
    
    // 可以在这里添加端口校验逻辑，例如：
    // if (parsedUrl.port && parseInt(parsedUrl.port, 10) < 1024 && parseInt(parsedUrl.port, 10) !== 80 && parseInt(parsedUrl.port, 10) !== 443) {
    //   logger.warn('URL validation: Attempt to connect to a privileged port', { port: parsedUrl.port });
    //   return false;
    // }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * @private
 * Populates proxyRequest.data based on req.body
 */
function _populateRequestData(proxyRequest, req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      proxyRequest.data = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      proxyRequest.data = req.body;
    } else if (typeof req.body === 'object' && req.body !== null) {
      try {
        proxyRequest.data = JSON.stringify(req.body);
      } catch (stringifyError) {
        // logger.warn('Failed to stringify non-buffer/non-string req.body', stringifyError);
        proxyRequest.data = null; // Or handle as an error
      }
    } else {
      proxyRequest.data = null;
    }
  } else {
    proxyRequest.data = null;
  }
}

/**
 * @private
 * Populates proxyRequest.hostTop based on proxyRequest.host
 */
function _populateHostTop(proxyRequest) {
  if (proxyRequest.host) {
    const hostParts = proxyRequest.host.split('.');
    if (hostParts.length > 2) {
        // Heuristic for TLD, might not be perfect for ccSLDs like .co.uk
        // Consider using a more robust TLD library if precision is critical
        const potentialCcSLD = hostParts.slice(-2).join('.');
        const commonCcSLDs = ['co.uk', 'com.cn', 'org.uk', 'gov.uk', 'ac.uk', /* add more as needed */];
        if (commonCcSLDs.includes(potentialCcSLD) && hostParts.length > 3) {
            proxyRequest.hostTop = hostParts.slice(-3).join('.');
        } else {
            proxyRequest.hostTop = potentialCcSLD;
        }
    } else {
      proxyRequest.hostTop = proxyRequest.host;
    }
  } else {
    proxyRequest.hostTop = null;
  }
}

/**
 * 将Express请求转换为ProxyRequest对象（基本模式）
 * @param {Request} req Express请求对象
 * @returns {ProxyRequest} 代理请求对象
 */
function requestBaseConvert(req) {
  const proxyRequest = new ProxyRequest();
  
  try {
    const parsedUrl = new URL(req.url, `${req.protocol}://${req.get('host')}`);
    
    proxyRequest.site = `${parsedUrl.protocol}//${parsedUrl.host}`;
    proxyRequest.host = parsedUrl.host;
    proxyRequest.urlNoSite = parsedUrl.pathname + parsedUrl.search;
    proxyRequest.method = req.method;
    proxyRequest.headers = { ...req.headers };
    proxyRequest.cookies = req.headers.cookie || '';
    proxyRequest.path = parsedUrl.pathname;
    proxyRequest.query = parsedUrl.search;
    proxyRequest.originalUrl = req.originalUrl;
    
    _populateRequestData(proxyRequest, req);
    _populateHostTop(proxyRequest);
    
  } catch (error) {
    throw new RequestConversionError(`基础请求转换失败: ${error.message}`, error);
  }
  
  return proxyRequest;
}

/**
 * 将Express请求转换为ProxyRequest对象（全局代理模式）
 * @param {Request} req Express请求对象
 * @param {string} globalProxyPath 全局代理路径
 * @returns {ProxyRequest} 代理请求对象
 */
function requestProxyConvert(req, globalProxyPath) {
  const proxyRequest = new ProxyRequest();
  
  try {
    const parsedUrl = new URL(req.url, `${req.protocol}://${req.get('host')}`);
    
    proxyRequest.site = `${parsedUrl.protocol}//${parsedUrl.host}`;
    proxyRequest.host = parsedUrl.host;
    proxyRequest.method = req.method;
    proxyRequest.headers = { ...req.headers };
    proxyRequest.cookies = req.headers.cookie || '';
    proxyRequest.originalUrl = req.originalUrl;
    
    // 从全局代理URL中提取目标URL
    const pathParts = req.url.split(`/${globalProxyPath}/`);
    if (pathParts.length < 2) {
      throw new InvalidUrlError('无效的全局代理URL格式');
    }
    
    // 获取编码的目标URL部分
    const encodedTargetUrl = pathParts[1];
    
    // 尝试解码目标URL
    let targetUrl;
    try {
      // 首先尝试Base64解码
      targetUrl = safeBase64Decode(encodedTargetUrl);
    } catch (error) {
      // 如果Base64解码失败，尝试直接使用（向后兼容）
      targetUrl = decodeURIComponent(encodedTargetUrl);
    }
    
    // 验证解码后的URL
    if (!isValidUrl(targetUrl)) {
      throw new InvalidUrlError(`解码后目标URL无效或不安全: ${targetUrl}`);
    }
    
    // 解析目标URL以获取路径信息
    const targetUrlObj = new URL(targetUrl);
    proxyRequest.urlNoSite = targetUrlObj.pathname + targetUrlObj.search + targetUrlObj.hash;
    proxyRequest.path = targetUrlObj.pathname;
    proxyRequest.query = targetUrlObj.search;
    
    _populateRequestData(proxyRequest, req);
    _populateHostTop(proxyRequest);
    
  } catch (error) {
    if (error instanceof InvalidUrlError) throw error; // Re-throw if already specific
    throw new RequestConversionError(`全局代理请求转换失败: ${error.message}`, error);
  }
  
  return proxyRequest;
}

/**
 * 从全局代理URL中提取目标站点信息
 * @param {string} requestUrl 请求URL
 * @param {string} globalProxyPath 全局代理路径
 * @returns {string} 目标站点URL
 */
function extractTargetSiteFromProxyUrl(requestUrl, globalProxyPath) {
  try {
    const pathParts = requestUrl.split(`/${globalProxyPath}/`);
    if (pathParts.length < 2) {
      throw new InvalidUrlError('无效的全局代理URL格式以提取站点');
    }
    
    const encodedTargetUrl = pathParts[1];
    const targetUrl = safeBase64Decode(encodedTargetUrl);
    
    if (!isValidUrl(targetUrl)) {
      throw new InvalidUrlError(`从代理URL中提取的目标URL无效或不安全: ${targetUrl}`);
    }
    
    const targetUrlObj = new URL(targetUrl);
    return `${targetUrlObj.protocol}//${targetUrlObj.host}`;
    
  } catch (error) {
    if (error instanceof InvalidUrlError) throw error; // Re-throw
    throw new RequestConversionError(`提取目标站点URL失败: ${error.message}`, error);
  }
}

module.exports = {
  Upstream,
  ReplaceItem,
  ProxyRequest,
  ProxyResponse,
  requestBaseConvert,
  requestProxyConvert,
  extractTargetSiteFromProxyUrl,
  safeBase64Decode,
  isValidUrl
}; 