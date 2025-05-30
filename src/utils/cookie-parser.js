const { Cookie, CookieJar } = require('tough-cookie');

class CookieManager {
  constructor() {
    this.jar = new CookieJar();
  }

  /**
   * 解析响应中的Set-Cookie头部
   * @param {Array} setCookieHeaders - Set-Cookie头部数组
   * @param {string} upstreamUrl - 上游URL
   * @param {string} proxyUrl - 代理URL
   * @returns {Array} 转换后的Set-Cookie头部
   */
  parseAndConvertSetCookies(setCookieHeaders, upstreamUrl, proxyUrl) {
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
      return [];
    }

    const upstreamDomain = new URL(upstreamUrl).hostname;
    const proxyDomain = new URL(proxyUrl).hostname;
    const convertedCookies = [];

    setCookieHeaders.forEach(cookieStr => {
      try {
        const cookie = Cookie.parse(cookieStr);
        if (cookie) {
          // 转换域名
          if (cookie.domain) {
            if (cookie.domain === upstreamDomain || cookie.domain === `.${upstreamDomain}`) {
              cookie.domain = proxyDomain;
            } else if (cookie.domain.endsWith(upstreamDomain)) {
              cookie.domain = cookie.domain.replace(upstreamDomain, proxyDomain);
            }
          } else {
            // 如果没有明确的域名，设置为代理域名
            cookie.domain = proxyDomain;
          }

          // 确保cookie适用于代理域名
          cookie.hostOnly = false;
          
          // 移除secure标志(如果代理服务器不是HTTPS)
          const proxyIsHttps = proxyUrl.startsWith('https://');
          if (!proxyIsHttps && cookie.secure) {
            cookie.secure = false;
          }

          convertedCookies.push(cookie.toString());
        }
      } catch (error) {
        console.warn('解析Cookie失败:', error.message);
        // 如果解析失败，尝试简单的字符串替换
        const convertedCookieStr = cookieStr.replace(
          new RegExp(`domain=${upstreamDomain}`, 'gi'),
          `domain=${proxyDomain}`
        );
        convertedCookies.push(convertedCookieStr);
      }
    });

    return convertedCookies;
  }

  /**
   * 转换请求中的Cookie头部
   * @param {string} cookieHeader - Cookie头部字符串
   * @param {string} proxyUrl - 代理URL
   * @param {string} upstreamUrl - 上游URL
   * @returns {string} 转换后的Cookie字符串
   */
  convertRequestCookies(cookieHeader, proxyUrl, upstreamUrl) {
    if (!cookieHeader) {
      return '';
    }

    // 简单的域名替换，实际应用中可能需要更复杂的逻辑
    const proxyDomain = new URL(proxyUrl).hostname;
    const upstreamDomain = new URL(upstreamUrl).hostname;
    
    return cookieHeader.replace(
      new RegExp(proxyDomain, 'g'),
      upstreamDomain
    );
  }

  /**
   * 检查Cookie是否应该被发送到指定的URL
   * @param {string} cookieStr - Cookie字符串
   * @param {string} url - 目标URL
   * @returns {boolean} 是否应该发送
   */
  shouldSendCookie(cookieStr, url) {
    try {
      const cookie = Cookie.parse(cookieStr);
      if (!cookie) return false;

      const urlObj = new URL(url);
      
      // 检查域名匹配
      if (cookie.domain) {
        const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        if (!urlObj.hostname.endsWith(domain)) {
          return false;
        }
      }

      // 检查路径匹配
      if (cookie.path && !urlObj.pathname.startsWith(cookie.path)) {
        return false;
      }

      // 检查HTTPS
      if (cookie.secure && urlObj.protocol !== 'https:') {
        return false;
      }

      // 检查过期时间
      if (cookie.expires && cookie.expires < new Date()) {
        return false;
      }

      return true;
    } catch (error) {
      console.warn('检查Cookie有效性失败:', error.message);
      return true; // 默认允许发送
    }
  }
}

module.exports = CookieManager; 