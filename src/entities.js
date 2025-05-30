const { URL } = require('url');

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
      throw new Error(`无效的上游URL: ${url}`);
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
    return decodeURIComponent(atob(encodedStr).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
  } catch (error) {
    // 如果Base64解码失败，尝试URL解码
    try {
      return decodeURIComponent(encodedStr);
    } catch (decodeError) {
      // 如果都失败了，返回原字符串
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
    
    // 只允许HTTP和HTTPS协议
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }
    
    // 防止访问本地地址
    const hostname = parsedUrl.hostname.toLowerCase();
    const localAddresses = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '169.254.', // 链路本地地址
      '10.',      // 私有网络
      '172.16.',  // 私有网络
      '192.168.', // 私有网络
    ];
    
    if (localAddresses.some(addr => hostname.includes(addr))) {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
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
    
    // 处理请求体
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        proxyRequest.data = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        proxyRequest.data = req.body;
      } else {
        proxyRequest.data = JSON.stringify(req.body);
      }
    } else {
      proxyRequest.data = null;
    }
    
    // 计算顶级域名
    const hostParts = proxyRequest.host.split('.');
    if (hostParts.length > 2) {
      proxyRequest.hostTop = hostParts.slice(-2).join('.');
    } else {
      proxyRequest.hostTop = proxyRequest.host;
    }
    
  } catch (error) {
    throw new Error(`请求转换失败: ${error.message}`);
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
      throw new Error('无效的全局代理URL格式');
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
      throw new Error(`无效的目标URL: ${targetUrl}`);
    }
    
    // 解析目标URL以获取路径信息
    const targetUrlObj = new URL(targetUrl);
    proxyRequest.urlNoSite = targetUrlObj.pathname + targetUrlObj.search + targetUrlObj.hash;
    proxyRequest.path = targetUrlObj.pathname;
    proxyRequest.query = targetUrlObj.search;
    
    // 处理请求体
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        proxyRequest.data = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        proxyRequest.data = req.body;
      } else {
        proxyRequest.data = JSON.stringify(req.body);
      }
    } else {
      proxyRequest.data = null;
    }
    
    // 计算顶级域名
    const hostParts = proxyRequest.host.split('.');
    if (hostParts.length > 2) {
      proxyRequest.hostTop = hostParts.slice(-2).join('.');
    } else {
      proxyRequest.hostTop = proxyRequest.host;
    }
    
  } catch (error) {
    throw new Error(`代理请求转换失败: ${error.message}`);
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
      throw new Error('无效的全局代理URL格式');
    }
    
    const encodedTargetUrl = pathParts[1];
    const targetUrl = safeBase64Decode(encodedTargetUrl);
    
    if (!isValidUrl(targetUrl)) {
      throw new Error(`无效的目标URL: ${targetUrl}`);
    }
    
    const targetUrlObj = new URL(targetUrl);
    return `${targetUrlObj.protocol}//${targetUrlObj.host}`;
    
  } catch (error) {
    throw new Error(`提取目标站点失败: ${error.message}`);
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