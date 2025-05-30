const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./logger');

// 添加隐身插件
puppeteer.use(StealthPlugin());

/**
 * Cloudflare 验证处理器
 */
class CloudflareHandler {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || 30000,
      headless: options.headless !== false,
      maxRetries: options.maxRetries || 3,
      challengeTimeout: options.challengeTimeout || 10000,
      userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...options
    };
    
    this.browser = null;
    this.sessionCookies = new Map(); // 存储会话Cookie
  }

  /**
   * 初始化浏览器
   */
  async initBrowser() {
    if (this.browser) {
      return this.browser;
    }

    try {
      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-features=VizDisplayCompositor',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection',
          '--enable-features=NetworkService,NetworkServiceLogging',
          '--user-agent=' + this.options.userAgent
        ],
        defaultViewport: {
          width: 1920,
          height: 1080
        }
      });

      logger.info('Cloudflare处理器浏览器初始化成功');
      return this.browser;
    } catch (error) {
      logger.error('浏览器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 使用浏览器绕过 Cloudflare 验证
   * @param {string} url - The URL to bypass
   * @param {object} [fingerprintData=null] - Optional fingerprint data (userAgent, headers) to use
   */
  async bypassCloudflare(url, fingerprintData = null) {
    let page = null;
    let attempt = 0;

    const userAgentToUse = fingerprintData?.userAgent || this.options.userAgent;
    const headersToSet = fingerprintData?.headers || {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 'Accept-Encoding': 'gzip, deflate, br', // Puppeteer handles this
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': fingerprintData?.headers?.['sec-ch-ua'] || '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': fingerprintData?.headers?.['sec-ch-ua-mobile'] || '?0',
        'Sec-Ch-Ua-Platform': fingerprintData?.headers?.['sec-ch-ua-platform'] || '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };

    // Ensure User-Agent in headersToSet matches userAgentToUse
    headersToSet['User-Agent'] = userAgentToUse;

    // Update browser launch args if a specific UA is passed via fingerprint
    const launchOptions = { ...this.options };
    if (fingerprintData?.userAgent && launchOptions.args) {
        const uaArgIndex = launchOptions.args.findIndex(arg => arg.startsWith('--user-agent='));
        if (uaArgIndex !== -1) {
            launchOptions.args[uaArgIndex] = '--user-agent=' + userAgentToUse;
        } else {
            launchOptions.args.push('--user-agent=' + userAgentToUse);
        }
    }

    while (attempt < launchOptions.maxRetries) { // Use potentially updated maxRetries
      try {
        // Pass potentially updated launchOptions to initBrowser if it can take them,
        // or re-initialize browser if UA has changed significantly.
        // For now, assume initBrowser uses the constructor options or a new UA needs new browser.
        // If UA is different from constructor, we might need to close and relaunch.
        // This part is tricky with a shared browser instance.
        // A simpler approach for now: page.setUserAgent overrides effectively.
        const browser = await this.initBrowser(); // Consider passing launchOptions if UA changes
        page = await browser.newPage();

        await page.setUserAgent(userAgentToUse);
        await page.setExtraHTTPHeaders(headersToSet);

        // 还原之前的会话Cookie（如果有）
        const hostname = new URL(url).hostname;
        if (this.sessionCookies.has(hostname)) {
          const cookies = this.sessionCookies.get(hostname);
          for (const cookie of cookies) {
            await page.setCookie(cookie);
          }
        }

        logger.info(`尝试访问Cloudflare保护的页面: ${url} (尝试 ${attempt + 1})`);

        // 导航到页面
        const response = await page.goto(url, { 
          waitUntil: 'networkidle2', 
          timeout: this.options.timeout 
        });

        // 等待可能的Cloudflare挑战完成
        await this.waitForCloudflareClearance(page);

        // 获取最终的Cookie
        const finalCookies = await page.cookies();
        this.sessionCookies.set(hostname, finalCookies);

        // 获取最终页面内容
        const content = await page.content();
        const finalUrl = page.url();

        logger.info('Cloudflare验证绕过成功', {
          originalUrl: url,
          finalUrl: finalUrl,
          cookieCount: finalCookies.length,
          usedUserAgent: userAgentToUse
        });

        await page.close();

        return {
          success: true,
          content: content,
          url: finalUrl,
          cookies: finalCookies,
          headers: response.headers()
        };

      } catch (error) {
        logger.warn(`Cloudflare绕过尝试 ${attempt + 1} 失败:`, error.message);
        
        if (page) {
          await page.close().catch(() => {});
        }

        attempt++;
        
        if (attempt < launchOptions.maxRetries) {
          await this.sleep(2000 * attempt); // 递增延迟
        }
      }
    }

    throw new Error(`Cloudflare验证绕过失败，已尝试 ${launchOptions.maxRetries} 次`);
  }

  /**
   * 等待Cloudflare验证完成
   */
  async waitForCloudflareClearance(page) {
    try {
      logger.debug('等待Cloudflare验证挑战...');
      // Option 1: Wait for navigation that might set the cookie or specific response
      // await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: this.options.challengeTimeout });

      // Option 2: Wait for specific text to disappear AND/OR cf_clearance cookie
      await page.waitForFunction(() => {
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const cloudflareTexts = [
          'checking your browser',
          'ddos protection',
          'please wait',
          'just a moment',
          'enable javascript and cookies' // Common on some CF pages
        ];
        const challengeTextFound = cloudflareTexts.some(text => bodyText.includes(text));
        
        const cookies = document.cookie || '';
        const hasClearanceCookie = /cf_clearance=[^;]+/.test(cookies);
        
        return hasClearanceCookie || !challengeTextFound;
      }, { timeout: this.options.challengeTimeout });

      // 额外等待确保所有脚本执行完毕和Cookie设置
      await this.sleep(2500); // Increased slightly

      // Double check for cf_clearance cookie after waiting
      const finalPageCookies = await page.cookies();
      if (this.hasClearanceCookie(finalPageCookies)) {
        logger.info('Cloudflare cf_clearance Cookie已找到。');
      } else {
        logger.warn('等待后未找到Cloudflare cf_clearance Cookie，可能验证未完全成功。');
      }

    } catch (error) {
      logger.warn('等待Cloudflare验证超时或发生错误:', error.message);
      // 不抛出错误，继续执行，后续的cookie和内容获取可能会失败或获取到质询页面
    }
  }

  /**
   * 获取存储的会话Cookie
   */
  getSessionCookies(hostname) {
    return this.sessionCookies.get(hostname) || [];
  }

  /**
   * 清除会话Cookie
   */
  clearSessionCookies(hostname = null) {
    if (hostname) {
      this.sessionCookies.delete(hostname);
    } else {
      this.sessionCookies.clear();
    }
  }

  /**
   * 关闭浏览器
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Cloudflare处理器浏览器已关闭');
    }
  }

  /**
   * 睡眠函数
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 格式化Cookie为HTTP头部格式
   */
  formatCookiesForRequest(cookies) {
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /**
   * 检查Cookie是否包含Cloudflare清除标识
   */
  hasClearanceCookie(cookies) {
    return cookies.some(cookie => 
      cookie.name.includes('cf_clearance') || 
      cookie.name.includes('__cfduid') ||
      cookie.name.includes('cf_bm')
    );
  }
}

// 创建全局实例
const cloudflareHandler = new CloudflareHandler({
  headless: process.env.CF_HEADLESS !== 'false',
  timeout: parseInt(process.env.CF_TIMEOUT) || 30000,
  maxRetries: parseInt(process.env.CF_MAX_RETRIES) || 3
});

// 优雅关闭处理
process.on('SIGTERM', async () => {
  await cloudflareHandler.close();
});

process.on('SIGINT', async () => {
  await cloudflareHandler.close();
});

module.exports = cloudflareHandler; 