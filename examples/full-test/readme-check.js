'use strict';

/**
 * readme-check.js
 * Statically verifiable checks against README.md — no network, no WeChat account required.
 */

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ✗ ${label}`);
  if (err) console.log(`      ERROR: ${err}`);
  failed++;
}

function section(title) {
  console.log(`\n[${title}]`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Module exports
// ─────────────────────────────────────────────────────────────────────────────
section('1. Module exports (Installation / Quick Start)');

let createWeixinGateway, createWeixinRouter, MemoryAdapter;
try {
  ({ createWeixinGateway, createWeixinRouter, MemoryAdapter } = require('weixin-gateway'));
  ok('require("weixin-gateway") succeeded');
} catch (e) {
  fail('require("weixin-gateway") succeeded', e.message);
  console.log('\nFATAL: Cannot load module — aborting.');
  process.exit(1);
}

if (typeof createWeixinGateway === 'function') ok('createWeixinGateway is a function');
else fail('createWeixinGateway is a function', `got ${typeof createWeixinGateway}`);

if (typeof createWeixinRouter === 'function') ok('createWeixinRouter is a function');
else fail('createWeixinRouter is a function', `got ${typeof createWeixinRouter}`);

if (typeof MemoryAdapter === 'function') ok('MemoryAdapter is a function/class');
else fail('MemoryAdapter is a function/class', `got ${typeof MemoryAdapter}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. createWeixinGateway — instance API shape
// ─────────────────────────────────────────────────────────────────────────────
section('2. createWeixinGateway — instance API shape (SDK Reference)');

let gw;
try {
  gw = createWeixinGateway({
    storage: new MemoryAdapter(),
    onMessage: async ({ wxId, text }) => ({ text: `echo: ${text}` }),
    voice: 'zh-CN-XiaoxiaoNeural',
    commands: [
      {
        match(text) { if (text === '/ping') return 'pong'; },
        usage: '/ping',
        desc: 'Connectivity check',
      },
      {
        match(text) {
          const m = text.match(/^\/echo (.+)/);
          if (m) return m[1];
        },
        usage: '/echo <text>',
        desc: 'Echo a message',
      },
    ],
  });
  ok('createWeixinGateway({...}) did not throw');
} catch (e) {
  fail('createWeixinGateway({...}) did not throw', e.message);
  console.log('\nFATAL: Cannot create gateway instance — aborting.');
  process.exit(1);
}

const lifecycleMethods = ['start', 'stop', 'startIfLoggedIn', 'restore'];
const statusMethods    = ['getStatus', 'getSessions'];
const sendMethods      = ['sendText', 'sendVoice', 'sendImage', 'sendVideo', 'sendFile'];
const otherMethods     = ['deleteSession', 'subscribe'];
const allMethods       = [...lifecycleMethods, ...statusMethods, ...sendMethods, ...otherMethods];

for (const m of allMethods) {
  if (typeof gw[m] === 'function') ok(`gw.${m} is a function`);
  else fail(`gw.${m} is a function`, `got ${typeof gw[m]}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. gw.getStatus() return shape
// ─────────────────────────────────────────────────────────────────────────────
section('3. gw.getStatus() return format (SDK Reference - Status)');

let status;
try {
  status = gw.getStatus();
  ok('gw.getStatus() did not throw');
} catch (e) {
  fail('gw.getStatus() did not throw', e.message);
  status = null;
}

if (status !== null) {
  if ('state' in status)    ok('getStatus() has "state" field');
  else                       fail('getStatus() has "state" field', 'field missing');

  if ('accountId' in status) ok('getStatus() has "accountId" field');
  else                        fail('getStatus() has "accountId" field', 'field missing');

  if ('sessions' in status)  ok('getStatus() has "sessions" field');
  else                        fail('getStatus() has "sessions" field', 'field missing');

  const validStates = ['idle', 'qr_pending', 'connected'];
  if (validStates.includes(status.state)) ok(`state is one of 'idle'|'qr_pending'|'connected' (got '${status.state}')`);
  else fail(`state is one of 'idle'|'qr_pending'|'connected'`, `got '${status.state}'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. gw.getSessions() returns array
// ─────────────────────────────────────────────────────────────────────────────
section('4. gw.getSessions() returns array');

let sessions;
try {
  sessions = gw.getSessions();
  ok('gw.getSessions() did not throw');
} catch (e) {
  fail('gw.getSessions() did not throw', e.message);
  sessions = null;
}

if (sessions !== null) {
  if (Array.isArray(sessions)) ok('getSessions() returns an Array');
  else fail('getSessions() returns an Array', `got ${typeof sessions}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. gw.subscribe() returns unsubscribe function
// ─────────────────────────────────────────────────────────────────────────────
section('5. gw.subscribe() returns unsubscribe function (Events)');

let off;
try {
  off = gw.subscribe(event => {});
  ok('gw.subscribe(fn) did not throw');
} catch (e) {
  fail('gw.subscribe(fn) did not throw', e.message);
  off = null;
}

if (off !== null) {
  if (typeof off === 'function') ok('subscribe() return value is a function');
  else fail('subscribe() return value is a function', `got ${typeof off}`);

  try {
    off();
    ok('off() (unsubscribe) did not throw');
  } catch (e) {
    fail('off() (unsubscribe) did not throw', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. gw.restore() — inject credentials
// ─────────────────────────────────────────────────────────────────────────────
section('6. gw.restore() — inject credentials (Restore from Saved Credentials)');

try {
  gw.restore('test-account', [{ wxId: 'test-wx', contextToken: 'fake-token', nickname: 'Test' }]);
  ok('gw.restore(...) did not throw');
} catch (e) {
  fail('gw.restore(...) did not throw', e.message);
}

try {
  const afterRestore = gw.getSessions();
  const found = afterRestore.some(s => s.wxId === 'test-wx');
  if (found) ok('getSessions() contains injected wxId "test-wx" after restore');
  else fail('getSessions() contains injected wxId "test-wx" after restore',
            `sessions: ${JSON.stringify(afterRestore.map(s => s.wxId))}`);
} catch (e) {
  fail('getSessions() readable after restore', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. gw.deleteSession() — session management
// ─────────────────────────────────────────────────────────────────────────────
section('7. gw.deleteSession() — session management');

try {
  gw.deleteSession('test-wx');
  ok('gw.deleteSession("test-wx") did not throw');
} catch (e) {
  fail('gw.deleteSession("test-wx") did not throw', e.message);
}

try {
  const afterDelete = gw.getSessions();
  const stillThere  = afterDelete.some(s => s.wxId === 'test-wx');
  if (!stillThere) ok('getSessions() no longer contains "test-wx" after deleteSession');
  else fail('getSessions() no longer contains "test-wx" after deleteSession',
            `still present in: ${JSON.stringify(afterDelete.map(s => s.wxId))}`);
} catch (e) {
  fail('getSessions() readable after deleteSession', e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. createWeixinRouter — HTTP Server
// ─────────────────────────────────────────────────────────────────────────────
section('8. createWeixinRouter — HTTP Server chapter');

let routerResult;
try {
  const express = require('express');
  const app = express();
  app.use(express.json());
  routerResult = createWeixinRouter({
    storage: new MemoryAdapter(),
    onMessage: async ({ wxId, text }) => ({ text: `收到：${text}` }),
  });
  ok('createWeixinRouter({...}) did not throw');
} catch (e) {
  fail('createWeixinRouter({...}) did not throw', e.message);
  routerResult = null;
}

if (routerResult !== null) {
  if ('router' in routerResult) ok('result has "router" field');
  else fail('result has "router" field', 'field missing');

  if (typeof routerResult.router === 'function') ok('result.router is a function (Express Router)');
  else fail('result.router is a function (Express Router)', `got ${typeof routerResult.router}`);

  if ('autoStartIfLoggedIn' in routerResult) ok('result has "autoStartIfLoggedIn" field');
  else fail('result has "autoStartIfLoggedIn" field', 'field missing');

  if (typeof routerResult.autoStartIfLoggedIn === 'function') ok('result.autoStartIfLoggedIn is a function');
  else fail('result.autoStartIfLoggedIn is a function', `got ${typeof routerResult.autoStartIfLoggedIn}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. resolveVoice — TTS Voice Pipeline
// ─────────────────────────────────────────────────────────────────────────────
section('9. resolveVoice — TTS Voice Pipeline chapter');

let resolveVoice;
try {
  ({ resolveVoice } = require('weixin-gateway/lib/voice'));
  ok('require("weixin-gateway/lib/voice") succeeded');
} catch (e) {
  fail('require("weixin-gateway/lib/voice") succeeded', e.message);
  resolveVoice = null;
}

if (resolveVoice !== null) {
  const cases = [
    { input: '晓晓',               expected: 'zh-CN-XiaoxiaoNeural', label: 'resolveVoice("晓晓") === "zh-CN-XiaoxiaoNeural"' },
    { input: 'yunxi',              expected: 'zh-CN-YunxiNeural',    label: 'resolveVoice("yunxi") === "zh-CN-YunxiNeural"' },
    { input: 'zh-CN-YunxiNeural', expected: 'zh-CN-YunxiNeural',    label: 'resolveVoice("zh-CN-YunxiNeural") passthrough' },
    { input: 'unknown',            expected: null,                   label: 'resolveVoice("unknown") === null' },
  ];

  for (const { input, expected, label } of cases) {
    const result = resolveVoice(input);
    if (result === expected) ok(label);
    else fail(label, `got ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`);
  }

  const dongbei = resolveVoice('东北');
  if (dongbei !== null) ok('resolveVoice("东北") is not null (dialect alias exists)');
  else fail('resolveVoice("东北") is not null (dialect alias exists)', 'got null');

  const yueyu = resolveVoice('粤语');
  // Note: README says '粤语' alias exists — check VOICE_ALIASES for actual key
  // The voice.js uses '晓佳'/'晓曼'/'云龙' for Cantonese; '粤语' may not be a key.
  // We test what the README claims: check truthiness.
  const { VOICE_ALIASES } = require('weixin-gateway/lib/voice');
  if ('粤语' in VOICE_ALIASES) {
    if (yueyu !== null) ok('resolveVoice("粤语") is not null (Cantonese alias exists)');
    else fail('resolveVoice("粤语") is not null (Cantonese alias exists)', 'got null');
  } else {
    // README claims it exists — this is an inaccuracy; report it clearly
    if (yueyu !== null) ok('resolveVoice("粤语") is not null (Cantonese alias exists)');
    else fail('resolveVoice("粤语") is not null — README claims alias exists but "粤语" not in VOICE_ALIASES',
              `got null — available Cantonese keys: ${Object.keys(VOICE_ALIASES).filter(k => ['晓佳','晓曼','云龙'].includes(k)).join(', ')}`);
  }

  const ava = resolveVoice('ava');
  if (ava !== null) ok('resolveVoice("ava") is not null (English alias exists)');
  else fail('resolveVoice("ava") is not null (English alias exists)', 'got null');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Bundled instruction template
// ─────────────────────────────────────────────────────────────────────────────
section('10. Bundled Instruction Template (config/instruction.md)');

const fs = require('fs');
let tplPath;
try {
  tplPath = require.resolve('weixin-gateway/config/instruction.md');
  ok('require.resolve("weixin-gateway/config/instruction.md") succeeded');
} catch (e) {
  fail('require.resolve("weixin-gateway/config/instruction.md") succeeded', e.message);
  tplPath = null;
}

if (tplPath !== null) {
  let tplExists = false;
  try {
    tplExists = fs.existsSync(tplPath);
    if (tplExists) ok('instruction.md file exists on disk');
    else fail('instruction.md file exists on disk', `path: ${tplPath}`);
  } catch (e) {
    fail('instruction.md file exists on disk', e.message);
  }

  if (tplExists) {
    let content;
    try {
      content = fs.readFileSync(tplPath, 'utf8');
      ok('instruction.md is readable');
    } catch (e) {
      fail('instruction.md is readable', e.message);
      content = null;
    }

    if (content !== null) {
      if (content.length > 0) ok('instruction.md is non-empty');
      else fail('instruction.md is non-empty', 'file is empty');

      if (content.includes('{{message}}'))      ok('instruction.md contains {{message}} placeholder');
      else fail('instruction.md contains {{message}} placeholder', 'placeholder not found');

      if (content.includes('{{responseFile}}')) ok('instruction.md contains {{responseFile}} placeholder');
      else fail('instruction.md contains {{responseFile}} placeholder', 'placeholder not found');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. MemoryAdapter interface completeness
// ─────────────────────────────────────────────────────────────────────────────
section('11. MemoryAdapter interface completeness (Storage Adapter chapter)');

const requiredMethods = [
  'saveMessage', 'getMessages', 'getRounds', 'getUnpairedMessages',
  'updateMessagePairIds', 'getMaxPairIds', 'deleteOldMessages',
  'saveMedia', 'getMedia', 'upsertSession', 'getSessions',
];

let adapter;
try {
  adapter = new MemoryAdapter();
  ok('new MemoryAdapter() succeeded');
} catch (e) {
  fail('new MemoryAdapter() succeeded', e.message);
  adapter = null;
}

if (adapter !== null) {
  for (const m of requiredMethods) {
    if (typeof adapter[m] === 'function') ok(`MemoryAdapter.${m} is a function`);
    else fail(`MemoryAdapter.${m} is a function`, `got ${typeof adapter[m]}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`Total: ${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('All checks passed.');
} else {
  console.log(`${failed} check(s) FAILED.`);
  process.exitCode = 1;
}
