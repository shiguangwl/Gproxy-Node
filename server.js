const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs-extra');

// 导入自定义模块
const logger = require('./src/utils/logger');
const connectionManager = require('./src/utils/connection-manager');
const configLoader = require('./config/config-loader');
const { 
  Upstream, 
  requestBaseConvert, 
  requestProxyConvert, 
  extractTargetSiteFromProxyUrl 
} = require('./src/entities');
const { 
  proxyHandler, 
  streamProxyHandler, 
  shouldUseStreamProcessing,
  warmupConnectionPool 
} = require('./src/proxy-handler');

// 导入处理器
const {
  preHandler,
  mediaPreHandler,
  createCustomHomePathHandler,
  securityHeaderHandler,
  requestBodyHandler,
  youtubeHeaderHandler,
  cloudflarePreHandler,
  antiDetectionPreHandler
} = require('./src/handlers/pre-handlers');

const {
  postHandler,
  postReplaceContentHandler,
  postInjectHandler,
  postDecompressHandler,
  postOptimizeHeadersHandler,
  postErrorPageHandler
} = require('./src/handlers/post-handlers');

// 导入主路由模块
const mainRoutes = require('./routes');

// 创建Express应用
const app = express();

// 基础中间件配置
app.use(helmet({
  contentSecurityPolicy: false, // 禁用CSP以允许代理内容
  crossOriginEmbedderPolicy: false // 禁用COEP以允许跨域嵌入
}));

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Cache-Control']
}));

app.use(compression()); // 启用压缩

// 处理原始请求体
app.use(express.raw({ 
  type: '*/*', 
  limit: '50mb' 
}));

// 静态文件服务
app.use('/static', express.static(path.join(__dirname, 'static')));
// app.use('/admin-assets', express.static(path.join(__dirname, 'static'))); // 这行可能不再需要，因为 admin.html 会通过 /admin 路由提供，其内部资源引用会相对于 /static

// 健康检查端点
app.get('/health', (req, res) => {
  const connectionMetrics = connectionManager.getMetrics();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.1.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connectionPool: {
      successRate: connectionMetrics.successRate,
      averageResponseTime: connectionMetrics.averageResponseTime,
      activeConnections: connectionMetrics.poolStatus,
      cloudflareBypassRate: connectionMetrics.cloudflareBypassRate
    },
    features: {
      base64Encoding: true,
      streamProcessing: true,
      connectionPooling: true,
      intelligentRetry: true,
      enhancedContentProcessing: true,
      cloudflareBypass: true,
      browserFingerprintSpoofing: true,
      antiDetection: true
    }
  });
});

// 详细的系统状态端点
app.get('/admin/status', (req, res) => {
  try {
    const connectionMetrics = connectionManager.getMetrics();
    const config = configLoader.getConfig();
    
    res.json({
      system: {
        version: '2.1.0',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        env: process.env.NODE_ENV || 'development'
      },
      configuration: {
        baseUpstream: config.baseUpstream?.site,
        globalProxyPath: config.globalProxyPath,
        replaceRulesCount: config.replaceList.length,
        denyRulesCount: config.denyRequestList.length,
        cloudflareBypass: process.env.CLOUDFLARE_BYPASS !== 'false'
      },
      connectionManager: connectionMetrics,
      features: {
        base64Encoding: '✅ URL Base64编码传输',
        streamProcessing: '✅ 大文件流式处理',
        connectionPooling: '✅ 智能连接池管理',
        intelligentRetry: '✅ 指数退避重试策略',
        enhancedContentProcessing: '✅ 增强内容处理',
        mediaOptimization: '✅ 媒体请求优化',
        cssProcessing: '✅ CSS URL处理',
        jsProcessing: '✅ JavaScript URL处理',
        errorRecovery: '✅ 错误恢复机制',
        performanceMonitoring: '✅ 性能监控',
        cloudflareBypass: '✅ Cloudflare验证绕过',
        browserFingerprint: '✅ 浏览器指纹伪装',
        antiDetection: '✅ 反爬虫检测',
        advancedTLS: '✅ 增强TLS配置'
      }
    });
  } catch (error) {
    logger.error('获取系统状态失败:', error);
    res.status(500).json({ error: '获取系统状态失败' });
  }
});

// 获取配置
const config = configLoader.getConfig();

// 应用主路由
app.use('/', mainRoutes);

// 请求时间记录中间件
app.use((req, res, next) => {
  req._startTime = Date.now();
  next();
});

// 错误处理中间件
app.use((error, req, res, next) => {
  logger.error('Express错误处理中间件:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method
  });

  if (!res.headersSent) {
    res.status(500).json({
      error: '服务器内部错误',
      message: process.env.NODE_ENV === 'development' ? error.message : '请稍后重试',
      timestamp: new Date().toISOString()
    });
  }
});

// 404处理
app.use((req, res) => {
  logger.warn('404请求:', {
    method: req.method,
    url: req.url,
    userAgent: req.get('user-agent'),
    ip: req.ip || req.connection.remoteAddress
  });

  res.status(404).json({
    error: '页面未找到',
    message: '请检查URL是否正确',
    timestamp: new Date().toISOString()
  });
});

// 优雅关闭处理
process.on('SIGTERM', async () => {
  logger.info('收到SIGTERM信号，正在关闭服务器...');
  
  // 关闭连接管理器
  await connectionManager.shutdown();
  
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('收到SIGINT信号，正在关闭服务器...');
  
  // 关闭连接管理器
  await connectionManager.shutdown();
  
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', { reason, promise });
  process.exit(1);
});

// 启动服务器
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';

// 确保日志目录存在
fs.ensureDirSync(path.join(__dirname, 'logs'));

const server = app.listen(PORT, HOST, async () => {
  logger.info(`Gproxy-Node服务器启动成功`, {
    host: HOST,
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    baseUpstream: config.baseUpstream?.site,
    globalProxyPath: config.globalProxyPath,
    features: {
      base64Encoding: true,
      streamProcessing: true,
      connectionPooling: true,
      intelligentRetry: true,
      enhancedContentProcessing: true
    }
  });

  // 预热连接池
  if (config.baseUpstream) {
    setTimeout(() => {
      warmupConnectionPool(config.baseUpstream.site);
    }, 1000);
  }

  console.log(`
╭─────────────────────────────────────────────────────────────╮
│                  🚀 Gproxy-Node v2.1.0                     │
│                                                             │
│  ✨ 增强版全局代理服务器已启动 - Cloudflare支持             │
│                                                             │
│  🌐 服务地址: http://${HOST}:${PORT}                         │
│  📊 管理界面: http://${HOST}:${PORT}/admin                   │
│  💓 健康检查: http://${HOST}:${PORT}/health                  │
│  🎯 目标网站: ${config.baseUpstream?.site || 'N/A'}          │
│  🔧 全局代理: /${config.globalProxyPath}/[Base64编码URL]     │
│                                                             │
│  🎉 新功能亮点:                                              │
│  ├─ ✅ URL Base64编码传输                                   │
│  ├─ ✅ 智能连接池管理                                        │
│  ├─ ✅ 指数退避重试策略                                      │
│  ├─ ✅ 增强内容处理                                          │
│  ├─ ✅ 媒体请求优化                                          │
│  ├─ ✅ 流式大文件处理                                        │
│  ├─ ✅ 实时性能监控                                          │
│  ├─ ✅ 错误恢复机制                                          │
│  ├─ 🔥 Cloudflare验证绕过                                   │
│  ├─ 🔥 浏览器指纹伪装                                        │
│  ├─ 🔥 反爬虫检测                                            │
│  └─ 🔥 增强TLS配置                                           │
│                                                             │
│  💡 管理提示: 访问 /admin 查看详细状态和管理功能               │
│  🔒 Cloudflare: 自动检测和绕过验证挑战                      │
│  📱 按 Ctrl+C 优雅停止服务器                                 │
╰─────────────────────────────────────────────────────────────╯
  `);
});

module.exports = app; 