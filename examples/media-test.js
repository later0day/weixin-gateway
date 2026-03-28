#!/usr/bin/env node
'use strict';

/**
 * 多媒体发送测试脚本 — 直接使用 SDK，无需 HTTP server
 *
 * 前提：
 *   1. node examples/server.js 已运行且已登录（写入 token 文件）
 *   2. 向微信机器人发过一条消息（contextToken 已落盘）
 *
 * 用法: node examples/media-test.js [--voice-only | --no-voice]
 *
 * Token 文件：/tmp/weixin-gateway-session.json
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const QRCode = require('qrcode');

const { createWeixinGateway, MemoryAdapter } = require('..');

const TOKEN_FILE = '/tmp/weixin-gateway-session.json';

// ── ANSI 颜色 ─────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
const ok   = (s) => `${C.green}✓${C.reset} ${s}`;
const fail = (s) => `${C.red}✗${C.reset} ${s}`;
const info = (s) => `${C.cyan}→${C.reset} ${s}`;
const dim  = (s) => `${C.gray}${s}${C.reset}`;

function printSection(title) {
  console.log(`\n${C.bold}${C.cyan}── ${title} ──${C.reset}`);
}

// ── 读取 token 文件 ────────────────────────────────────────────────────────────

function loadTokenFile() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(fail(`Token 文件不存在：${TOKEN_FILE}`));
    console.error(dim('  请先运行 node examples/server.js 并向微信机器人发送一条消息'));
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error(fail(`Token 文件解析失败：${e.message}`));
    process.exit(1);
  }
  if (!payload.sessions?.length) {
    console.error(fail('Token 文件中无有效 session，请先向微信机器人发一条消息'));
    process.exit(1);
  }
  if (!payload.accountId) {
    console.error(fail('Token 文件缺少 accountId，请重启 server.js 后重新发一条消息'));
    process.exit(1);
  }
  return payload;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const voiceOnly = args.includes('--voice-only');
  const noVoice   = args.includes('--no-voice');

  console.log(`\n${C.bold}weixin-gateway 多媒体测试（SDK 直连）${C.reset}`);
  console.log(dim(`Token 文件：${TOKEN_FILE}`));

  // 1. 读取 token
  const payload = loadTokenFile();
  const session = payload.sessions[0];
  const { wxId, nickname, contextToken } = session;
  const { accountId } = payload;

  console.log(info(`目标用户：${nickname || wxId}  (${dim(wxId)})`));
  console.log(info(`accountId：${dim(accountId)}`));
  console.log(dim(`落盘时间：${payload.updatedAt}`));

  // 2. 创建 gateway 并注入已有凭证（无需扫码/HTTP server）
  const gw = createWeixinGateway({ storage: new MemoryAdapter() });
  gw.restore(accountId, payload.sessions);

  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // 3. TEXT
  if (!voiceOnly) {
    printSection('TEXT');
    try {
      await gw.sendText(wxId, `SDK 测试：纯文本消息 ✅\n${new Date().toLocaleString('zh-CN')}`);
      console.log(' ', ok('TEXT: OK'));
    } catch (err) { console.error(' ', fail(`TEXT: ${err.message}`)); }
    await delay(600);
  }

  // 4. IMAGE — QR code PNG
  if (!voiceOnly) {
    printSection('IMAGE');
    const imgPath = path.join(os.tmpdir(), `weixin-test-${Date.now()}.png`);
    try {
      const buf = await QRCode.toBuffer('weixin-gateway sdk test', { margin: 2, width: 200 });
      fs.writeFileSync(imgPath, buf);
      await gw.sendImage(wxId, imgPath);
      console.log(' ', ok('IMAGE: OK'));
    } catch (err) { console.error(' ', fail(`IMAGE: ${err.message}`)); }
    finally { try { fs.unlinkSync(imgPath); } catch {} }
    await delay(600);
  }

  // 5. FILE
  if (!voiceOnly) {
    printSection('FILE');
    const filePath = path.join(os.tmpdir(), `weixin-test-${Date.now()}.txt`);
    try {
      fs.writeFileSync(filePath, `SDK 文件测试\n时间：${new Date().toISOString()}`, 'utf8');
      await gw.sendFile(wxId, filePath);
      console.log(' ', ok('FILE: OK'));
    } catch (err) { console.error(' ', fail(`FILE: ${err.message}`)); }
    finally { try { fs.unlinkSync(filePath); } catch {} }
    await delay(600);
  }

  // 6. VOICE — TTS
  if (!noVoice) {
    printSection('VOICE (TTS)');
    const texts = ['你好，这是语音测试', 'Hello from weixin-gateway SDK'];
    for (const text of texts) {
      try {
        await gw.sendVoice(wxId, text);
        console.log(' ', ok(`"${text.slice(0, 20)}"`));
      } catch (err) { console.error(' ', fail(`"${text.slice(0, 20)}"  ${err.message}`)); }
      await delay(1500);
    }
  }

  // 7. VIDEO — URL
  if (!voiceOnly) {
    printSection('VIDEO (URL)');
    // Small public domain test video
    const testVideoUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
    try {
      await gw.sendVideo(wxId, testVideoUrl);
      console.log(' ', ok('VIDEO: OK'));
    } catch (err) { console.error(' ', fail(`VIDEO: ${err.message}`)); }
  }

  console.log(`\n${C.bold}测试完成${C.reset}\n`);
}

main().catch(err => {
  console.error(fail(`未捕获错误：${err.message}`));
  process.exit(1);
});
