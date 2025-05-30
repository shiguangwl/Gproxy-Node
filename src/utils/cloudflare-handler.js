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
   * 检测是否遇到 Cloudflare 验证
   */
  isCloudflareChallenge(response) {
    if (!response) return false;

    // 检查状态码
    if ([403, 503, 520, 521, 522, 523, 524, 525, 526, 527, 530].includes(response.status)) {
      return true;
    }

    // 检查响应头
    const server = response.headers['server'];
    const cfRay = response.headers['cf-ray'];
    const cfCache = response.headers['cf-cache-status'];
    
    if (server && server.toLowerCase().includes('cloudflare')) {
      return true;
    }

    if (cfRay || cfCache) {
      return true;
    }

    // 检查响应内容中的Cloudflare特征
    if (response.data && typeof response.data === 'string') {
      const cloudflarePatterns = [
        /cloudflare/i,
        /cf-ray/i,
        /checking your browser/i,
        /ddos protection/i,
        /ray id/i,
        /__cf_chl_jschl_tk__/i,
        /cf-browser-verification/i,
        /cf_clearance/i
      ];

      return cloudflarePatterns.some(pattern => pattern.test(response.data));
    }

    return false;
  }

  /**
   * 使用浏览器绕过 Cloudflare 验证
   */
  async bypassCloudflare(url, options = {}) {
    let page = null;
    let attempt = 0;

    while (attempt < this.options.maxRetries) {
      try {
        const browser = await this.initBrowser();
        page = await browser.newPage();

        // 设置用户代理和其他浏览器特征
        await page.setUserAgent(this.options.userAgent);
        
        // 设置额外的headers
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'max-age=0',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        });

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
          cookieCount: finalCookies.length
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
        
        if (attempt < this.options.maxRetries) {
          await this.sleep(2000 * attempt); // 递增延迟
        }
      }
    }

    throw new Error(`Cloudflare验证绕过失败，已尝试 ${this.options.maxRetries} 次`);
  }

  /**
   * 等待Cloudflare验证完成
   */
  async waitForCloudflareClearance(page) {
    try {
      // 等待页面中不再包含Cloudflare验证相关内容
      await page.waitForFunction(() => {
        const body = document.body.innerText.toLowerCase();
        const cloudflareTexts = [
          'checking your browser',
          'ddos protection',
          'please wait',
          'just a moment'
        ];
        return !cloudflareTexts.some(text => body.includes(text));
      }, { timeout: this.options.challengeTimeout });

      // 额外等待一点时间确保页面完全加载
      await this.sleep(2000);

      logger.debug('Cloudflare验证挑战完成');
    } catch (error) {
      logger.debug('等待Cloudflare验证超时或未检测到验证页面');
      // 不抛出错误，继续执行
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