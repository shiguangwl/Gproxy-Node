class ProxyError extends Error {
  constructor(message, statusCode, originalError = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.originalError = originalError; 
  }
}

class InvalidTargetUrlError extends ProxyError {
  constructor(message = '无效的目标URL', originalError = null) {
    super(message, 400, originalError);
  }
}

class AccessDeniedError extends ProxyError {
  constructor(message = '访问被拒绝', originalError = null) {
    super(message, 403, originalError);
  }
}

class TargetNotFoundError extends ProxyError { // For ENOTFOUND
  constructor(message = '无法解析目标服务器', originalError = null) {
    super(message, 502, originalError);
  }
}

class TargetConnectionRefusedError extends ProxyError { // For ECONNREFUSED
  constructor(message = '目标服务器拒绝连接', originalError = null) {
    super(message, 502, originalError);
  }
}

class RequestTimeoutError extends ProxyError { // For ETIMEDOUT
  constructor(message = '请求超时', originalError = null) {
    super(message, 504, originalError);
  }
}

// Можно добавить и другие特定类型的错误，例如配置错误等
class ConfigurationError extends ProxyError {
  constructor(message = '配置错误', originalError = null) {
    super(message, 500, originalError); // 通常配置错误是服务器内部问题
  }
}

// It's better to define these here if they are specific to entity parsing
class InvalidUrlError extends ProxyError {
  constructor(message = '无效的URL', originalError = null) {
    super(message, 400, originalError); // Typically a client-side error if URL is from user input
  }
}

class RequestConversionError extends ProxyError {
  constructor(message = '请求转换失败', originalError = null) {
    super(message, 500, originalError); // Internal server error during conversion
  }
}

class HandlerError extends ProxyError {
  constructor(message = '处理程序执行失败', handlerName = 'UnknownHandler', originalError = null) {
    super(message, 500, originalError); // Default to 500 for internal handler errors
    this.handlerName = handlerName;
    this.name = 'HandlerError';
  }
}

module.exports = {
  ProxyError,
  InvalidTargetUrlError,
  AccessDeniedError,
  TargetNotFoundError,
  TargetConnectionRefusedError,
  RequestTimeoutError,
  ConfigurationError,
  InvalidUrlError,
  RequestConversionError,
  HandlerError
}; 