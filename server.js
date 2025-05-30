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
  youtubeHeaderHandler
} = require('./src/handlers/pre-handlers');

const {
  postHandler,
  postReplaceContentHandler,
  postInjectHandler,
  postDecompressHandler,
  postOptimizeHeadersHandler,
  postErrorPageHandler
} = require('./src/handlers/post-handlers');

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

// 健康检查端点
app.get('/health', (req, res) => {
  const connectionMetrics = connectionManager.getMetrics();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connectionPool: {
      successRate: connectionMetrics.successRate,
      averageResponseTime: connectionMetrics.averageResponseTime,
      activeConnections: connectionMetrics.poolStatus
    },
    features: {
      base64Encoding: true,
      streamProcessing: true,
      connectionPooling: true,
      intelligentRetry: true,
      enhancedContentProcessing: true
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
        version: '2.0.0',
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
        denyRulesCount: config.denyRequestList.length
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
        performanceMonitoring: '✅ 性能监控'
      }
    });
  } catch (error) {
    logger.error('获取系统状态失败:', error);
    res.status(500).json({ error: '获取系统状态失败' });
  }
});

// 配置管理端点
app.get('/admin/config', (req, res) => {
  try {
    const config = configLoader.getConfig();
    res.json({
      baseUpstream: config.baseUpstream?.site,
      globalProxyPath: config.globalProxyPath,
      replaceRulesCount: config.replaceList.length,
      denyRulesCount: config.denyRequestList.length,
      replaceRules: config.replaceList,
      denyRules: config.denyRequestList
    });
  } catch (error) {
    logger.error('获取配置失败:', error);
    res.status(500).json({ error: '获取配置失败' });
  }
});

app.post('/admin/config/reload', (req, res) => {
  try {
    const success = configLoader.reload();
    if (success) {
      // 重新加载配置后预热连接池
      const config = configLoader.getConfig();
      if (config.baseUpstream) {
        warmupConnectionPool(config.baseUpstream.site);
      }
      
      res.json({ 
        message: '配置重新加载成功',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({ error: '配置重新加载失败' });
    }
  } catch (error) {
    logger.error('重新加载配置失败:', error);
    res.status(500).json({ error: '重新加载配置失败' });
  }
});

// 连接管理器控制端点
app.get('/admin/connections', (req, res) => {
  try {
    const metrics = connectionManager.getMetrics();
    res.json(metrics);
  } catch (error) {
    logger.error('获取连接信息失败:', error);
    res.status(500).json({ error: '获取连接信息失败' });
  }
});

app.post('/admin/connections/reset', (req, res) => {
  try {
    connectionManager.resetStats();
    res.json({ 
      message: '连接统计已重置',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('重置连接统计失败:', error);
    res.status(500).json({ error: '重置连接统计失败' });
  }
});

// 简单的管理界面
app.get('/admin', (req, res) => {
  const adminHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gproxy-Node 管理界面</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0; padding: 20px; 
            background: #f5f5f5; color: #333;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; padding: 30px; border-radius: 10px;
            margin-bottom: 20px; text-align: center;
        }
        .card { 
            background: white; padding: 20px; border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px;
        }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .stat-item { padding: 15px; background: #f8f9fa; border-radius: 8px; }
        .stat-value { font-size: 2em; font-weight: bold; color: #3498db; }
        .btn { 
            background: #3498db; color: white; padding: 10px 20px;
            border: none; border-radius: 5px; cursor: pointer;
            margin: 5px; transition: background 0.3s;
        }
        .btn:hover { background: #2980b9; }
        .btn-danger { background: #e74c3c; }
        .btn-danger:hover { background: #c0392b; }
        .feature-list { list-style: none; padding: 0; }
        .feature-list li { padding: 10px; background: #e8f5e8; margin: 5px 0; border-radius: 5px; }
        .feature-list li:before { content: "✅ "; }
        pre { background: #2c3e50; color: #ecf0f1; padding: 15px; border-radius: 8px; overflow-x: auto; }
        .loading { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Gproxy-Node v2.0.0</h1>
            <p>增强版全局代理服务器管理界面</p>
        </div>
        
        <div class="card">
            <h2>📊 系统状态</h2>
            <div class="stats-grid" id="statsGrid">
                <div class="loading">加载中...</div>
            </div>
            <button class="btn" onclick="refreshStats()">刷新状态</button>
        </div>
        
        <div class="card">
            <h2>🔧 功能特性</h2>
            <ul class="feature-list">
                <li>URL Base64编码传输 - 解决复杂URL解析问题</li>
                <li>大文件流式处理 - 避免内存溢出</li>
                <li>智能连接池管理 - 提升性能和稳定性</li>
                <li>指数退避重试策略 - 增强可靠性</li>
                <li>增强内容处理 - 支持CSS/JS/HTML智能替换</li>
                <li>媒体请求优化 - 专门针对视频/音频优化</li>
                <li>错误恢复机制 - 自动处理各类异常</li>
                <li>性能监控 - 实时统计和分析</li>
            </ul>
        </div>
        
        <div class="card">
            <h2>⚙️ 配置管理</h2>
            <button class="btn" onclick="reloadConfig()">重新加载配置</button>
            <button class="btn" onclick="showConfig()">查看配置</button>
            <pre id="configDisplay" style="display: none;"></pre>
        </div>
        
        <div class="card">
            <h2>🌐 连接管理</h2>
            <button class="btn" onclick="showConnections()">查看连接状态</button>
            <button class="btn btn-danger" onclick="resetConnections()">重置连接统计</button>
            <pre id="connectionDisplay" style="display: none;"></pre>
        </div>
        
        <div class="card">
            <h2>📝 使用说明</h2>
            <h3>基础代理</h3>
            <p>直接访问：<code>http://localhost:8000/</code></p>
            
            <h3>全局代理（Base64编码）</h3>
            <p>格式：<code>http://localhost:8000/${configLoader.getConfig().globalProxyPath}/[Base64编码的URL]</code></p>
            <p>前端会自动处理编码，无需手动操作</p>
            
            <h3>API端点</h3>
            <ul>
                <li><code>/health</code> - 健康检查</li>
                <li><code>/admin/status</code> - 详细状态</li>
                <li><code>/admin/config</code> - 配置信息</li>
                <li><code>/admin/connections</code> - 连接信息</li>
            </ul>
        </div>
    </div>
    
    <script>
        async function refreshStats() {
            try {
                const response = await fetch('/admin/status');
                const data = await response.json();
                
                const statsHtml = \`
                    <div class="stat-item">
                        <div class="stat-value">\${data.system.uptime.toFixed(0)}s</div>
                        <div>运行时间</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${data.connectionManager.successRate.toFixed(2)}%</div>
                        <div>成功率</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${data.connectionManager.averageResponseTime.toFixed(0)}ms</div>
                        <div>平均响应时间</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${data.connectionManager.stats.totalRequests}</div>
                        <div>总请求数</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${(data.system.memory.heapUsed / 1024 / 1024).toFixed(1)}MB</div>
                        <div>内存使用</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${data.configuration.replaceRulesCount}</div>
                        <div>替换规则数</div>
                    </div>
                \`;
                
                document.getElementById('statsGrid').innerHTML = statsHtml;
            } catch (error) {
                alert('获取状态失败: ' + error.message);
            }
        }
        
        async function reloadConfig() {
            try {
                const response = await fetch('/admin/config/reload', { method: 'POST' });
                const data = await response.json();
                alert(data.message || '配置重新加载成功');
                refreshStats();
            } catch (error) {
                alert('重新加载配置失败: ' + error.message);
            }
        }
        
        async function showConfig() {
            try {
                const response = await fetch('/admin/config');
                const data = await response.json();
                document.getElementById('configDisplay').style.display = 'block';
                document.getElementById('configDisplay').textContent = JSON.stringify(data, null, 2);
            } catch (error) {
                alert('获取配置失败: ' + error.message);
            }
        }
        
        async function showConnections() {
            try {
                const response = await fetch('/admin/connections');
                const data = await response.json();
                document.getElementById('connectionDisplay').style.display = 'block';
                document.getElementById('connectionDisplay').textContent = JSON.stringify(data, null, 2);
            } catch (error) {
                alert('获取连接信息失败: ' + error.message);
            }
        }
        
        async function resetConnections() {
            if (confirm('确定要重置连接统计吗？')) {
                try {
                    const response = await fetch('/admin/connections/reset', { method: 'POST' });
                    const data = await response.json();
                    alert(data.message || '连接统计已重置');
                    refreshStats();
                } catch (error) {
                    alert('重置连接统计失败: ' + error.message);
                }
            }
        }
        
        // 初始加载
        refreshStats();
        
        // 自动刷新
        setInterval(refreshStats, 30000);
    </script>
</body>
</html>`;
  
  res.send(adminHtml);
});

// 获取配置
const config = configLoader.getConfig();

// 主代理路由（特定网站代理）
app.all('/', async (req, res) => {
  await handleProxyRequest(req, res, 'base');
});

app.all('/*', async (req, res) => {
  // 检查是否是全局代理请求
  if (req.path.startsWith(`/${config.globalProxyPath}/`)) {
    await handleProxyRequest(req, res, 'global');
  } else {
    await handleProxyRequest(req, res, 'base');
  }
});

/**
 * 处理代理请求的统一函数
 * @param {Request} req Express请求对象
 * @param {Response} res Express响应对象
 * @param {string} mode 代理模式：'base' 或 'global'
 */
async function handleProxyRequest(req, res, mode) {
  try {
    let proxyRequest;
    let upstream;

    if (mode === 'global') {
      // 全局代理模式
      try {
        // 提取目标站点信息
        const targetSite = extractTargetSiteFromProxyUrl(req.url, config.globalProxyPath);
        upstream = new Upstream(targetSite);
        proxyRequest = requestProxyConvert(req, config.globalProxyPath);
        
        logger.debug('全局代理请求', {
          targetSite: targetSite,
          path: proxyRequest.urlNoSite,
          method: req.method
        });
        
      } catch (error) {
        logger.error('解析全局代理URL失败:', {
          url: req.url,
          error: error.message
        });
        
        return res.status(400).json({ 
          error: '无效的代理URL',
          message: '请检查URL格式是否正确',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      // 基础代理模式
      if (!config.baseUpstream) {
        logger.error('基础上游服务器未配置');
        return res.status(500).json({ error: '代理服务器配置错误' });
      }
      
      upstream = config.baseUpstream;
      proxyRequest = requestBaseConvert(req);
    }

    // 检查是否应该使用流式处理
    if (shouldUseStreamProcessing(proxyRequest)) {
      logger.debug('使用流式代理处理', {
        path: proxyRequest.urlNoSite,
        method: req.method
      });
      
      return await streamProxyHandler(
        proxyRequest,
        upstream,
        res,
        [
          securityHeaderHandler,
          preHandler,
          mediaPreHandler,
          youtubeHeaderHandler,
          requestBodyHandler
        ]
      );
    }

    // 常规代理处理
    logger.debug('使用常规代理处理', {
      upstream: upstream.site,
      path: proxyRequest.urlNoSite,
      method: req.method
    });
    
    const preHandlers = [
      securityHeaderHandler,
      mode === 'base' ? createCustomHomePathHandler(config.homePath) : null,
      preHandler,
      mediaPreHandler,
      youtubeHeaderHandler,
      requestBodyHandler
    ].filter(Boolean);

    const postHandlers = [
      postDecompressHandler,
      postHandler,
      postReplaceContentHandler,
      mode === 'base' ? postInjectHandler : null,
      postOptimizeHeadersHandler,
      postErrorPageHandler
    ].filter(Boolean);

    const proxyResponse = await proxyHandler(
      proxyRequest,
      upstream,
      preHandlers,
      postHandlers
    );

    // 发送响应
    res.status(proxyResponse.statusCode);

    // 设置响应头
    if (proxyResponse.headers) {
      Object.entries(proxyResponse.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          // 处理多个相同头部（如Set-Cookie）
          value.forEach(v => res.append(key, v));
        } else {
          res.set(key, value);
        }
      });
    }

    // 发送内容
    if (Buffer.isBuffer(proxyResponse.content)) {
      res.send(proxyResponse.content);
    } else if (typeof proxyResponse.content === 'string') {
      res.send(proxyResponse.content);
    } else {
      res.json(proxyResponse.content);
    }

    // 记录访问日志
    logger.info('代理请求处理完成', {
      method: req.method,
      url: req.url,
      status: proxyResponse.statusCode,
      upstream: upstream.site,
      contentType: proxyResponse.headers['content-type'],
      userAgent: req.get('user-agent'),
      ip: req.ip || req.connection.remoteAddress,
      processingTime: Date.now() - req._startTime
    });

  } catch (error) {
    logger.error('处理代理请求时发生错误:', {
      method: req.method,
      url: req.url,
      error: error.message,
      stack: error.stack
    });

    if (!res.headersSent) {
      // 根据错误类型返回不同的状态码
      let statusCode = 500;
      let errorMessage = '代理服务器内部错误';
      
      if (error.message.includes('无效的目标URL')) {
        statusCode = 400;
        errorMessage = '无效的目标URL';
      } else if (error.message.includes('ACCESS_DENIED')) {
        statusCode = 403;
        errorMessage = '访问被拒绝';
      } else if (error.message.includes('ENOTFOUND')) {
        statusCode = 502;
        errorMessage = '无法解析目标服务器';
      } else if (error.message.includes('ECONNREFUSED')) {
        statusCode = 502;
        errorMessage = '目标服务器拒绝连接';
      } else if (error.message.includes('ETIMEDOUT')) {
        statusCode = 504;
        errorMessage = '请求超时';
      }
      
      res.status(statusCode).json({
        error: errorMessage,
        message: process.env.NODE_ENV === 'development' ? error.message : '请稍后重试',
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-gproxy-request-id'] || 'unknown'
      });
    }
  }
}

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
│                  🚀 Gproxy-Node v2.0.0                     │
│                                                             │
│  ✨ 增强版全局代理服务器已启动                                 │
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
│  └─ ✅ 错误恢复机制                                          │
│                                                             │
│  💡 管理提示: 访问 /admin 查看详细状态和管理功能               │
│  📱 按 Ctrl+C 优雅停止服务器                                 │
╰─────────────────────────────────────────────────────────────╯
  `);
});

module.exports = app; 