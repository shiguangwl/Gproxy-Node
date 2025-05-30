#!/usr/bin/env node

// 测试Base64编码URL功能
const axios = require('axios');

// Base64编码函数（与前端相同）
function safeBase64Encode(str) {
  try {
    return Buffer.from(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
      function toSolidBytes(match, p1) {
        return String.fromCharCode('0x' + p1);
      })).toString('base64');
  } catch (error) {
    console.error('Base64编码失败:', error);
    return encodeURIComponent(str);
  }
}

async function testProxyUrl() {
  const baseUrl = 'http://localhost:8000';
  const globalProxyPath = 'proxy-dGltZWhv';
  
  // 测试复杂的YouTube视频URL
  const complexUrl = 'https://rr2---sn-q4fl6ns7.googlevideo.com/videoplayback?expire=2336722527&ei=bbHMGsNtdqtccbRPG-yrwiy&ip=51.69.40.11&id=o-AFeZP7o2UYlfwvnFujVddgBBnqDHEXOK0wDOycRzaD3oC&itag=18&source=youtube&requiressl=yes&mh=X6&mm=930%2C69886%2C26663&mn=N37Y3%2C3OZfp%2CjS7Zu&ms=N37Y3%2C3OZfp%2CjS7Zu&mv=A&mvi=0&pl=43&initcwndbps=7091216&siu=0&spc=zM0FvjCjA6oCKpAvNorCR8fj9ZTKM9OMXmfRFSWM25FH&vprv=0&svpuc=0&mime=video%2Fmp4&ns=LlD9bKTSMWEhoYbFnXMylXt0&cnr=43&ratebypass=yes&dur=90762088&lmt=0085738087258006&mt=2336722527&fvip=3&c=WEB&txp=7091216&n=IWTE5NMEuEyO71Qk&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Csiu%2Cspc%2Cvprv%2Csvpuc%2Cmime%2Cns%2Ccnr%2Cratebypass%2Cdur%2Clmt&sig=niwRjaBUOfbK3H0N8KFv3-VvzEGgf1z1CFvyqH-I9aQGfP2l0izBjmvamyvcgy3zzA1xbQKhBh7Bxi8or3mAP6hSfeZ8hgbbUZUkDIFCBwAc&lsparams=mh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl%2Cinitcwndbps&lsig=niwRjaBUOfbK3H0N8KFv3-VvzEGgf1z1CFvyqH-I9aQGfP2l0izBjmvamyvcgy3zzA1xbQKhBh7Bxi8or3mAP6hSfeZ8hgbbUZUkDIFCBwAc';
  
  console.log('🧪 测试复杂URL的Base64编码代理...\n');
  
  console.log('原始URL:');
  console.log(complexUrl + '\n');
  
  // 编码URL
  const encodedUrl = safeBase64Encode(complexUrl);
  console.log('Base64编码后:');
  console.log(encodedUrl + '\n');
  
  // 构建代理URL
  const proxyUrl = `${baseUrl}/${globalProxyPath}/${encodedUrl}`;
  console.log('代理URL:');
  console.log(proxyUrl + '\n');
  
  try {
    console.log('📡 发送HEAD请求测试...');
    const response = await axios.head(proxyUrl, {
      timeout: 10000,
      validateStatus: function (status) {
        return status < 500; // 接受4xx错误，但不接受5xx错误
      }
    });
    
    console.log('✅ 请求成功!');
    console.log('状态码:', response.status);
    console.log('响应头部:');
    Object.entries(response.headers).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
    
    if (response.status === 200) {
      console.log('\n🎉 Base64编码代理功能正常工作!');
    } else if (response.status === 403) {
      console.log('\n⚠️  收到403错误，可能需要更多的头部优化');
    } else {
      console.log('\n📊 收到状态码:', response.status);
    }
    
  } catch (error) {
    if (error.response) {
      console.log('❌ 请求失败');
      console.log('状态码:', error.response.status);
      console.log('错误信息:', error.response.data);
    } else {
      console.log('❌ 网络错误:', error.message);
    }
  }
}

// 测试简单URL
async function testSimpleUrl() {
  const baseUrl = 'http://localhost:8000';
  const globalProxyPath = 'proxy-dGltZWhv';
  
  console.log('\n🧪 测试简单URL...\n');
  
  const simpleUrl = 'https://www.example.com/';
  const encodedUrl = safeBase64Encode(simpleUrl);
  const proxyUrl = `${baseUrl}/${globalProxyPath}/${encodedUrl}`;
  
  console.log('原始URL:', simpleUrl);
  console.log('代理URL:', proxyUrl);
  
  try {
    const response = await axios.get(proxyUrl, {
      timeout: 10000,
      validateStatus: function (status) {
        return status < 500;
      }
    });
    
    console.log('✅ 简单URL测试成功!');
    console.log('状态码:', response.status);
    console.log('内容长度:', response.data.length);
    
  } catch (error) {
    if (error.response) {
      console.log('❌ 简单URL测试失败');
      console.log('状态码:', error.response.status);
    } else {
      console.log('❌ 网络错误:', error.message);
    }
  }
}

// 运行测试
async function runTests() {
  console.log('🚀 开始测试Gproxy-Node Base64编码功能\n');
  
  await testProxyUrl();
  await testSimpleUrl();
  
  console.log('\n✨ 测试完成!');
}

runTests().catch(console.error); 