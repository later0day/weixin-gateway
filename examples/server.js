#!/usr/bin/env node
'use strict';

/**
 * weixin-gateway 最简示例
 * 用法: node examples/server.js
 *
 * 连接成功并收到第一条微信消息后，contextToken 会自动落盘到：
 *   /tmp/weixin-gateway-session.json
 *
 * 多媒体测试示例（连接后在另一个终端运行）：
 *   curl -s -X POST http://localhost:3099/weixin/push-demo | jq
 *   curl -s -X POST http://localhost:3099/weixin/tts -H 'Content-Type: application/json' \
 *        -d '{"text":"你好，这是语音测试"}' | jq
 */

const http    = require('http');
const fs      = require('fs');
const express = require('express');
const QRCode  = require('qrcode');
const { createWeixinRouter, MemoryAdapter } = require('..');

// contextToken 落盘路径（供 push-demo / tts 等手动测试读取）
const TOKEN_FILE = '/tmp/weixin-gateway-session.json';

const app = express();
app.use(express.json());

const { router, autoStartIfLoggedIn } = createWeixinRouter({
  storage: new MemoryAdapter(),
  getWorkDir: () => process.cwd(),
});

app.use('/weixin', router);
app.get('/', (_req, res) => res.send('<h2>weixin-gateway</h2><p>GET /weixin/status</p>'));

// ── 启动 ──────────────────────────────────────────────────────────────────────

const PORT   = process.env.PORT || 3099;
const server = http.createServer(app);

// 跟踪所有活跃连接，Ctrl+C 时强制关闭
const connections = new Set();
server.on('connection', (conn) => {
  connections.add(conn);
  conn.on('close', () => connections.delete(conn));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`[server] 端口 ${PORT} 已被占用，请先执行：lsof -ti:${PORT} | xargs kill`);
  else
    console.error('[server] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, async () => {
  console.log(`\n[server] http://localhost:${PORT}`);
  console.log('[server] 正在启动微信登录...\n');

  // 订阅 SSE，把二维码打到终端
  const sseReq = http.get(`http://127.0.0.1:${PORT}/weixin/qr-sse`, (res) => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const { qrUrl } = JSON.parse(line.slice(5).trim());
          if (!qrUrl) continue;
          if (qrUrl.startsWith('data:image/')) {
            console.log('\n[QR] 在浏览器打开查看二维码：');
            console.log(`data:text/html,<img src="${qrUrl.slice(0, 100)}..." />`);
          } else {
            QRCode.toString(qrUrl, { type: 'terminal', small: true }, (err, str) => {
              if (!err) { process.stdout.write('\x1Bc'); console.log(str); }
            });
          }
          console.log('请用微信扫描上方二维码\n');
        } catch {}
      }
    });
  });
  sseReq.on('error', () => {});

  // 触发登录
  await new Promise(r => setTimeout(r, 300));
  const doStart = () => {
    const req = http.request(
      { port: PORT, method: 'POST', path: '/weixin/start', headers: { 'Content-Type': 'application/json' } },
      (res) => res.resume()
    );
    req.end(JSON.stringify({ preset: 'shell' }));
  };

  // 先试 token 自动重连，300ms 内没连上就走扫码
  autoStartIfLoggedIn({ type: 'shell' }).then(() => {
    setTimeout(async () => {
      const { state } = await fetch(`http://127.0.0.1:${PORT}/weixin/status`).then(r => r.json()).catch(() => ({}));
      if (state !== 'connected') doStart();
    }, 300);
  }).catch(() => doStart());
});

// ── 状态轮询 + contextToken 落盘 ──────────────────────────────────────────────

let lastState       = '';
let savedTokens     = {};   // wxId → contextToken（已落盘的快照，用于去重）

const poller = setInterval(async () => {
  let data;
  try {
    data = await fetch(`http://127.0.0.1:${PORT}/weixin/status`).then(r => r.json());
  } catch { return; }

  const { state, userInfo, sessions = [] } = data;

  // 状态变化日志
  if (state !== lastState) {
    lastState = state;
    if (state === 'connected') {
      const who = userInfo?.nickName || sessions?.[0]?.wxId || '未知';
      console.log(`\n[server] ✅ 登录成功：${who}`);
      console.log('[server] 发送任意微信消息后，contextToken 将自动落盘');
      console.log(`[server] Token 文件：${TOKEN_FILE}`);
      console.log('[server] 多媒体测试：');
      console.log(`  curl -s -X POST http://localhost:${PORT}/weixin/push-demo | jq`);
      console.log(`  curl -s -X POST http://localhost:${PORT}/weixin/tts -H 'Content-Type: application/json' -d '{"text":"你好"}' | jq\n`);
    } else if (state === 'idle' && lastState) {
      console.log('\n[server] 已断开');
      // 清理落盘文件
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      savedTokens = {};
    }
  }

  // contextToken 落盘：检测新增或变化的 token
  if (state !== 'connected') return;

  let changed = false;
  const snapshot = {};

  for (const s of sessions) {
    if (!s.contextToken) continue;
    snapshot[s.wxId] = s.contextToken;
    if (savedTokens[s.wxId] !== s.contextToken) {
      changed = true;
      if (!savedTokens[s.wxId]) {
        console.log(`[server] 📌 contextToken 已获取：${s.nickname || s.wxId}`);
      }
    }
  }

  if (changed && Object.keys(snapshot).length > 0) {
    const payload = {
      updatedAt:  new Date().toISOString(),
      baseUrl:    `http://localhost:${PORT}/weixin`,
      accountId:  data.accountId || null,
      sessions:   sessions
        .filter(s => s.contextToken)
        .map(s => ({
          wxId:         s.wxId,
          nickname:     s.nickname,
          contextToken: s.contextToken,
          lastActive:   s.lastActive,
        })),
    };
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf8');
      console.log(`[server] 💾 Token 已落盘 → ${TOKEN_FILE}  (${payload.sessions.length} 个会话)`);
    } catch (err) {
      console.error('[server] Token 落盘失败:', err.message);
    }
    savedTokens = snapshot;
  }
}, 2000);

// Ctrl+C — 强制关闭所有连接再退出
process.on('SIGINT', () => {
  console.log('\n[server] 退出');
  clearInterval(poller);
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  for (const conn of connections) conn.destroy();
  server.close(() => process.exit(0));
});
