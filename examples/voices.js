#!/usr/bin/env node
'use strict';

/**
 * 多音色语音推送演示
 * 启动后自动 token 重连（无需扫码），收到第一条消息后立即推送多条不同音色语音。
 * 用法：node examples/voices.js
 */

const { createWeixinGateway, MemoryAdapter } = require('weixin-gateway');
const { resolveVoice } = require('weixin-gateway/lib/voice');

// 要演示的音色列表：[别名, 文字内容]
const DEMO_VOICES = [
  ['晓晓', '你好，我是晓晓，温暖自然的普通话女声。'],
  ['云扬', '你好，我是云扬，专业播报风格。'],
  ['东北', '整这个有点意思，我是东北话的晓北。'],
  ['台湾', '你好，我是台灣腔的曉晨，請多指教。'],
  ['晓佳', '你好，我係曉佳，講廣東話㗎。'],
  ['emma', 'Hi, this is Emma, a multilingual voice that switches naturally between Chinese and English.'],
];

const delay = ms => new Promise(r => setTimeout(r, ms));

let demoDone = false;

const gw = createWeixinGateway({
  storage: new MemoryAdapter(),
  onMessage: async ({ wxId, text }) => {
    console.log(`[IN] ${wxId.slice(-8)}: ${text}`);

    if (demoDone) return { text: '演示已完成 ✅' };

    demoDone = true;
    await gw.sendText(wxId, `开始推送 ${DEMO_VOICES.length} 种音色，稍等…`);
    await delay(500);

    for (const [alias, content] of DEMO_VOICES) {
      const voice = resolveVoice(alias);
      console.log(`[TTS] ${alias} (${voice})`);
      try {
        await gw.sendVoice(wxId, content, voice);
        console.log(`[OK] ${alias}`);
      } catch (e) {
        console.error(`[ERR] ${alias}: ${e.message ?? e}`);
        await gw.sendText(wxId, `⚠️ ${alias} 发送失败：${e.message ?? e}`);
      }
      await delay(800);
    }

    await gw.sendText(wxId, '✅ 全部音色推送完毕');
    return null;
  },
});

gw.subscribe(event => {
  if (event.type === 'qr') {
    console.log('\n── 请扫描二维码 ──');
    console.log(event.qrUrl);
    console.log('──────────────────\n');
  }
  if (event.type === 'status') console.log(`[状态] ${event.state}`);
});

(async () => {
  console.log('尝试 token 免扫码重连…');
  await gw.startIfLoggedIn({ _dummy: true });

  await delay(3000);
  const { state } = gw.getStatus();
  if (state !== 'connected') {
    console.log('token 重连失败，走扫码流程…');
    await gw.start();
  } else {
    console.log('[已连接] 请发一条微信消息触发音色演示');
  }
})().catch(err => { console.error('启动失败:', err.message); process.exit(1); });
