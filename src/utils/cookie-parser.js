const { Cookie, CookieJar } = require('tough-cookie');
const logger = require('./logger');

class CookieManager {
  constructor() {
    this.jar = new CookieJar(undefined, { // Use default MemoryStore
        allowSpecialUseDomain: true, 
        rejectPublicSuffixes: false, 
        looseMode: true 
    });
  }

  /**
   * Processes Set-Cookie headers received from an upstream server.
   * Stores cookies in the internal jar (associated with upstreamUrl)
   * and returns an array of modified Set-Cookie strings to be sent to the client via the proxy.
   *
   * @param {Array<string>|string} setCookieHeaders Headers from upstream.
   * @param {string} upstreamUrl URL from which cookies were received (current request's URL to upstream).
   * @param {string} proxyUrl URL the client is talking to (the proxy server's public URL for this request context).
   * @returns {Array<string>} Modified Set-Cookie strings for the client.
   */
  handleSetCookieFromUpstream(setCookieHeaders, upstreamUrl, proxyUrl) {
    if (!setCookieHeaders) return [];
    const headersArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    if (headersArray.length === 0) return [];

    const proxyHost = new URL(proxyUrl).hostname;
    const proxyIsHttp = new URL(proxyUrl).protocol === 'http:';
    const modifiedClientCookieStrings = [];

    headersArray.forEach(cookieStr => {
      try {
        // Store the original cookie from upstream into our jar.
        // The jar associates it with upstreamUrl (tough-cookie handles domain/path from cookie string).
        this.jar.setCookieSync(cookieStr, upstreamUrl, { ignoreError: false, loose: true });

        // Now, create a version of this cookie to send to the client,
        // as if the proxy server (proxyUrl) is setting it.
        let clientCookie = Cookie.parse(cookieStr, { loose: true });
        if (!clientCookie) {
            logger.warn('无法解析Set-Cookie字符串，跳过客户端转换:', { cookieStr });
            // modifiedClientCookieStrings.push(cookieStr); // Optionally pass original if critical
            return; 
        }

        // 1. Domain: Change to proxy's domain for the cookie being sent to the client.
        clientCookie.domain = proxyHost;
        // When domain is explicitly set, hostOnly should typically be false.
        // tough-cookie usually handles this if domain starts with a dot, or infers.
        // Let's be explicit if we set domain like this.
        clientCookie.hostOnly = false; 

        // 2. Secure attribute: Remove if proxy is HTTP, as client won't send it back.
        if (proxyIsHttp && clientCookie.secure) {
          clientCookie.secure = false;
        }

        // 3. SameSite attribute adjustment for client-facing cookie
        let sameSiteValue = clientCookie.sameSite ? clientCookie.sameSite.toLowerCase() : 'lax'; // Default to lax

        if (proxyIsHttp && sameSiteValue === 'none') {
          sameSiteValue = 'lax'; // SameSite=None is invalid over HTTP
        }
        // If proxy is HTTPS and original cookie was SameSite=None but NOT Secure, 
        // then this combination is problematic. Change to Lax.
        if (!proxyIsHttp && sameSiteValue === 'none' && !clientCookie.secure) {
          sameSiteValue = 'lax';
          logger.debug('将SameSite=None改为Lax，因为在HTTPS代理上Secure属性为false/缺失', { name: clientCookie.key });
        }
        clientCookie.sameSite = sameSiteValue;
        
        // Path, HttpOnly, Expires, Max-Age are generally kept as is from original cookie.
        // Path will be interpreted by the client relative to the (new) domain (proxyHost).

        modifiedClientCookieStrings.push(clientCookie.toString());

      } catch (error) {
        logger.warn('处理Set-Cookie头为客户端时出错:', { cookie: cookieStr, error: error.message, stack: error.stack });
        // Fallback can be to push the original string, but it might have wrong domain for client
        // For now, if parsing/conversion fails badly, we skip sending this cookie to client.
      }
    });
    return modifiedClientCookieStrings;
  }

  /**
   * Gets the Cookie header string to be sent to an upstream server.
   * Retrieves cookies from the internal jar that match the upstreamUrl.
   *
   * @param {string} upstreamUrl URL the request is being sent to.
   * @returns {string} Cookie header string, or empty string if no suitable cookies.
   */
  getCookiesForUpstream(upstreamUrl) {
    try {
      const cookies = this.jar.getCookieStringSync(upstreamUrl, { http: true }); 
      logger.debug('为上游获取到的Cookies:', { upstreamUrl, count: cookies ? cookies.split(';').length : 0 });
      return cookies || '';
    } catch (error) {
      logger.error('从Jar中为上游获取Cookies失败:', { upstreamUrl, error: error.message });
      return '';
    }
  }

  /**
   * (Optional) Clears all cookies from the jar. Useful for testing or session reset.
   */
  clearAllCookies() {
    this.jar = new CookieJar(undefined, { 
        allowSpecialUseDomain: true, 
        rejectPublicSuffixes: false, 
        looseMode: true 
    });
    logger.info('Cookie管理器中的所有Cookie已被清除。');
  }
}

module.exports = CookieManager; 