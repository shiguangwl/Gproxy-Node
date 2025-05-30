const UserAgent = require('user-agents');
// const randomUserAgent = require('random-useragent'); // 移除未使用的库

/**
 * 浏览器指纹伪装管理器
 */
class BrowserFingerprint {
  constructor() {
    // Configure user-agents for more control if needed, e.g., only desktops
    this.userAgentGenerator = new UserAgent({ deviceCategory: 'desktop' }); 
    this.currentFingerprint = null;
    this.fingerprintCache = new Map();
  }

  /**
   * 生成完整的浏览器指纹
   */
  generateFingerprint(domain = null) {
    if (domain && this.fingerprintCache.has(domain)) {
      return this.fingerprintCache.get(domain);
    }

    // const userAgentString = this.generateUserAgent(); // 旧方法
    const uaInstance = this.userAgentGenerator.random(); // 使用库生成UA对象
    const userAgentString = uaInstance.toString();
    const parsedUA = uaInstance.data; // 使用库的解析结果

    const fingerprint = {
      userAgent: userAgentString,
      parsedUA: parsedUA, // Store parsed data from the library
      // ...this.parseUserAgent(userAgentString), // 不再需要手动解析
      headers: this.generateHeaders(userAgentString, parsedUA),
      // tlsSettings: this.generateTLSSettings(), // 它的实际作用有限，暂时注释
      behaviorPattern: this.generateBehaviorPattern(parsedUA)
    };

    if (domain) {
      this.fingerprintCache.set(domain, fingerprint);
    }
    this.currentFingerprint = fingerprint;
    return fingerprint;
  }

  /**
   * 生成用户代理字符串 (此方法将被库替代，但保留概念或移除)
   * @deprecated Prefer using this.userAgentGenerator.random()
   */
  // generateUserAgent() { ... } // 移除旧的系列 UA 生成函数
  // generateChromeUserAgent() { ... }
  // generateEdgeUserAgent() { ... }
  // generateFirefoxUserAgent() { ... }

  /**
   * 解析用户代理字符串 (此方法将被库替代)
   * @deprecated Prefer using the .data property from user-agents instance
   */
  // parseUserAgent(userAgent) { ... } // 移除旧的解析函数

  /**
   * 生成完整的HTTP头部
   * @param {string} userAgentString - The User-Agent string
   * @param {object} parsedUA - Parsed UA data from user-agents library
   */
  generateHeaders(userAgentString, parsedUA) {
    const headers = {
      'User-Agent': userAgentString,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': this.generateAcceptLanguage(),
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1'
    };

    // Sec-CH-UA headers based on parsedUA data
    // Note: user-agents library provides `ब्रांड` (brand) in devanagari script for " Not A;Brand " sometimes.
    // We need to be careful or use a more specific way to get brand info if available.
    const browserName = parsedUA.browser || 'Chrome'; // Default to Chrome if not specified
    const browserVersion = parsedUA.version || (parsedUA.browserVersion || '120'); // Use .version or .browserVersion
    const platformName = parsedUA.platform || 'Windows'; // e.g. "Windows", "macOS", "Linux"

    // Construct Sec-CH-UA based on browser
    // This is a simplified construction. Real browsers have more complex rules.
    let secChUa = '';
    if (browserName.toLowerCase().includes('chrome')) {
      secChUa = `"Google Chrome";v="${browserVersion}", "Chromium";v="${browserVersion}", "Not_A Brand";v="8"`;
    } else if (browserName.toLowerCase().includes('edge')) {
      secChUa = `"Microsoft Edge";v="${browserVersion}", "Chromium";v="${browserVersion}", "Not_A Brand";v="8"`;
    } else if (browserName.toLowerCase().includes('firefox')) {
      // Firefox doesn't typically send Sec-CH-UA by default in the same way, but some experiments exist.
      // For now, we don't add it for Firefox to mimic default behavior.
    } else {
      // Fallback for other browsers or if info is missing
      secChUa = `"Chromium";v="${browserVersion}", "Not_A Brand";v="8"`; 
    }
    
    if (secChUa) headers['Sec-Ch-Ua'] = secChUa;
    headers['Sec-Ch-Ua-Mobile'] = '?0'; // Assuming desktop from constructor
    headers['Sec-Ch-Ua-Platform'] = `"${platformName}"`;
    
    // Common sec-fetch headers (might vary slightly by browser/context)
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none'; // For initial navigation
    headers['Sec-Fetch-User'] = '?1';

    if (browserName.toLowerCase().includes('firefox')) {
      headers['DNT'] = '1'; // Common for Firefox
    }

    return headers;
  }

  /**
   * 生成Accept-Language头部
   */
  generateAcceptLanguage() {
    const languages = [
      'zh-CN,zh;q=0.9,en;q=0.8',
      'en-US,en;q=0.9',
      'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
      'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    ];
    
    return languages[Math.floor(Math.random() * languages.length)];
  }

  /**
   * 生成TLS设置 (Commented out as its practical application is limited in Node.js)
   */
  // generateTLSSettings() { ... }

  /**
   * 生成行为模式
   * @param {object} parsedUA - Parsed UA data from user-agents library (can be used to customize behavior)
   */
  generateBehaviorPattern(parsedUA) { // parsedUA can be used here if desired
    return {
      requestInterval: 100 + Math.random() * 200, // 100-300ms
      connectTimeout: 5000 + Math.random() * 5000, // 5-10s
      readTimeout: 10000 + Math.random() * 10000, // 10-20s
      retryDelay: 1000 + Math.random() * 2000, // 1-3s
      maxRedirects: 3 + Math.floor(Math.random() * 3), // 3-5
      jitter: 0.1 + Math.random() * 0.2 // 10-30% jitter
    };
  }

  /**
   * 获取当前指纹
   */
  getCurrentFingerprint() {
    return this.currentFingerprint || this.generateFingerprint();
  }

  /**
   * 更新请求头部以匹配指纹
   */
  applyFingerprint(headers, domain = null) {
    const fingerprint = domain ? 
      this.fingerprintCache.get(domain) || this.generateFingerprint(domain) :
      this.getCurrentFingerprint();

    // 合并指纹头部
    Object.assign(headers, fingerprint.headers);

    // 移除可能暴露代理的头部
    const removeHeaders = [
      'x-forwarded-for',
      'x-forwarded-host', 
      'x-forwarded-proto',
      'x-real-ip',
      'forwarded',
      'via',
      'x-gproxy-request-id',
      'x-gproxy-timestamp'
    ];

    removeHeaders.forEach(header => {
      delete headers[header.toLowerCase()];
    });

    return headers;
  }

  /**
   * 生成随机延迟
   */
  getRandomDelay() {
    const pattern = this.getCurrentFingerprint().behaviorPattern;
    const base = pattern.requestInterval;
    const jitter = base * pattern.jitter;
    return base + (Math.random() - 0.5) * 2 * jitter;
  }

  /**
   * 获取域名特定的指纹
   */
  getFingerprintForDomain(domain) {
    if (this.fingerprintCache.has(domain)) {
      return this.fingerprintCache.get(domain);
    }
    return this.generateFingerprint(domain);
  }

  /**
   * 清除指纹缓存
   */
  clearCache() {
    this.fingerprintCache.clear();
    this.currentFingerprint = null;
  }

  /**
   * 获取真实的Chrome TLS JA3指纹
   */
  getChromeTLSFingerprint() {
    // 真实Chrome 120 TLS指纹
    return {
      ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0',
      ja3Hash: 'cd08e31494f9531f560d64c695473da9',
      tlsVersion: '1.3',
      cipherSuites: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384', 
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256'
      ]
    };
  }
}

// 创建全局实例
const browserFingerprint = new BrowserFingerprint();

module.exports = browserFingerprint; 