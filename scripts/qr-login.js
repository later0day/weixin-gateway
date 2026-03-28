#!/usr/bin/env node
'use strict';

/**
 * 快速测试微信扫码登录
 * 用法: node scripts/qr-login.js
 */

const express = require('express');
const http    = require('http');
const QRCode  = require('qrcode');
const { createWeixinRouter, MemoryAdapter } = require('..');

const app = express();
app.use(express.json());

const { router, autoStartIfLoggedIn } = createWeixinRouter({
  storage: new MemoryAdapter(),
});
app.use('/', router);

const server = http.createServer(app);
server.listen(0, async () => {
  const port = server.address().port;
  console.log(`[qr-login] server on :${port}`);

  // 订阅 SSE，等二维码
  const req = http.get(`http://127.0.0.1:${port}/qr-sse`, (res) => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const { qrUrl } = JSON.parse(line.slice(5));
          if (!qrUrl) continue;

          if (qrUrl.startsWith('data:image/')) {
            // 已是 data URL，从 base64 里拿回原始内容并重新渲染到终端
            // 直接用 qrUrl 里的二维码内容不好拿，改为通知用户打开浏览器
            console.log('\n[qr-login] 二维码 data URL（粘贴到浏览器查看）:');
            console.log(qrUrl.slice(0, 80) + '…');
          } else {
            // 原始 URL，直接在终端渲染
            QRCode.toString(qrUrl, { type: 'terminal', small: true }, (err, str) => {
              if (!err) { console.clear(); console.log(str); }
            });
          }
          console.log('[qr-login] 请用微信扫描二维码登录');
        } catch {}
      }
    });
  });

  req.on('error', err => console.error('[qr-login] SSE error:', err.message));

  // 触发登录
  await new Promise(r => setTimeout(r, 200));
  http.request({ port, method: 'POST', path: '/start',
    headers: { 'Content-Type': 'application/json' }
  }, () => {}).end(JSON.stringify({ preset: 'claude-code' }));

  console.log('[qr-login] 等待二维码… (Ctrl+C 退出)');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
