#!/usr/bin/env node
'use strict';

/**
 * 全场景发送测试脚本 — 直接使用 SDK，无需 HTTP server
 *
 * 前提：
 *   1. node examples/server.js 已运行且已登录（写入 token 文件）
 *   2. 向微信机器人发过一条消息（contextToken 已落盘）
 *
 * 用法:
 *   node examples/full-test/index.js [options]
 *
 * 选项:
 *   --skip-voice         跳过语音测试
 *   --skip-video-url     跳过直链视频测试
 *   --skip-bilibili      跳过 Bilibili 测试
 *   --bilibili <url>     覆盖 Bilibili URL（默认 BV1GJ411x7h7）
 *
 * Token 文件：/tmp/weixin-gateway-session.json
 */

const fs              = require('fs');
const path            = require('path');
const os              = require('os');
const { execFile }    = require('child_process');
const QRCode          = require('qrcode');

const { createWeixinGateway, MemoryAdapter } = require('weixin-gateway');

const TOKEN_FILE = '/tmp/weixin-gateway-session.json';

const DEFAULT_BILIBILI_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';
const REMOTE_IMAGE_URL     = 'https://picsum.photos/400/300';
const REMOTE_VIDEO_URL     = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

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

// ── 命令行参数解析 ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    skipVoice:      args.includes('--skip-voice'),
    skipVideoUrl:   args.includes('--skip-video-url'),
    skipBilibili:   args.includes('--skip-bilibili'),
    bilibiliUrl:    DEFAULT_BILIBILI_URL,
  };
  const bIdx = args.indexOf('--bilibili');
  if (bIdx !== -1 && args[bIdx + 1]) {
    opts.bilibiliUrl = args[bIdx + 1];
  }
  return opts;
}

// ── 工具函数 ───────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function runFfmpeg(ffmpegArgs) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ffmpegArgs, { timeout: 30000 }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  console.log(`\n${C.bold}weixin-gateway 全场景测试（SDK 直连）${C.reset}`);
  console.log(dim(`Token 文件：${TOKEN_FILE}`));

  // 1. 读取 token
  const payload = loadTokenFile();
  const session = payload.sessions[0];
  const { wxId, nickname, contextToken } = session;
  const { accountId } = payload;

  console.log(info(`目标用户：${nickname || wxId}  (${dim(wxId)})`));
  console.log(info(`accountId：${dim(accountId)}`));
  console.log(dim(`落盘时间：${payload.updatedAt}`));

  if (opts.skipVoice)    console.log(dim('  [跳过] 语音测试'));
  if (opts.skipVideoUrl) console.log(dim('  [跳过] 直链视频测试'));
  if (opts.skipBilibili) console.log(dim('  [跳过] Bilibili 测试'));

  // 2. 创建 gateway 并注入已有凭证（无需扫码/HTTP server）
  const gw = createWeixinGateway({ storage: new MemoryAdapter() });
  gw.restore(accountId, payload.sessions);

  // ── 场景 1: 普通文本 ──────────────────────────────────────────────────────────
  printSection('1/8  TEXT — 普通文本');
  try {
    await gw.sendText(wxId, `全场景测试：纯文本消息 ✅\n${new Date().toLocaleString('zh-CN')}`);
    console.log(' ', ok('TEXT: OK'));
  } catch (err) {
    console.error(' ', fail(`TEXT: ${err.message}`));
  }
  await delay(600);

  // ── 场景 2: TTS 语音气泡 ──────────────────────────────────────────────────────
  printSection('2/8  VOICE — TTS → SILK 语音气泡');
  if (opts.skipVoice) {
    console.log(' ', dim('已跳过（--skip-voice）'));
  } else {
    const voiceText = '你好，这是语音测试，来自 weixin-gateway 全场景脚本。';
    try {
      await gw.sendVoice(wxId, voiceText);
      console.log(' ', ok(`VOICE: OK  "${voiceText.slice(0, 20)}..."`));
    } catch (err) {
      console.error(' ', fail(`VOICE: ${err.message}`));
    }
    await delay(1500);
  }

  // ── 场景 3: 远程图片 URL ──────────────────────────────────────────────────────
  printSection('3/8  IMAGE (remote URL) — picsum.photos');
  try {
    console.log(' ', info(`URL: ${REMOTE_IMAGE_URL}`));
    await gw.sendImage(wxId, REMOTE_IMAGE_URL);
    console.log(' ', ok('IMAGE (url): OK'));
  } catch (err) {
    console.error(' ', fail(`IMAGE (url): ${err.message}`));
  }
  await delay(800);

  // ── 场景 4: 本地图片（qrcode 生成 PNG）────────────────────────────────────────
  printSection('4/8  IMAGE (local file) — qrcode PNG');
  const imgPath = path.join(os.tmpdir(), `weixin-fulltest-${Date.now()}.png`);
  try {
    const buf = await QRCode.toBuffer('weixin-gateway full-test', { margin: 2, width: 300 });
    fs.writeFileSync(imgPath, buf);
    const sizeMB = (fs.statSync(imgPath).size / 1024).toFixed(1);
    console.log(' ', info(`generated ${sizeMB} KB PNG → ${imgPath}`));
    await gw.sendImage(wxId, imgPath);
    console.log(' ', ok('IMAGE (local): OK'));
  } catch (err) {
    console.error(' ', fail(`IMAGE (local): ${err.message}`));
  } finally {
    try { fs.unlinkSync(imgPath); } catch {}
  }
  await delay(800);

  // ── 场景 5: 直链 MP4 URL ─────────────────────────────────────────────────────
  printSection('5/8  VIDEO (direct URL) — GCS public domain clip');
  if (opts.skipVideoUrl) {
    console.log(' ', dim('已跳过（--skip-video-url）'));
  } else {
    try {
      console.log(' ', info(`URL: ${REMOTE_VIDEO_URL}`));
      await gw.sendVideo(wxId, REMOTE_VIDEO_URL);
      console.log(' ', ok('VIDEO (url): OK'));
    } catch (err) {
      console.error(' ', fail(`VIDEO (url): ${err.message}`));
    }
    await delay(1000);
  }

  // ── 场景 6: 本地 MP4（ffmpeg 生成蓝色色块 2s）────────────────────────────────
  printSection('6/8  VIDEO (local ffmpeg) — 蓝色色块 2s');
  const videoPath = path.join(os.tmpdir(), `weixin-fulltest-${Date.now()}.mp4`);
  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k',
      videoPath,
    ]);
    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(2);
    console.log(' ', info(`generated ${sizeMB} MB video → ${videoPath}`));
    await gw.sendVideo(wxId, videoPath);
    console.log(' ', ok('VIDEO (local): OK'));
  } catch (err) {
    console.error(' ', fail(`VIDEO (local): ${err.message}`));
  } finally {
    try { fs.unlinkSync(videoPath); } catch {}
  }
  await delay(1000);

  // ── 场景 7: Bilibili 链接 ──────────────────────────────────────────────────────
  printSection('7/8  VIDEO (bilibili URL)');
  if (opts.skipBilibili) {
    console.log(' ', dim('已跳过（--skip-bilibili）'));
  } else {
    try {
      console.log(' ', info(`URL: ${opts.bilibiliUrl}`));
      await gw.sendVideo(wxId, opts.bilibiliUrl);
      console.log(' ', ok('VIDEO (bilibili): OK'));
    } catch (err) {
      console.error(' ', fail(`VIDEO (bilibili): ${err.message}`));
    }
    await delay(1000);
  }

  // ── 场景 8: 本地文件（txt）────────────────────────────────────────────────────
  printSection('8/8  FILE — 本地 txt 文件');
  const filePath = path.join(os.tmpdir(), `weixin-fulltest-${Date.now()}.txt`);
  try {
    fs.writeFileSync(
      filePath,
      `weixin-gateway 全场景测试\n时间：${new Date().toISOString()}\n场景 8/8：sendFile 本地文件`,
      'utf8'
    );
    const sizeMB = (fs.statSync(filePath).size / 1024).toFixed(1);
    console.log(' ', info(`generated ${sizeMB} KB txt → ${filePath}`));
    await gw.sendFile(wxId, filePath);
    console.log(' ', ok('FILE: OK'));
  } catch (err) {
    console.error(' ', fail(`FILE: ${err.message}`));
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }

  console.log(`\n${C.bold}全场景测试完成${C.reset}\n`);
}

main().catch(err => {
  console.error(fail(`未捕获错误：${err.message}`));
  process.exit(1);
});
