const express = require('express');
const path = require('path');
const configLoader = require('../config/config-loader');
const connectionManager = require('../src/utils/connection-manager');
const logger = require('../src/utils/logger');
const { warmupConnectionPool } = require('../src/proxy-handler'); // 确保引入

const router = express.Router();

// 详细的系统状态端点
router.get('/status', (req, res) => {
  try {
    const connectionMetrics = connectionManager.getMetrics();
    const config = configLoader.getConfig();
    
    res.json({
      system: {
        version: '2.1.0', // Consider making this dynamic (e.g., from package.json)
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
        cloudflareBypass: process.env.CLOUDFLARE_BYPASS !== 'false',
        cloudflareProtectedHostsCount: config.cloudflareProtectedHosts?.length || 0
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

// 配置管理端点
router.get('/config', (req, res) => {
  try {
    const config = configLoader.getConfig();
    res.json({
      baseUpstream: config.baseUpstream?.site,
      globalProxyPath: config.globalProxyPath,
      replaceRulesCount: config.replaceList.length,
      denyRulesCount: config.denyRequestList.length,
      replaceRules: config.replaceList,
      denyRules: config.denyRequestList,
      cloudflareProtectedHosts: config.cloudflareProtectedHosts // 确保返回此项
    });
  } catch (error) {
    logger.error('获取配置失败:', error);
    res.status(500).json({ error: '获取配置失败' });
  }
});

router.post('/config/reload', (req, res) => {
  try {
    const success = configLoader.reload();
    if (success) {
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
router.get('/connections', (req, res) => {
  try {
    const metrics = connectionManager.getMetrics();
    res.json(metrics);
  } catch (error) {
    logger.error('获取连接信息失败:', error);
    res.status(500).json({ error: '获取连接信息失败' });
  }
});

router.post('/connections/reset', (req, res) => {
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
router.get('/', (req, res) => {
  // 注意: path.join需要处理相对路径的基准
  // __dirname 在这里是 routes 目录，所以要返回到项目根目录再找 static
  res.sendFile(path.join(__dirname, '..', 'static', 'admin.html'));
});

module.exports = router; 