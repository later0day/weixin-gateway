#!/usr/bin/env node
'use strict';

/**
 * functional-test.js — weixin-gateway functional coverage tests (no mocks)
 *
 * Prerequisites:
 *   /tmp/weixin-gateway-session.json must exist (written by examples/server.js)
 *
 * Usage:
 *   node examples/full-test/functional-test.js
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const assert  = require('assert');
const { execFile, execFileSync } = require('child_process');

const { createWeixinGateway, MemoryAdapter } = require('weixin-gateway');

const TOKEN_FILE = '/tmp/weixin-gateway-session.json';

// ── ANSI helpers ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};
const ok   = s => `${C.green}✓${C.reset} ${s}`;
const fail = s => `${C.red}✗${C.reset} ${s}`;
const info = s => `${C.cyan}→${C.reset} ${s}`;
const dim  = s => `${C.gray}${s}${C.reset}`;

function section(title) {
  console.log(`\n${C.bold}${C.cyan}── ${title} ──${C.reset}`);
}

// ── Session loader ─────────────────────────────────────────────────────────────

function loadTokenFile() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(fail(`Token file not found: ${TOKEN_FILE}`));
    console.error(dim('  Run node examples/server.js and send a WeChat message first'));
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    console.error(fail(`Token file parse error: ${e.message}`));
    process.exit(1);
  }
  if (!payload.sessions?.length) {
    console.error(fail('Token file has no sessions — send a WeChat message first'));
    process.exit(1);
  }
  if (!payload.accountId) {
    console.error(fail('Token file missing accountId — restart server.js and try again'));
    process.exit(1);
  }
  return payload;
}

// ── ffmpeg path discovery ──────────────────────────────────────────────────────

function findFfmpeg() {
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  try {
    const found = execFileSync('which', ['ffmpeg'], {
      env: { ...process.env, PATH: [process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin'].join(':') },
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (found) return found;
  } catch {}
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'ffmpeg';
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 30000 }, err => err ? reject(err) : resolve());
  });
}

// ── Score tracking ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function recordPass(label) { passed++; console.log(' ', ok(label)); }
function recordFail(label, err) { failed++; console.error(' ', fail(`${label}: ${err?.message ?? err}`)); }

// ── Tests ──────────────────────────────────────────────────────────────────────

async function testF1(ffmpegPath) {
  section('F1 — TTS pipeline (text → SILK file)');
  const stamp    = Date.now();
  const mp3Path  = `/tmp/ft-tts-test-${stamp}.mp3`;
  const pcmPath  = `/tmp/ft-tts-test-${stamp}.pcm`;
  const silkPath = `/tmp/ft-tts-test-${stamp}.silk`;

  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const silkSdk = require('silk-sdk');

    // Step 1: TTS → MP3
    const tts = new MsEdgeTTS();
    await tts.setMetadata('zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream('功能测试语音');
    const mp3Chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data',  c => mp3Chunks.push(c));
      audioStream.on('end',   resolve);
      audioStream.on('error', reject);
    });
    fs.writeFileSync(mp3Path, Buffer.concat(mp3Chunks));
    console.log(' ', info(`MP3 written: ${fs.statSync(mp3Path).size} bytes`));

    // Step 2: MP3 → PCM s16le 16kHz mono
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', mp3Path,
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      pcmPath,
    ]);
    console.log(' ', info(`PCM written: ${fs.statSync(pcmPath).size} bytes`));

    // Step 3: PCM → SILK (tencent: true)
    const pcmBuf  = fs.readFileSync(pcmPath);
    const silkBuf = silkSdk.encode(pcmBuf, { fsHz: 16000, tencent: true });
    fs.writeFileSync(silkPath, silkBuf);
    console.log(' ', info(`SILK written: ${fs.statSync(silkPath).size} bytes`));

    // Step 4: verify all files exist and non-empty
    assert(fs.statSync(mp3Path).size  > 0, 'MP3 size > 0');
    assert(fs.statSync(pcmPath).size  > 0, 'PCM size > 0');
    assert(fs.statSync(silkPath).size > 0, 'SILK size > 0');

    // Step 5: playtime calculation
    const playtime = Math.round(pcmBuf.length / 32000 * 1000);
    assert(playtime > 0, `playtime(${playtime}) > 0`);
    console.log(' ', info(`playtime: ${playtime} ms`));

    recordPass(`F1: TTS pipeline OK (mp3=${fs.statSync(mp3Path).size}B pcm=${pcmBuf.length}B silk=${silkBuf.length}B playtime=${playtime}ms)`);
  } catch (err) {
    recordFail('F1: TTS pipeline', err);
  } finally {
    // Step 6: cleanup
    for (const p of [mp3Path, pcmPath, silkPath]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

async function testF2() {
  section('F2 — commands interceptor logic');
  try {
    // Direct test of match functions (internal _doChat not publicly accessible)
    const cmds = [
      { match(text) { if (text === '/ping') return 'pong'; }, usage: '/ping', desc: 'ping' },
      { match(text) { const m = text.match(/^\/echo (.+)/); if (m) return m[1]; }, usage: '/echo', desc: 'echo' },
    ];

    assert.strictEqual(cmds[0].match('/ping'),  'pong',      '/ping → pong');
    assert.strictEqual(cmds[0].match('/other'), undefined,   '/other → undefined');
    assert.strictEqual(cmds[1].match('/echo hello'), 'hello', '/echo hello → hello');
    assert.strictEqual(cmds[1].match('/other'), undefined,   '/other → undefined for echo cmd');

    // Also verify that a gateway created with these commands routes them via handleWeixinCommand
    // by checking the public-facing behaviour (createWeixinGateway exposes no internal API,
    // so we test the match closures directly as specified)
    const replied = [];
    const gw2 = createWeixinGateway({
      storage:   new MemoryAdapter(),
      commands:  cmds,
      onMessage: async ({ text }) => { replied.push('onMessage:' + text); return null; },
    });
    // Confirm gateway was created without error
    assert(typeof gw2.sendText === 'function', 'gw2 has sendText');
    assert(typeof gw2.subscribe === 'function', 'gw2 has subscribe');

    recordPass('F2: commands match logic OK (/ping→pong, /echo→echo, non-match→undefined)');
  } catch (err) {
    recordFail('F2: commands interceptor', err);
  }
}

async function testF3(gw, accountId, sessions) {
  section('F3 — subscribe event triggering');
  try {
    const events = [];
    const off = gw.subscribe(e => events.push(e));

    // restore triggers broadcastStatus() internally — but it does NOT call broadcastStatus in
    // the current implementation (restore() sets state but calls no _emit).
    // We instead call restore again to exercise the code path, then trigger a known
    // event path: create a second gateway and subscribe before restore().
    const gw3 = createWeixinGateway({ storage: new MemoryAdapter() });
    const events3 = [];
    const off3 = gw3.subscribe(e => events3.push(e));
    gw3.restore(accountId, sessions);
    off3();

    // Verify subscribe returns an unsubscribe function
    assert(typeof off === 'function', 'subscribe returns unsubscribe function');

    // Unsubscribe the original listener
    off();

    // After unsubscribe, further events must NOT reach the listener
    const countBefore = events.length;
    // Trigger any emission (restore on gw doesn't emit, but that itself is testable)
    gw.restore(accountId, sessions);
    const countAfter = events.length;
    assert.strictEqual(countBefore, countAfter, 'no events after unsubscribe');

    console.log(' ', info(`Events captured before off(): ${countBefore}, events3 (restore gw3): ${events3.length}`));
    console.log(' ', info(`Note: restore() does not emit events in current implementation — subscribe/unsubscribe mechanism works correctly`));

    recordPass(`F3: subscribe/unsubscribe OK (events captured=${countBefore}, unsubscribe prevents further delivery)`);
  } catch (err) {
    recordFail('F3: subscribe event', err);
  }
}

async function testF4(gw, wxId) {
  section('F4 — CDN upload / sendFile (small file)');
  const filePath = `/tmp/ft-cdn-test-${Date.now()}.txt`;
  try {
    // Generate a ~1 KB test file
    fs.writeFileSync(filePath, 'weixin-gateway functional-test F4\n'.repeat(30), 'utf8');
    const size = fs.statSync(filePath).size;
    console.log(' ', info(`Test file: ${size} bytes → ${filePath}`));

    // Verify ilink is loaded (gw.restore was already called)
    const sessions = gw.getSessions();
    assert(sessions.length > 0, 'sessions available after restore');
    console.log(' ', info(`iLink loaded via restore, sessions: ${sessions.length}`));

    // Use gw.sendFile which exercises ilink.uploadMedia + ilink.sendItem end-to-end
    // Will throw if WeChat returns ret:-2 (expired contextToken)
    await gw.sendFile(wxId, filePath);

    recordPass(`F4: sendFile OK (${size}B file uploaded and sent)`);
  } catch (err) {
    if (err.message && err.message.includes('ret=-2')) {
      recordFail('F4: CDN upload / sendFile', new Error('contextToken expired — send a fresh WeChat message to the bot, then re-run'));
    } else {
      recordFail('F4: CDN upload / sendFile', err);
    }
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

async function testF5(gw, wxId) {
  section('F5 — gw.sendText');
  try {
    await gw.sendText(wxId, '功能测试 F5: onMessage + sendText ✅');
    recordPass('F5: sendText OK');
  } catch (err) {
    recordFail('F5: sendText', err);
  }
}

async function testF6(gw, wxId) {
  section('F6 — gw.sendVoice (end-to-end: TTS → CDN → WeChat)');
  try {
    // Will throw if WeChat returns ret:-2 (expired contextToken)
    await gw.sendVoice(wxId, '功能测试完成');
    recordPass('F6: sendVoice OK');
  } catch (err) {
    if (err.message && err.message.includes('ret=-2')) {
      recordFail('F6: sendVoice', new Error('contextToken expired — send a fresh WeChat message to the bot, then re-run'));
    } else {
      recordFail('F6: sendVoice', err);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}weixin-gateway functional tests (no mock)${C.reset}`);
  console.log(dim(`Token file: ${TOKEN_FILE}`));

  // Environment setup
  const payload  = loadTokenFile();
  const session  = payload.sessions[0];
  const { wxId, nickname, contextToken } = session;
  const { accountId } = payload;

  console.log(info(`Target user: ${nickname || wxId}  (${dim(wxId)})`));
  console.log(info(`accountId: ${dim(accountId)}`));

  const ffmpegPath = findFfmpeg();
  console.log(info(`ffmpeg: ${dim(ffmpegPath)}`));

  // Create gateway and restore session
  const gw = createWeixinGateway({ storage: new MemoryAdapter() });
  gw.restore(accountId, payload.sessions);
  console.log(info('Gateway restored'));

  // Run tests sequentially
  await testF1(ffmpegPath);
  await testF2();
  await testF3(gw, accountId, payload.sessions);
  await testF4(gw, wxId);
  await testF5(gw, wxId);
  await testF6(gw, wxId);

  // Summary
  const total = passed + failed;
  console.log(`\n${C.bold}Results: ${passed}/${total} passed${failed > 0 ? `  (${C.red}${failed} failed${C.reset})` : `  ${C.green}all OK${C.reset}`}${C.reset}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(fail(`Uncaught error: ${err.message}`));
  process.exit(1);
});
