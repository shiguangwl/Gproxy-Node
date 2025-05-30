const UserAgent = require('user-agents');
const randomUserAgent = require('random-useragent');

/**
 * 浏览器指纹伪装管理器
 */
class BrowserFingerprint {
  constructor() {
    this.userAgentGenerator = new UserAgent();
    this.currentFingerprint = null;
    this.fingerprintCache = new Map();
  }

  /**
   * 生成完整的浏览器指纹
   */
  generateFingerprint(domain = null) {
    // 如果已经为该域名生成过指纹，复用它
    if (domain && this.fingerprintCache.has(domain)) {
      return this.fingerprintCache.get(domain);
    }

    const userAgent = this.generateUserAgent();
    const fingerprint = {
      userAgent: userAgent,
      ...this.parseUserAgent(userAgent),
      headers: this.generateHeaders(userAgent),
      tlsSettings: this.generateTLSSettings(),
      behaviorPattern: this.generateBehaviorPattern()
    };

    // 缓存指纹
    if (domain) {
      this.fingerprintCache.set(domain, fingerprint);
    }

    this.currentFingerprint = fingerprint;
    return fingerprint;
  }

  /**
   * 生成用户代理字符串
   */
  generateUserAgent() {
    // 80% 使用Chrome，15% 使用Edge，5% 使用Firefox
    const random = Math.random();
    
    if (random < 0.8) {
      return this.generateChromeUserAgent();
    } else if (random < 0.95) {
      return this.generateEdgeUserAgent();
    } else {
      return this.generateFirefoxUserAgent();
    }
  }

  /**
   * 生成Chrome用户代理
   */
  generateChromeUserAgent() {
    const versions = [
      '120.0.0.0',
      '119.0.0.0', 
      '118.0.0.0',
      '117.0.0.0',
      '116.0.0.0'
    ];
    
    const platforms = [
      'Windows NT 10.0; Win64; x64',
      'Windows NT 11.0; Win64; x64',
      'Macintosh; Intel Mac OS X 10_15_7',
      'X11; Linux x86_64'
    ];

    const version = versions[Math.floor(Math.random() * versions.length)];
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  /**
   * 生成Edge用户代理
   */
  generateEdgeUserAgent() {
    const versions = [
      '120.0.0.0',
      '119.0.0.0',
      '118.0.0.0'
    ];
    
    const version = versions[Math.floor(Math.random() * versions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 Edg/${version}`;
  }

  /**
   * 生成Firefox用户代理
   */
  generateFirefoxUserAgent() {
    const versions = [
      '121.0',
      '120.0',
      '119.0',
      '118.0'
    ];
    
    const version = versions[Math.floor(Math.random() * versions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`;
  }

  /**
   * 解析用户代理字符串
   */
  parseUserAgent(userAgent) {
    const isChrome = userAgent.includes('Chrome') && !userAgent.includes('Edg');
    const isEdge = userAgent.includes('Edg');
    const isFirefox = userAgent.includes('Firefox');
    const isWindows = userAgent.includes('Windows');
    const isMac = userAgent.includes('Macintosh');
    const isLinux = userAgent.includes('Linux');

    let browser = 'Chrome';
    if (isEdge) browser = 'Edge';
    else if (isFirefox) browser = 'Firefox';

    let os = 'Windows';
    if (isMac) os = 'macOS';
    else if (isLinux) os = 'Linux';

    let version = '120';
    const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
    const firefoxMatch = userAgent.match(/Firefox\/(\d+)/);
    const edgeMatch = userAgent.match(/Edg\/(\d+)/);
    
    if (chromeMatch) version = chromeMatch[1];
    else if (firefoxMatch) version = firefoxMatch[1];
    else if (edgeMatch) version = edgeMatch[1];

    return {
      browser,
      version,
      os,
      isChrome,
      isEdge,
      isFirefox,
      isWindows,
      isMac,
      isLinux
    };
  }

  /**
   * 生成完整的HTTP头部
   */
  generateHeaders(userAgent) {
    const parsed = this.parseUserAgent(userAgent);
    const headers = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': this.generateAcceptLanguage(),
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1'
    };

    // Chrome/Edge 特定头部
    if (parsed.isChrome || parsed.isEdge) {
      const brand = parsed.isEdge ? 'Microsoft Edge' : 'Google Chrome';
      const brandVersion = parsed.version;
      
      headers['Sec-Ch-Ua'] = `"${brand}";v="${brandVersion}", "Chromium";v="${brandVersion}", "Not_A Brand";v="8"`;
      headers['Sec-Ch-Ua-Mobile'] = '?0';
      headers['Sec-Ch-Ua-Platform'] = parsed.isWindows ? '"Windows"' : 
                                      parsed.isMac ? '"macOS"' : '"Linux"';
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
    }

    // Firefox 特定头部
    if (parsed.isFirefox) {
      headers['DNT'] = '1';
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
   * 生成TLS设置
   */
  generateTLSSettings() {
    return {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384'
      ],
      curves: ['X25519', 'prime256v1', 'secp384r1'],
      signatureAlgorithms: [
        'ecdsa_secp256r1_sha256',
        'rsa_pss_rsae_sha256',
        'rsa_pkcs1_sha256',
        'ecdsa_secp384r1_sha384',
        'rsa_pss_rsae_sha384',
        'rsa_pkcs1_sha384'
      ]
    };
  }

  /**
   * 生成行为模式
   */
  generateBehaviorPattern() {
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