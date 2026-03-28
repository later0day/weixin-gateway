#!/usr/bin/env node
'use strict';

/**
 * weixin-gateway 快速上手 — 多媒体发送演示
 * 用法：node examples/quickstart.js
 *
 * 启动后显示二维码，扫码登录后向机器人发送指令：
 *   voice  — TTS 语音气泡
 *   image  — 图片（HTTP URL）
 *   video  — 视频（ffmpeg 本地生成，无需 yt-dlp）
 *   file   — 文件
 *   all    — 上述全部
 */

const { createWeixinGateway, MemoryAdapter } = require('..');
const { execFileSync } = require('child_process');
const fs = require('fs');

function makeTestVideo() {
  const out = '/tmp/weixin-test-video.mp4';
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'testsrc=duration=3:size=320x240:rate=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      out,
    ], { stdio: 'pipe' });
    return out;
  } catch (e) {
    console.error('[TEST] ffmpeg video gen failed:', e.message);
    return null;
  }
}

const gw = createWeixinGateway({
  storage: new MemoryAdapter(),
  onMessage: async ({ wxId, text, media }) => {
    const cmd = (text || '').trim().toLowerCase();
    console.log(`[IN]  ${wxId}: ${text || `[${media?.type}]`}`);

    if (cmd === 'voice') {
      await gw.sendVoice(wxId, '这是一条 TTS 语音消息，weixin-gateway 多媒体发送测试。');
      return null;
    }

    if (cmd === 'image') {
      await gw.sendImage(wxId, 'https://picsum.photos/400/300');
      return null;
    }

    if (cmd === 'video') {
      const vid = makeTestVideo();
      if (!vid) return { text: 'ffmpeg 生成视频失败' };
      await gw.sendVideo(wxId, vid);
      return null;
    }

    if (cmd === 'file') {
      const tmpFile = '/tmp/weixin-test-file.txt';
      fs.writeFileSync(tmpFile, 'weixin-gateway 文件发送测试\n时间：' + new Date().toISOString());
      await gw.sendFile(wxId, tmpFile);
      return null;
    }

    if (cmd === 'all') {
      await gw.sendText(wxId, '开始全套测试：文字 → 语音 → 图片 → 视频 → 文件');
      await gw.sendVoice(wxId, '语音测试通过。');
      await gw.sendImage(wxId, 'https://picsum.photos/400/300');
      const vid = makeTestVideo();
      if (vid) {
        await gw.sendVideo(wxId, vid);
      } else {
        await gw.sendText(wxId, '⚠️ 视频生成失败（ffmpeg 未安装）');
      }
      const tmpFile = '/tmp/weixin-test-file.txt';
      fs.writeFileSync(tmpFile, 'weixin-gateway file test\n' + new Date().toISOString());
      await gw.sendFile(wxId, tmpFile);
      await gw.sendText(wxId, '✅ 全套测试完成');
      return null;
    }

    return { text: `收到：${text || '[媒体]'}\n\n指令：voice / image / video / file / all` };
  },
});

gw.subscribe(event => {
  if (event.type === 'qr') {
    console.log('\n── 请扫描二维码登录 ──');
    console.log(event.qrUrl);
    console.log('───────────────────────\n');
  }
  if (event.type === 'status') console.log(`[状态] ${event.state}`);
});

console.log('启动 weixin-gateway v' + require('../package.json').version);
gw.start().catch(err => { console.error('启动失败：', err.message); process.exit(1); });
