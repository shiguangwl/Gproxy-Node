const fs = require('fs-extra');
const path = require('path');
const { Upstream, ReplaceItem } = require('../src/entities');
const logger = require('../src/utils/logger');

class ConfigLoader {
  constructor(configFile = 'proxy-config-youtube.json') {
    this.configFile = configFile;
    this.config = null;
    this.baseUpstream = null;
    this.denyRequestList = [];
    this.replaceList = [];
    this.globalProxyPath = 'proxy-dGltZWhv';
    this.homePath = '/';
    this.customHandlers = [];
    this.cloudflareProtectedHosts = [];
    this.mediaRequestUrlPatterns = [];
    this.largeFileUrlPatterns = [];
    this.streamProcessingUrlPatterns = [];
    this.cloudflareSensitiveHosts = [];
    this.cloudflareDefaultCookies = [];
    this.youtubeDefaultCookies = [];
    this.youtubeClientVersion = '2.20240110.01.00';
    
    this.loadConfig();
  }

  /**
   * 加载配置文件
   */
  loadConfig() {
    try {
      const configPath = path.join(__dirname, this.configFile);
      
      if (!fs.existsSync(configPath)) {
        logger.warn(`配置文件不存在: ${configPath}，使用默认配置`);
        this.createDefaultConfig(configPath);
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      this.config = JSON.parse(configContent);
      
      this.parseConfig();
      logger.info('配置文件加载成功');
      
    } catch (error) {
      logger.error('加载配置文件失败:', error);
      throw new Error(`配置加载失败: ${error.message}`);
    }
  }

  /**
   * 解析配置
   */
  parseConfig() {
    // 解析上游服务器
    if (this.config.base_upstream) {
      this.baseUpstream = new Upstream(this.config.base_upstream);
    }

    // 解析拒绝请求列表
    this.denyRequestList = this.config.deny_request || [];

    // 解析替换规则列表
    this.replaceList = [];
    if (this.config.replace_list && Array.isArray(this.config.replace_list)) {
      this.config.replace_list.forEach(item => {
        try {
          this.replaceList.push(new ReplaceItem({
            search: item.search,
            replace: item.replace,
            matchType: item.matchType,
            urlMatch: item.urlMatch,
            urlExclude: item.urlExclude,
            contentType: item.contentType
          }));
        } catch (error) {
          logger.warn('解析替换规则失败:', error);
        }
      });
    }

    // 设置首页路径
    this.homePath = this.config.home_path || '/';

    // 设置全局代理路径
    this.globalProxyPath = this.config.global_proxy_path || 'proxy-dGltZWhv';

    // 解析自定义处理器
    this.customHandlers = this.config.custom_handlers || [];

    // 解析Cloudflare保护的域名列表
    this.cloudflareProtectedHosts = Array.isArray(this.config.cloudflare_protected_hosts) 
      ? this.config.cloudflare_protected_hosts 
      : [];

    // 解析请求类型判断的 URL 模式
    this.mediaRequestUrlPatterns = Array.isArray(this.config.media_request_url_patterns)
      ? this.config.media_request_url_patterns.map(p => new RegExp(p, 'i'))
      : [];
    this.largeFileUrlPatterns = Array.isArray(this.config.large_file_url_patterns)
      ? this.config.large_file_url_patterns.map(p => new RegExp(p, 'i'))
      : [];
    this.streamProcessingUrlPatterns = Array.isArray(this.config.stream_processing_url_patterns)
      ? this.config.stream_processing_url_patterns.map(p => new RegExp(p, 'i'))
      : [];

    // 解析 pre-handlers 相关配置 (新增)
    this.cloudflareSensitiveHosts = Array.isArray(this.config.cloudflare_sensitive_hosts)
      ? this.config.cloudflare_sensitive_hosts
      : [];
    this.cloudflareDefaultCookies = Array.isArray(this.config.cloudflare_default_cookies)
      ? this.config.cloudflare_default_cookies
      : [];
    this.youtubeDefaultCookies = Array.isArray(this.config.youtube_default_cookies)
      ? this.config.youtube_default_cookies
      : [];
    this.youtubeClientVersion = typeof this.config.youtube_client_version === 'string'
      ? this.config.youtube_client_version
      : '2.20240110.01.00';
  }

  /**
   * 创建默认配置文件
   */
  createDefaultConfig(configPath) {
    const defaultConfig = {
      "base_upstream": "https://www.youtube.com",
      "home_path": "/",
      "global_proxy_path": "proxy-dGltZWhv",
      "deny_request": [],
      "cloudflare_protected_hosts": [
        "discord.com",
        "github.com",
        "reddit.com",
        "stackoverflow.com",
        "medium.com",
        "cloudflare.com",
        "npmjs.com",
        "jsdelivr.net",
        "cdnjs.com",
        "linux.do"
      ],
      "media_request_url_patterns": [
        "\\.(mp4|avi|mkv|mov|wmv|flv|webm)(\\?|$)",
        "\\.(mp3|wav|flac|aac|ogg|m4a)(\\?|$)",
        "videoplayback",
        "googlevideo\\.com",
        "ytimg\\.com.*\\.(jpg|jpeg|png|webp)",
        "/stream/",
        "/video/",
        "/audio/",
        "/media/",
        "manifest\\.(m3u8|mpd)",
        "\\.ts(\\?|$)",
        "chunk.*\\.m4s",
        "segment.*\\.(ts|m4s)"
      ],
      "large_file_url_patterns": [
        "\\.(zip|rar|7z|tar|gz|bz2)(\\?|$)",
        "\\.(iso|img|dmg)(\\?|$)",
        "\\.(pdf|doc|docx|ppt|pptx|xls|xlsx)(\\?|$)",
        "/download/",
        "/files/",
        "\\.exe(\\?|$)",
        "\\.msi(\\?|$)",
        "\\.pkg(\\?|$)",
        "\\.deb(\\?|$)",
        "\\.rpm(\\?|$)"
      ],
      "stream_processing_url_patterns": [
        "\\.(mp4|avi|mkv|mov|wmv|flv|webm)$", 
        "\\.(mp3|wav|flac|aac|ogg)$",
        "\\.(zip|rar|7z|tar|gz|bz2)$",
        "\\.(pdf|doc|docx|ppt|pptx)$", 
        "\\.(iso|img|dmg)$",
        "/download/",
        "/stream/", 
        "/files/"
      ],
      "cloudflare_sensitive_hosts": [
        "discord.com",
        "github.com",
        "reddit.com",
        "stackoverflow.com",
        "medium.com"
      ],
      "cloudflare_default_cookies": [
        "_ga=GA1.1.000000000.0000000000",
        "_gid=GA1.1.000000000.0000000000"
      ],
      "youtube_default_cookies": [
        "CONSENT=YES+cb.20210720-07-p0.en+FX+000",
        "VISITOR_INFO1_LIVE=ExampleCookie",
        "YSC=ExampleSessionCookie",
        "PREF=tz=Asia.Shanghai&f6=00000000"
      ],
      "youtube_client_version": "2.20240201.01.00",
      "replace_list": [
        {
          "search": "$upstream",
          "replace": "$custom_site",
          "matchType": 1,
          "urlMatch": null,
          "urlExclude": null,
          "contentType": null
        },
        {
          "search": "https://i.ytimg.com",
          "replace": "$PROXY/https://i.ytimg.com",
          "matchType": 1,
          "urlMatch": null,
          "urlExclude": null,
          "contentType": null
        },
        {
          "search": "https://www.youtube.com",
          "replace": "$PROXY/https://www.youtube.com",
          "matchType": 1,
          "urlMatch": null,
          "urlExclude": null,
          "contentType": null
        },
        {
          "search": "https://s.ytimg.com",
          "replace": "$PROXY/https://s.ytimg.com",
          "matchType": 1,
          "urlMatch": null,
          "urlExclude": null,
          "contentType": null
        },
        {
          "search": "https://yt3.ggpht.com",
          "replace": "$PROXY/https://yt3.ggpht.com",
          "matchType": 1,
          "urlMatch": null,
          "urlExclude": null,
          "contentType": null
        }
      ]
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      logger.info('已创建默认配置文件');
    } catch (error) {
      logger.error('创建默认配置文件失败:', error);
    }
  }

  /**
   * 重新加载配置
   */
  reload() {
    try {
      this.loadConfig();
      logger.info('配置重新加载成功');
      return true;
    } catch (error) {
      logger.error('配置重新加载失败:', error);
      return false;
    }
  }

  /**
   * 获取配置信息
   */
  getConfig() {
    return {
      baseUpstream: this.baseUpstream,
      denyRequestList: this.denyRequestList,
      replaceList: this.replaceList,
      globalProxyPath: this.globalProxyPath,
      homePath: this.homePath,
      customHandlers: this.customHandlers,
      cloudflareProtectedHosts: this.cloudflareProtectedHosts,
      mediaRequestUrlPatterns: this.mediaRequestUrlPatterns,
      largeFileUrlPatterns: this.largeFileUrlPatterns,
      streamProcessingUrlPatterns: this.streamProcessingUrlPatterns,
      cloudflareSensitiveHosts: this.cloudflareSensitiveHosts,
      cloudflareDefaultCookies: this.cloudflareDefaultCookies,
      youtubeDefaultCookies: this.youtubeDefaultCookies,
      youtubeClientVersion: this.youtubeClientVersion
    };
  }

  /**
   * 验证配置有效性
   */
  validateConfig() {
    const errors = [];

    if (!this.baseUpstream) {
      errors.push('缺少base_upstream配置');
    }

    if (!Array.isArray(this.denyRequestList)) {
      errors.push('deny_request必须是数组');
    }

    if (!Array.isArray(this.replaceList)) {
      errors.push('replace_list必须是数组');
    }

    this.replaceList.forEach((item, index) => {
      if (!item.search || !item.replace) {
        errors.push(`替换规则 ${index} 缺少search或replace字段`);
      }
      if (![1, 2].includes(item.matchType)) {
        errors.push(`替换规则 ${index} matchType必须是1或2`);
      }
    });

    if (errors.length > 0) {
      logger.error('配置验证失败:', errors);
      throw new Error('配置验证失败: ' + errors.join(', '));
    }

    return true;
  }
}

// 创建单例实例
const configLoader = new ConfigLoader();

module.exports = configLoader; 