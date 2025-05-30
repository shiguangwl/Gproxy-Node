(function() {
    'use strict';
    
    // 全局代理路径配置
    const GLOBAL_PROXY_PATH = '#global_proxy_path#';
    
    // 调试模式
    const DEBUG = false;
    
    // 缓存已处理的URL，避免重复处理
    const urlCache = new Map();
    
    // 性能统计
    const stats = {
        processedUrls: 0,
        cachedHits: 0,
        errors: 0,
        startTime: Date.now()
    };
    
    function log(...args) {
        if (DEBUG) {
            console.log('[Gproxy-Inject]', ...args);
        }
    }
    
    function logError(error, context) {
        stats.errors++;
        if (DEBUG) {
            console.error('[Gproxy-Error]', context, error);
        }
    }
    
    // Base64编码函数（兼容性更好）
    function safeBase64Encode(str) {
        try {
            // 检查缓存
            if (urlCache.has(str)) {
                stats.cachedHits++;
                return urlCache.get(str);
            }
            
            const encoded = btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
                function toSolidBytes(match, p1) {
                    return String.fromCharCode('0x' + p1);
                }));
            
            // 缓存结果
            urlCache.set(str, encoded);
            stats.processedUrls++;
            
            return encoded;
        } catch (error) {
            logError(error, 'Base64编码');
            return encodeURIComponent(str);
        }
    }
    
    // 设置必要的Cookie
    function setCookie(name, value, days) {
        try {
            const date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            const expires = `expires=${date.toUTCString()}`;
            document.cookie = `${name}=${value};${expires};path=/;SameSite=Lax`;
            log('Cookie设置成功:', name, value);
        } catch (error) {
            logError(error, 'Cookie设置');
        }
    }
    
    // 设置必要的Cookie
    setCookie('parental-control', 'yes', 365);
    setCookie('CONSENT', 'YES+cb', 365);
    setCookie('gproxy-enabled', '1', 365);
    
    // 解析和标准化URL
    function parseUrl(url, baseUrl = location.href) {
        try {
            // 如果是空URL或只有锚点，返回null
            if (!url || url === '#' || url.startsWith('#')) {
                return null;
            }
            
            // 如果是JavaScript协议或其他特殊协议，返回null
            if (url.startsWith('javascript:') || url.startsWith('data:') || 
                url.startsWith('blob:') || url.startsWith('mailto:') || 
                url.startsWith('tel:') || url.startsWith('about:')) {
                return null;
            }
            
            // 标准化URL
            const parsedUrl = new URL(url, baseUrl);
            return parsedUrl;
        } catch (error) {
            logError(error, `URL解析: ${url}`);
            return null;
        }
    }
    
    // 检查URL是否需要代理
    function shouldProxy(url) {
        const parsedUrl = parseUrl(url);
        if (!parsedUrl) return false;
        
        // 不代理同源请求
        if (parsedUrl.origin === location.origin) {
            return false;
        }
        
        // 不代理本地地址
        const hostname = parsedUrl.hostname.toLowerCase();
        const localPatterns = [
            'localhost', '127.0.0.1', '0.0.0.0', '::1',
            /^192\.168\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./
        ];
        
        if (localPatterns.some(pattern => 
            typeof pattern === 'string' ? hostname.includes(pattern) : pattern.test(hostname)
        )) {
            return false;
        }
        
        return true;
    }
    
    // 获取修改后的URL
    function getModifiedUrl(url, baseUrl = location.href) {
        try {
            const parsedUrl = parseUrl(url, baseUrl);
            if (!parsedUrl || !shouldProxy(parsedUrl.href)) {
                return url;
            }
            
            // 对目标URL进行Base64编码
            const encodedUrl = safeBase64Encode(parsedUrl.href);
            const proxyUrl = `${location.origin}/${GLOBAL_PROXY_PATH}/${encodedUrl}`;
            
            log('URL转换:', parsedUrl.href, '->', proxyUrl);
            return proxyUrl;
        } catch (error) {
            logError(error, `URL修改: ${url}`);
            return url;
        }
    }
    
    // 处理CSS中的URL
    function processCssUrls(cssText) {
        try {
            return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
                const modifiedUrl = getModifiedUrl(url);
                return `url(${quote}${modifiedUrl}${quote})`;
            });
        } catch (error) {
            logError(error, 'CSS URL处理');
            return cssText;
        }
    }
    
    // Hook fetch API
    if (window.fetch) {
        const originalFetch = window.fetch;
        window.fetch = function(input, options = {}) {
            try {
                let url;
                let requestInit = options;
                
                if (typeof input === 'string') {
                    url = input;
                } else if (input instanceof Request) {
                    url = input.url;
                    // 合并Request对象的配置
                    requestInit = {
                        method: input.method,
                        headers: input.headers,
                        body: input.body,
                        mode: input.mode,
                        credentials: input.credentials,
                        cache: input.cache,
                        redirect: input.redirect,
                        referrer: input.referrer,
                        referrerPolicy: input.referrerPolicy,
                        integrity: input.integrity,
                        keepalive: input.keepalive,
                        signal: input.signal,
                        ...options
                    };
                } else {
                    return originalFetch.call(this, input, options);
                }
                
                if (!shouldProxy(url)) {
                    return originalFetch.call(this, input, options);
                }
                
                const modifiedUrl = getModifiedUrl(url);
                
                log('Fetch拦截:', url, requestInit.method || 'GET');
                
                return originalFetch.call(this, modifiedUrl, requestInit);
            } catch (error) {
                logError(error, 'Fetch拦截');
                return originalFetch.call(this, input, options);
            }
        };
    }
    
    // Hook XMLHttpRequest
    if (window.XMLHttpRequest) {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            try {
                if (!shouldProxy(url)) {
                    return originalOpen.call(this, method, url, async, user, password);
                }
                
                const modifiedUrl = getModifiedUrl(url);
                log('XHR拦截:', method, url);
                return originalOpen.call(this, method, modifiedUrl, async, user, password);
            } catch (error) {
                logError(error, 'XHR拦截');
                return originalOpen.call(this, method, url, async, user, password);
            }
        };
    }
    
    // Hook WebSocket
    if (window.WebSocket) {
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            try {
                if (shouldProxy(url)) {
                    // 将WebSocket URL转换为HTTP URL进行代理
                    const httpUrl = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
                    const modifiedUrl = getModifiedUrl(httpUrl);
                    // 将代理URL转回WebSocket格式
                    const wsUrl = modifiedUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
                    log('WebSocket拦截:', url, '->', wsUrl);
                    return new OriginalWebSocket(wsUrl, protocols);
                }
                return new OriginalWebSocket(url, protocols);
            } catch (error) {
                logError(error, 'WebSocket拦截');
                return new OriginalWebSocket(url, protocols);
            }
        };
        
        // 复制原始构造函数的属性
        Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);
        Object.defineProperty(window.WebSocket, 'prototype', {
            value: OriginalWebSocket.prototype,
            writable: false
        });
    }
    
    // Hook EventSource
    if (window.EventSource) {
        const OriginalEventSource = window.EventSource;
        window.EventSource = function(url, options) {
            try {
                if (shouldProxy(url)) {
                    const modifiedUrl = getModifiedUrl(url);
                    log('EventSource拦截:', url, '->', modifiedUrl);
                    return new OriginalEventSource(modifiedUrl, options);
                }
                return new OriginalEventSource(url, options);
            } catch (error) {
                logError(error, 'EventSource拦截');
                return new OriginalEventSource(url, options);
            }
        };
        
        Object.setPrototypeOf(window.EventSource, OriginalEventSource);
        Object.defineProperty(window.EventSource, 'prototype', {
            value: OriginalEventSource.prototype,
            writable: false
        });
    }
    
    // Hook History API
    if (window.history) {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        
        history.pushState = function(state, title, url) {
            try {
                if (url && shouldProxy(url)) {
                    const modifiedUrl = getModifiedUrl(url);
                    log('History.pushState拦截:', url, '->', modifiedUrl);
                    return originalPushState.call(this, state, title, modifiedUrl);
                }
                return originalPushState.call(this, state, title, url);
            } catch (error) {
                logError(error, 'History.pushState拦截');
                return originalPushState.call(this, state, title, url);
            }
        };
        
        history.replaceState = function(state, title, url) {
            try {
                if (url && shouldProxy(url)) {
                    const modifiedUrl = getModifiedUrl(url);
                    log('History.replaceState拦截:', url, '->', modifiedUrl);
                    return originalReplaceState.call(this, state, title, modifiedUrl);
                }
                return originalReplaceState.call(this, state, title, url);
            } catch (error) {
                logError(error, 'History.replaceState拦截');
                return originalReplaceState.call(this, state, title, url);
            }
        };
    }
    
    // Hook createElement for dynamic elements
    if (document.createElement) {
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName, options) {
            const element = originalCreateElement.call(this, tagName, options);
            
            // 为新创建的元素添加属性监听
            if (element.tagName) {
                const tag = element.tagName.toLowerCase();
                
                // 为特定元素类型设置属性拦截
                if (['img', 'script', 'link', 'iframe', 'video', 'audio', 'source'].includes(tag)) {
                    hookElementSrcAttributes(element);
                }
                
                if (tag === 'a') {
                    hookElementHrefAttribute(element);
                }
                
                if (tag === 'form') {
                    hookElementActionAttribute(element);
                }
            }
            
            return element;
        };
    }
    
    // Hook element attribute setters
    function hookElementSrcAttributes(element) {
        try {
            const srcProps = ['src', 'href', 'action'];
            
            srcProps.forEach(prop => {
                const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, prop) ||
                                 Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), prop);
                
                if (descriptor && descriptor.set) {
                    const originalSetter = descriptor.set;
                    
                    Object.defineProperty(element, prop, {
                        set: function(url) {
                            try {
                                if (shouldProxy(url)) {
                                    const modifiedUrl = getModifiedUrl(url);
                                    log(`${element.tagName}.${prop}拦截:`, url, '->', modifiedUrl);
                                    return originalSetter.call(this, modifiedUrl);
                                }
                                return originalSetter.call(this, url);
                            } catch (error) {
                                logError(error, `${element.tagName}.${prop}拦截`);
                                return originalSetter.call(this, url);
                            }
                        },
                        get: descriptor.get,
                        enumerable: true,
                        configurable: true
                    });
                }
            });
        } catch (error) {
            logError(error, 'Element属性Hook');
        }
    }
    
    function hookElementHrefAttribute(element) {
        hookElementSrcAttributes(element);
    }
    
    function hookElementActionAttribute(element) {
        hookElementSrcAttributes(element);
    }
    
    // Hook Image src属性
    function hookImageSrc() {
        try {
            const imageTypes = [Image, HTMLImageElement];
            
            imageTypes.forEach(ImageClass => {
                if (!ImageClass) return;
                
                const originalDescriptor = Object.getOwnPropertyDescriptor(ImageClass.prototype, 'src');
                
                if (originalDescriptor && originalDescriptor.set) {
                    const originalSetter = originalDescriptor.set;
                    
                    Object.defineProperty(ImageClass.prototype, 'src', {
                        set: function(url) {
                            try {
                                if (shouldProxy(url)) {
                                    const modifiedUrl = getModifiedUrl(url);
                                    log('Image src拦截:', url, '->', modifiedUrl);
                                    return originalSetter.call(this, modifiedUrl);
                                }
                                return originalSetter.call(this, url);
                            } catch (error) {
                                logError(error, 'Image src拦截');
                                return originalSetter.call(this, url);
                            }
                        },
                        get: originalDescriptor.get,
                        enumerable: true,
                        configurable: true
                    });
                }
            });
        } catch (error) {
            logError(error, 'Image src hook');
        }
    }
    
    // Hook CSS StyleSheet
    function hookStyleSheet() {
        try {
            // Hook CSSStyleSheet.insertRule
            if (window.CSSStyleSheet && CSSStyleSheet.prototype.insertRule) {
                const originalInsertRule = CSSStyleSheet.prototype.insertRule;
                CSSStyleSheet.prototype.insertRule = function(rule, index) {
                    try {
                        const modifiedRule = processCssUrls(rule);
                        log('CSS insertRule拦截:', rule, '->', modifiedRule);
                        return originalInsertRule.call(this, modifiedRule, index);
                    } catch (error) {
                        logError(error, 'CSS insertRule拦截');
                        return originalInsertRule.call(this, rule, index);
                    }
                };
            }
            
            // Hook style element textContent
            const styleElements = document.querySelectorAll('style');
            styleElements.forEach(styleEl => {
                const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'textContent') ||
                                         Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
                
                if (originalDescriptor && originalDescriptor.set) {
                    const originalSetter = originalDescriptor.set;
                    
                    Object.defineProperty(styleEl, 'textContent', {
                        set: function(text) {
                            try {
                                const modifiedText = processCssUrls(text);
                                log('Style textContent拦截');
                                return originalSetter.call(this, modifiedText);
                            } catch (error) {
                                logError(error, 'Style textContent拦截');
                                return originalSetter.call(this, text);
                            }
                        },
                        get: originalDescriptor.get,
                        enumerable: true,
                        configurable: true
                    });
                }
            });
        } catch (error) {
            logError(error, 'StyleSheet hook');
        }
    }
    
    // Hook window.open
    function hookWindowOpen() {
        try {
            const originalOpen = window.open;
            window.open = function(url, target, features) {
                try {
                    if (url && shouldProxy(url)) {
                        const modifiedUrl = getModifiedUrl(url);
                        log('Window.open拦截:', url, '->', modifiedUrl);
                        return originalOpen.call(this, modifiedUrl, target, features);
                    }
                    return originalOpen.call(this, url, target, features);
                } catch (error) {
                    logError(error, 'Window.open拦截');
                    return originalOpen.call(this, url, target, features);
                }
            };
        } catch (error) {
            logError(error, 'Window.open hook');
        }
    }
    
    // Hook postMessage for cross-frame communication
    function hookPostMessage() {
        try {
            const originalPostMessage = window.postMessage;
            window.postMessage = function(message, targetOrigin, transfer) {
                try {
                    // 如果targetOrigin需要代理，进行转换
                    if (targetOrigin && shouldProxy(targetOrigin)) {
                        const modifiedOrigin = getModifiedUrl(targetOrigin);
                        log('PostMessage拦截:', targetOrigin, '->', modifiedOrigin);
                        return originalPostMessage.call(this, message, modifiedOrigin, transfer);
                    }
                    return originalPostMessage.call(this, message, targetOrigin, transfer);
                } catch (error) {
                    logError(error, 'PostMessage拦截');
                    return originalPostMessage.call(this, message, targetOrigin, transfer);
                }
            };
        } catch (error) {
            logError(error, 'PostMessage hook');
        }
    }
    
    // Hook setAttribute for all elements
    function hookSetAttribute() {
        try {
            const originalSetAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function(name, value) {
                try {
                    const urlAttributes = ['src', 'href', 'action', 'data', 'poster', 'background'];
                    
                    if (urlAttributes.includes(name.toLowerCase()) && shouldProxy(value)) {
                        const modifiedValue = getModifiedUrl(value);
                        log(`setAttribute拦截 ${name}:`, value, '->', modifiedValue);
                        return originalSetAttribute.call(this, name, modifiedValue);
                    }
                    
                    // 处理style属性中的CSS URL
                    if (name.toLowerCase() === 'style') {
                        const modifiedValue = processCssUrls(value);
                        return originalSetAttribute.call(this, name, modifiedValue);
                    }
                    
                    return originalSetAttribute.call(this, name, value);
                } catch (error) {
                    logError(error, 'SetAttribute拦截');
                    return originalSetAttribute.call(this, name, value);
                }
            };
        } catch (error) {
            logError(error, 'SetAttribute hook');
        }
    }
    
    // 处理现有的链接和资源
    function processExistingElements() {
        try {
            // 处理链接
            const links = document.querySelectorAll('a[href]');
            links.forEach(link => {
                const originalHref = link.getAttribute('href');
                if (originalHref && shouldProxy(originalHref)) {
                    const fullUrl = new URL(originalHref, location.href).href;
                    const modifiedUrl = getModifiedUrl(fullUrl);
                    link.setAttribute('href', modifiedUrl);
                    log('Link href转换:', originalHref, '->', modifiedUrl);
                }
            });
            
            // 处理图片
            const images = document.querySelectorAll('img[src]');
            images.forEach(img => {
                const originalSrc = img.getAttribute('src');
                if (originalSrc && shouldProxy(originalSrc)) {
                    const modifiedSrc = getModifiedUrl(originalSrc);
                    img.setAttribute('src', modifiedSrc);
                    log('Image src转换:', originalSrc, '->', modifiedSrc);
                }
            });
            
            // 处理CSS背景图片
            const elementsWithBackground = document.querySelectorAll('[style*="background"]');
            elementsWithBackground.forEach(el => {
                const style = el.getAttribute('style');
                if (style) {
                    const modifiedStyle = processCssUrls(style);
                    if (modifiedStyle !== style) {
                        el.setAttribute('style', modifiedStyle);
                        log('Background style转换');
                    }
                }
            });
            
            // 处理其他资源
            const resourceSelectors = [
                'script[src]', 'link[href]', 'iframe[src]', 
                'video[src]', 'audio[src]', 'source[src]',
                'embed[src]', 'object[data]'
            ];
            
            resourceSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const attr = selector.includes('[src]') ? 'src' : 
                                selector.includes('[href]') ? 'href' : 'data';
                    const originalUrl = el.getAttribute(attr);
                    if (originalUrl && shouldProxy(originalUrl)) {
                        const modifiedUrl = getModifiedUrl(originalUrl);
                        el.setAttribute(attr, modifiedUrl);
                        log(`${el.tagName} ${attr}转换:`, originalUrl, '->', modifiedUrl);
                    }
                });
            });
            
        } catch (error) {
            logError(error, '处理现有元素');
        }
    }
    
    // 使用MutationObserver监听DOM变化
    function observeDocumentChanges() {
        try {
            if (!window.MutationObserver) return;
            
            const observer = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    // 处理新添加的节点
                    mutation.addedNodes.forEach(function(node) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            processNewElement(node);
                        }
                    });
                    
                    // 处理属性变化
                    if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
                        processAttributeChange(mutation.target, mutation.attributeName, mutation.oldValue);
                    }
                });
            });
            
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeOldValue: true,
                attributeFilter: ['src', 'href', 'action', 'style', 'data', 'poster', 'background']
            });
            
            log('DOM观察器已启动');
        } catch (error) {
            logError(error, 'DOM观察器');
        }
    }
    
    function processNewElement(element) {
        try {
            // 处理单个元素
            const tag = element.tagName.toLowerCase();
            const urlAttributes = {
                'a': 'href',
                'img': 'src',
                'script': 'src',
                'link': 'href',
                'iframe': 'src',
                'video': 'src',
                'audio': 'src',
                'source': 'src',
                'embed': 'src',
                'object': 'data',
                'form': 'action'
            };
            
            if (urlAttributes[tag]) {
                const attr = urlAttributes[tag];
                const url = element.getAttribute(attr);
                if (url && shouldProxy(url)) {
                    const modifiedUrl = getModifiedUrl(url);
                    element.setAttribute(attr, modifiedUrl);
                    log(`新元素 ${tag} ${attr}转换:`, url, '->', modifiedUrl);
                }
            }
            
            // 处理style属性
            const style = element.getAttribute('style');
            if (style) {
                const modifiedStyle = processCssUrls(style);
                if (modifiedStyle !== style) {
                    element.setAttribute('style', modifiedStyle);
                    log('新元素style转换');
                }
            }
            
            // 递归处理子元素
            const childElements = element.querySelectorAll('*');
            childElements.forEach(child => {
                processNewElement(child);
            });
            
        } catch (error) {
            logError(error, '处理新元素');
        }
    }
    
    function processAttributeChange(element, attributeName, oldValue) {
        try {
            if (!attributeName) return;
            
            const urlAttributes = ['src', 'href', 'action', 'data', 'poster', 'background'];
            const newValue = element.getAttribute(attributeName);
            
            if (urlAttributes.includes(attributeName.toLowerCase()) && newValue && shouldProxy(newValue)) {
                const modifiedUrl = getModifiedUrl(newValue);
                if (modifiedUrl !== newValue) {
                    element.setAttribute(attributeName, modifiedUrl);
                    log(`属性变化 ${attributeName}转换:`, newValue, '->', modifiedUrl);
                }
            }
            
            if (attributeName.toLowerCase() === 'style' && newValue) {
                const modifiedStyle = processCssUrls(newValue);
                if (modifiedStyle !== newValue) {
                    element.setAttribute(attributeName, modifiedStyle);
                    log('Style属性变化转换');
                }
            }
        } catch (error) {
            logError(error, '处理属性变化');
        }
    }
    
    // 错误恢复机制
    function setupErrorRecovery() {
        window.addEventListener('error', function(event) {
            if (event.error && event.error.message && event.error.message.includes('Gproxy')) {
                logError(event.error, '全局错误');
                // 尝试重新初始化关键功能
                setTimeout(initializeHooks, 1000);
            }
        });
        
        window.addEventListener('unhandledrejection', function(event) {
            if (event.reason && event.reason.message && event.reason.message.includes('Gproxy')) {
                logError(event.reason, '未处理的Promise拒绝');
            }
        });
    }
    
    // 性能监控
    function setupPerformanceMonitoring() {
        if (DEBUG) {
            setInterval(() => {
                const uptime = Date.now() - stats.startTime;
                log('性能统计:', {
                    运行时间: `${Math.round(uptime / 1000)}秒`,
                    处理URL数: stats.processedUrls,
                    缓存命中: stats.cachedHits,
                    错误数: stats.errors,
                    缓存大小: urlCache.size
                });
            }, 30000); // 每30秒输出一次统计
        }
    }
    
    // 初始化所有Hook
    function initializeHooks() {
        try {
            log('初始化增强代理拦截器...');
            
            // 基础API Hook
            hookImageSrc();
            hookWindowOpen();
            hookPostMessage();
            hookSetAttribute();
            hookStyleSheet();
            
            // 等待DOM加载完成后处理静态元素
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function() {
                    processExistingElements();
                    observeDocumentChanges();
                });
            } else {
                processExistingElements();
                observeDocumentChanges();
            }
            
            // 设置错误恢复和性能监控
            setupErrorRecovery();
            setupPerformanceMonitoring();
            
            log('增强代理拦截器初始化完成');
        } catch (error) {
            logError(error, '初始化');
        }
    }
    
    // 启动
    try {
        initializeHooks();
    } catch (error) {
        logError(error, '启动失败');
    }
    
    // 暴露调试接口和公共API
    window.GproxyEnhanced = {
        // 调试接口
        debug: DEBUG ? {
            getModifiedUrl: getModifiedUrl,
            shouldProxy: shouldProxy,
            safeBase64Encode: safeBase64Encode,
            processCssUrls: processCssUrls,
            stats: stats,
            urlCache: urlCache
        } : null,
        
        // 公共API
        version: '2.0.0',
        isEnabled: true,
        globalProxyPath: GLOBAL_PROXY_PATH,
        
        // 手动处理URL的方法
        proxyUrl: getModifiedUrl,
        
        // 清理缓存的方法
        clearCache: function() {
            urlCache.clear();
            log('URL缓存已清理');
        },
        
        // 获取统计信息
        getStats: function() {
            return { ...stats };
        }
    };
    
})(); 