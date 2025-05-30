# Gproxy-Node

一个强大的全局整站代理服务器，使用 Node.js 构建。支持特定网站代理和全局代理模式，能够处理内容替换、JavaScript注入、Cookie管理等功能。**已解决复杂URL解析问题，采用Base64编码传输。**

## ✨ 主要功能

### 🎯 代理模式
- **特定网站代理**：为特定目标网站提供代理服务
- **全局代理模式**：可以代理任意网站的内容（支持Base64编码URL）
- **流式处理**：支持大文件的流式代理，避免内存溢出

### 🔄 内容处理
- **智能内容替换**：支持字符串和正则表达式替换
- **JavaScript注入**：自动注入脚本拦截Ajax请求
- **内容解压缩**：正确处理 gzip、deflate、brotli 压缩内容
- **编码处理**：自动处理各种字符编码

### 🍪 Cookie管理
- **Cookie域名转换**：正确处理跨域Cookie
- **Cookie属性处理**：处理 domain、path、secure 等属性
- **兼容性增强**：解决原版Python代码中Cookie处理的问题

### 🛡️ 安全与性能
- **请求验证**：支持黑名单规则
- **安全头部处理**：移除可能暴露信息的头部
- **错误处理**：完善的错误捕获和处理机制
- **日志记录**：详细的访问和错误日志
- **重试机制**：自动重试失败的请求

### 🎬 媒体优化
- **视频流优化**：专门针对YouTube等视频网站的优化
- **反检测机制**：模拟真实浏览器行为
- **Range请求支持**：支持视频分片下载
- **媒体头部优化**：针对性设置媒体请求头部

## 🚀 快速开始

### 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 或使用 yarn
yarn install
```

### 启动服务器

```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

### 访问服务

服务器启动后，访问 `http://localhost:8000` 即可开始使用代理服务。

## 📁 项目结构

```
gproxy-node/
├── package.json              # 项目依赖和脚本
├── server.js                 # 主服务器文件
├── README.md                 # 项目文档
├── test-base64-encoding.js   # Base64编码测试脚本
├── config/
│   ├── config-loader.js      # 配置加载器
│   └── proxy-config-youtube.json # 配置文件
├── src/
│   ├── entities.js           # 实体类定义
│   ├── proxy-handler.js      # 代理处理核心
│   ├── handlers/
│   │   ├── pre-handlers.js   # 前置处理器
│   │   └── post-handlers.js  # 后置处理器
│   └── utils/
│       ├── logger.js         # 日志工具
│       └── cookie-parser.js  # Cookie处理工具
├── static/
│   └── inject.js             # 注入的JavaScript代码
└── logs/                     # 日志文件目录
```

## ⚙️ 配置说明

### 基础配置

配置文件位于 `config/proxy-config-youtube.json`：

```json
{
  "base_upstream": "https://www.youtube.com",
  "home_path": "/",
  "global_proxy_path": "proxy-dGltZWhv",
  "deny_request": [],
  "replace_list": [
    {
      "search": "$upstream",
      "replace": "$custom_site",
      "matchType": 1,
      "urlMatch": null,
      "urlExclude": null,
      "contentType": null
    }
  ]
}
```

### 配置参数说明

- `base_upstream`: 基础代理的目标网站
- `home_path`: 自定义主页路径
- `global_proxy_path`: 全局代理的路径前缀
- `deny_request`: 拒绝代理的URL模式（正则表达式）
- `replace_list`: 内容替换规则列表

### 替换规则参数

- `search`: 要搜索的内容
- `replace`: 替换为的内容
- `matchType`: 匹配类型（1=字符串，2=正则表达式）
- `urlMatch`: URL匹配规则（可选）
- `urlExclude`: URL排除规则（可选）
- `contentType`: 内容类型过滤（可选）

### 关键词替换

支持以下关键词替换：
- `$upstream`: 上游网站地址
- `$custom_site`: 代理网站地址
- `$scheme`: 协议（http/https）
- `$host`: 主机名
- `$PROXY`: 全局代理路径

## 🌐 使用方式

### 1. 特定网站代理

直接访问代理服务器地址，例如：
```
http://localhost:8000/
```

### 2. 全局代理模式 ⭐ 新功能

**现在使用Base64编码URL，解决了复杂URL解析问题！**

#### 手动构建代理URL：
```javascript
// 要代理的目标URL
const targetUrl = 'https://example.com/path?param=value';

// Base64编码
const encodedUrl = btoa(encodeURIComponent(targetUrl).replace(/%([0-9A-F]{2})/g,
  function toSolidBytes(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));

// 构建代理URL
const proxyUrl = `http://localhost:8000/proxy-dGltZWhv/${encodedUrl}`;
```

#### 前端自动处理：
注入的JavaScript会自动处理所有请求，无需手动编码。

### 3. API 端点

- `GET /health`: 健康检查
- `GET /admin/config`: 查看配置信息
- `POST /admin/config/reload`: 重新加载配置

## 🧪 测试功能

运行测试脚本验证Base64编码功能：

```bash
node test-base64-encoding.js
```

测试包括：
- 复杂YouTube视频URL的Base64编码代理
- 简单URL的代理测试
- 错误处理验证

## 🔧 环境变量

- `NODE_ENV`: 运行环境（development/production）
- `PORT`: 服务器端口（默认：8000）
- `HOST`: 服务器主机（默认：0.0.0.0）

## 📊 日志

日志文件保存在 `logs/` 目录：
- `combined.log`: 综合日志
- `error.log`: 错误日志

## 🆚 相比Python版本的改进

### URL处理改进 ⭐ 重大更新
- ✅ **Base64编码传输**：解决复杂URL（如带查询参数的视频链接）解析问题
- ✅ **安全URL验证**：防止恶意URL注入
- ✅ **向后兼容**：支持旧格式URL的自动转换

### Cookie处理改进
- ✅ 使用 `tough-cookie` 库正确解析Cookie
- ✅ 正确处理 domain、path、secure 等属性
- ✅ 支持Cookie域名转换

### 内容处理改进
- ✅ 正确处理压缩内容（gzip/deflate/brotli）
- ✅ 支持流式处理大文件
- ✅ 更好的字符编码处理

### 错误处理改进
- ✅ 完善的错误分类和处理
- ✅ 自动重试机制
- ✅ 优雅的错误页面
- ✅ 详细的错误日志

### 性能改进
- ✅ 异步处理提升性能
- ✅ 内存优化避免内存泄漏
- ✅ 连接池和超时控制
- ✅ 智能重试机制

### 安全性改进
- ✅ 移除敏感头部信息
- ✅ 输入验证和过滤
- ✅ 防止信息泄露
- ✅ URL安全验证

### 媒体处理改进 🎬 新功能
- ✅ **视频流专用优化**：针对YouTube等视频网站
- ✅ **反检测机制**：模拟真实浏览器行为
- ✅ **媒体头部优化**：特殊的User-Agent和Referer设置
- ✅ **Range请求支持**：支持视频分片下载

## 💡 技术亮点

### Base64编码解决方案
```javascript
// 前端自动编码
function getModifiedUrl(url) {
  const encodedUrl = safeBase64Encode(url);
  return `${location.origin}/${GLOBAL_PROXY_PATH}/${encodedUrl}`;
}

// 后端自动解码
function safeBase64Decode(encodedStr) {
  return decodeURIComponent(atob(encodedStr).split('').map(function(c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
}
```

### 媒体请求优化
```javascript
// 检测媒体请求并应用专用处理
if (isMediaRequest) {
  // 设置YouTube专用头部
  proxyRequest.headers['referer'] = 'https://www.youtube.com/';
  proxyRequest.headers['x-youtube-client-name'] = '1';
  // 移除检测头部
  delete proxyRequest.headers['sec-fetch-site'];
}
```

## 🔨 开发

### 安装开发依赖

```bash
npm install --dev
```

### 开发模式运行

```bash
npm run dev
```

### 调试

设置环境变量启用调试模式：
```bash
NODE_ENV=development npm run dev
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## ⚠️ 注意事项

1. 请遵守目标网站的使用条款和robots.txt
2. 不要用于非法或恶意目的
3. 建议在生产环境中使用HTTPS
4. 定期更新依赖以获得安全补丁
5. 对于403错误，这通常是目标服务器的反爬虫机制，属于正常现象

## 📞 支持

如果您遇到问题或有建议，请：
1. 查看日志文件中的错误信息
2. 检查配置文件是否正确
3. 运行测试脚本验证功能
4. 在GitHub上提交Issue

## 🎉 更新日志

### v1.0.0 (当前版本)
- ✨ **新增Base64编码URL功能**：解决复杂URL解析问题
- 🎬 **新增媒体流优化**：专门针对视频网站的优化
- 🛡️ **增强安全机制**：URL验证和反检测
- 🔄 **改进重试机制**：自动重试失败的请求
- 📊 **完善日志系统**：更详细的调试信息 