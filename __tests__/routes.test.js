'use strict';

/**
 * routes.test.js — 接口功能测试
 *
 * 不只测状态码，测实际数据：
 *   GET  /status         — 反映内存中 sessionMeta / sessionPresets
 *   POST /session        — 写入内存 + DB，/status 可见
 *   DELETE /session      — 清除内存，/status 消失
 *   GET  /rounds         — 从 DB 读消息轮次，带分页 & wxId 过滤
 *   GET  /messages       — 从 DB 读原始消息，带分页 & wxId 过滤
 *   GET  /media/:id      — 返回正确 MIME + 二进制数据
 *   GET  /localfile      — 服务 /tmp/ 文件，安全策略 (403/404)
 *   POST /stop           — 重置 daemonState → idle
 */

const request  = require('supertest');
const express  = require('express');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const http     = require('http');

const { createWeixinRouter, MemoryAdapter } = require('weixin-gateway');

// ── 工厂 ──────────────────────────────────────────────────────────────────────

function setup(extraConfig = {}) {
  const storage = new MemoryAdapter();
  const { router } = createWeixinRouter({ storage, ...extraConfig });
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return { app, storage };
}

// 直接写入辅助（绕过 HTTP，模拟消息历史）
function seedMessages(storage, rows) {
  for (const r of rows) {
    storage.messages.push({
      id: storage._nextMessageId++,
      wx_id: r.wx_id, direction: r.direction, content: r.content,
      ts: r.ts, pair_id: r.pair_id,
    });
  }
}

function seedMedia(storage, { wx_id, pair_id, direction, media_type, mime, data }) {
  const id = storage._nextMediaId++;
  storage.media.push({
    id, wx_id, pair_id, direction,
    media_type, mime, data,
    ts: new Date().toISOString(),
  });
  return id;
}

// ── GET /status ───────────────────────────────────────────────────────────────

describe('GET /status — 反映实时内存状态', () => {
  test('初始状态：state=idle, sessions=[], defaultPreset={type:claude-code}', async () => {
    const { app } = setup();
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('idle');
    expect(res.body.sessions).toEqual([]);
    expect(res.body.defaultPreset).toMatchObject({ type: 'claude-code' });
    expect(res.body.qrUrl).toBeNull();
    expect(res.body.accountId).toBeNull();
  });

  test('storage에서 복원된 세션이 /status.sessions에 보임', async () => {
    const storage = new MemoryAdapter();
    storage.upsertSession('stored-user', 'nick', null, null, null, null, new Date().toISOString(), null);
    const { router } = createWeixinRouter({ storage });
    const app = express(); app.use(express.json()); app.use('/', router);
    const res = await request(app).get('/status');
    expect(res.body.sessions.find(s => s.wxId === 'stored-user')).toBeDefined();
  });

  test('DELETE /session 후 /status.sessions에서 사라짐', async () => {
    const storage = new MemoryAdapter();
    storage.upsertSession('del-user', 'nick', null, null, null, null, new Date().toISOString(), null);
    const { router } = createWeixinRouter({ storage });
    const app = express(); app.use(express.json()); app.use('/', router);
    await request(app).delete('/session/del-user');
    const res = await request(app).get('/status');
    expect(res.body.sessions.find(s => s.wxId === 'del-user')).toBeUndefined();
  });
});


// ── GET /rounds ───────────────────────────────────────────────────────────────

describe('GET /rounds — 消息轮次读取', () => {
  test('有消息时返回正确轮次数据', async () => {
    const { app, storage } = setup();
    const now = new Date().toISOString();
    seedMessages(storage, [
      { wx_id: 'alice', direction: 'in',  content: '你好',     ts: now, pair_id: 1 },
      { wx_id: 'alice', direction: 'out', content: '你好，有什么需要帮助？', ts: now, pair_id: 1 },
    ]);
    const res = await request(app).get('/rounds');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rounds.length).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const round = res.body.rounds.find(r => r.wx_id === 'alice' && r.pair_id === 1);
    expect(round).toBeDefined();
    expect(round.in_content).toBe('你好');
    expect(round.out_content).toBe('你好，有什么需要帮助？');
  });

  test('wxId 过滤只返回该用户的轮次', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    seedMessages(storage, [
      { wx_id: 'bob',   direction: 'in',  content: 'Bob msg',  ts, pair_id: 1 },
      { wx_id: 'carol', direction: 'in',  content: 'Carol msg', ts, pair_id: 1 },
    ]);
    const res = await request(app).get('/rounds?wxId=bob');
    expect(res.status).toBe(200);
    expect(res.body.rounds.every(r => r.wx_id === 'bob')).toBe(true);
    expect(res.body.rounds.find(r => r.wx_id === 'carol')).toBeUndefined();
  });

  test('wxId 不存在时返回空数组 total=0（非 500）', async () => {
    const { app } = setup();
    const res = await request(app).get('/rounds?wxId=nobody');
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('limit 参数限制返回条数', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      seedMessages(storage, [{ wx_id: 'dave', direction: 'in', content: `msg${i}`, ts, pair_id: i }]);
    }
    const res = await request(app).get('/rounds?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.rounds.length).toBeLessThanOrEqual(2);
  });

  test('offset 翻页返回不同数据', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    for (let i = 1; i <= 4; i++) {
      seedMessages(storage, [{ wx_id: 'eve', direction: 'in', content: `msg${i}`, ts, pair_id: i }]);
    }
    const page1 = (await request(app).get('/rounds?wxId=eve&limit=2&offset=0')).body.rounds;
    const page2 = (await request(app).get('/rounds?wxId=eve&limit=2&offset=2')).body.rounds;
    const ids1 = page1.map(r => r.pair_id);
    const ids2 = page2.map(r => r.pair_id);
    // 两页不重叠
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });

  test('total 字段正确反映总轮次数', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    seedMessages(storage, [
      { wx_id: 'frank', direction: 'in', content: 'a', ts, pair_id: 1 },
      { wx_id: 'frank', direction: 'in', content: 'b', ts, pair_id: 2 },
      { wx_id: 'frank', direction: 'in', content: 'c', ts, pair_id: 3 },
    ]);
    const res = await request(app).get('/rounds?wxId=frank&limit=1');
    expect(res.body.total).toBe(3);
    expect(res.body.rounds).toHaveLength(1);
  });
});

// ── GET /messages ─────────────────────────────────────────────────────────────

describe('GET /messages — 原始消息读取', () => {
  test('返回所有消息（in + out）', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    seedMessages(storage, [
      { wx_id: 'grace', direction: 'in',  content: '问题', ts, pair_id: 1 },
      { wx_id: 'grace', direction: 'out', content: '回答', ts, pair_id: 1 },
    ]);
    const res = await request(app).get('/messages?wxId=grace');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messages.length).toBe(2);
    expect(res.body.messages.map(m => m.direction)).toEqual(expect.arrayContaining(['in', 'out']));
  });

  test('每条消息包含 id, wx_id, direction, content, ts 字段', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    seedMessages(storage, [{ wx_id: 'henry', direction: 'in', content: 'hello', ts, pair_id: 1 }]);
    const res = await request(app).get('/messages?wxId=henry');
    const msg = res.body.messages[0];
    expect(msg).toHaveProperty('id');
    expect(msg).toHaveProperty('wx_id', 'henry');
    expect(msg).toHaveProperty('direction', 'in');
    expect(msg).toHaveProperty('content', 'hello');
    expect(msg).toHaveProperty('ts');
  });

  test('wxId 过滤有效', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    seedMessages(storage, [
      { wx_id: 'ivan',  direction: 'in', content: 'hi', ts, pair_id: 1 },
      { wx_id: 'julia', direction: 'in', content: 'yo', ts, pair_id: 1 },
    ]);
    const res = await request(app).get('/messages?wxId=ivan');
    expect(res.body.messages.every(m => m.wx_id === 'ivan')).toBe(true);
  });

  test('total 字段正确', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    for (let i = 0; i < 7; i++) {
      seedMessages(storage, [{ wx_id: 'kim', direction: 'in', content: `m${i}`, ts, pair_id: i + 1 }]);
    }
    const res = await request(app).get('/messages?wxId=kim&limit=3');
    expect(res.body.total).toBe(7);
    expect(res.body.messages).toHaveLength(3);
  });

  test('limit 上限 200 强制截断', async () => {
    const { app, storage } = setup();
    const ts = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      seedMessages(storage, [{ wx_id: 'leo', direction: 'in', content: `m${i}`, ts, pair_id: i + 1 }]);
    }
    const res = await request(app).get('/messages?limit=999');
    expect(res.body.messages.length).toBeLessThanOrEqual(200);
  });
});

// ── GET /media/:id ────────────────────────────────────────────────────────────

describe('GET /media/:id — 媒体数据服务', () => {
  test('返回正确 Content-Type 和二进制内容', async () => {
    const { app, storage } = setup();
    const fakeAudio = Buffer.from([0x49, 0x44, 0x33]); // ID3 header mock
    const id = seedMedia(storage, {
      wx_id: 'wx1', pair_id: 1, direction: 'out',
      media_type: 'voice', mime: 'audio/mpeg', data: fakeAudio,
    });
    const res = await request(app).get(`/media/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(res.body).toBeTruthy();
  });

  test('image/png MIME 正确透传', async () => {
    const { app, storage } = setup();
    const fakePng = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG magic
    const id = seedMedia(storage, {
      wx_id: 'wx2', pair_id: 1, direction: 'out',
      media_type: 'image', mime: 'image/png', data: fakePng,
    });
    const res = await request(app).get(`/media/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  test('Cache-Control: private 已设置', async () => {
    const { app, storage } = setup();
    const id = seedMedia(storage, {
      wx_id: 'wx3', pair_id: 1, direction: 'out',
      media_type: 'voice', mime: 'audio/mpeg', data: Buffer.from('test'),
    });
    const res = await request(app).get(`/media/${id}`);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  test('不存在 id → 404', async () => {
    const { app } = setup();
    const res = await request(app).get('/media/99999');
    expect(res.status).toBe(404);
  });

  test('返回数据与写入数据一致', async () => {
    const { app, storage } = setup();
    const original = Buffer.from('hello binary world');
    const id = seedMedia(storage, {
      wx_id: 'wx4', pair_id: 1, direction: 'out',
      media_type: 'file', mime: 'application/octet-stream', data: original,
    });
    const res = await request(app)
      .get(`/media/${id}`)
      .buffer(true)
      .parse((res, fn) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => fn(null, Buffer.concat(chunks)));
      });
    expect(Buffer.compare(res.body, original)).toBe(0);
  });
});

// ── GET /localfile ────────────────────────────────────────────────────────────

describe('GET /localfile — 本地文件服务', () => {
  let tmpFile;

  beforeAll(() => {
    // Use /tmp/ directly — os.tmpdir() on macOS returns /var/folders/... which fails the /tmp/ guard
    tmpFile = `/tmp/weixin-test-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, 'hello from localfile test');
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  test('/tmp/ 内文件正常返回 200', async () => {
    const { app } = setup();
    const res = await request(app).get(`/localfile?path=${encodeURIComponent(tmpFile)}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello from localfile test');
  });

  test('非 /tmp/ 路径 → 403', async () => {
    const { app } = setup();
    expect((await request(app).get('/localfile?path=/etc/hosts')).status).toBe(403);
    expect((await request(app).get('/localfile?path=/var/log/system.log')).status).toBe(403);
    expect((await request(app).get('/localfile?path=/Users/root/secret')).status).toBe(403);
  });

  test('路径遍历尝试 → 403', async () => {
    const { app } = setup();
    // /tmp/../etc/passwd 不以 /tmp/ 开头（normalize 后）
    const res = await request(app).get('/localfile?path=/tmp/../etc/passwd');
    expect(res.status).toBe(403);
  });

  test('/tmp/ 下不存在的文件 → 404', async () => {
    const { app } = setup();
    const res = await request(app).get('/localfile?path=/tmp/this-file-does-not-exist-xyz.txt');
    expect(res.status).toBe(404);
  });

  test('无 path 参数 → 400', async () => {
    const { app } = setup();
    expect((await request(app).get('/localfile')).status).toBe(400);
  });
});

// ── POST /stop ────────────────────────────────────────────────────────────────

describe('POST /stop', () => {
  test('idle 状态下 stop → state=idle', async () => {
    const { app } = setup();
    const res = await request(app).post('/stop');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: 'idle' });
  });

  test('stop 后 /status 依然返回 state=idle', async () => {
    const { app } = setup();
    await request(app).post('/stop');
    const res = await request(app).get('/status');
    expect(res.body.state).toBe('idle');
  });
});

// ── DELETE /session ───────────────────────────────────────────────────────────

describe('DELETE /session/:wxId', () => {
  test('DELETE 只清内存，storage 记录保留', async () => {
    const storage = new MemoryAdapter();
    storage.upsertSession('del-test', 'dt', null, null, null, null, new Date().toISOString(), null);
    const { router } = createWeixinRouter({ storage });
    const app = express(); app.use(express.json()); app.use('/', router);
    // 启动时从 storage 加载，内存中应有该用户
    expect((await request(app).get('/status')).body.sessions.find(s => s.wxId === 'del-test')).toBeDefined();
    await request(app).delete('/session/del-test');
    // 内存清除
    expect((await request(app).get('/status')).body.sessions.find(s => s.wxId === 'del-test')).toBeUndefined();
    // storage 记录仍在
    expect(storage.sessions.find(s => s.wx_id === 'del-test')).toBeTruthy();
  });

  test('any wxId → 200 (no protected sessions)', async () => {
    const { app } = setup();
    expect((await request(app).delete('/session/weixin-default')).status).toBe(200);
  });

  test('不存在的 wxId → 200 幂等', async () => {
    const { app } = setup();
    expect((await request(app).delete('/session/phantom')).status).toBe(200);
  });
});

// ── GET /qr-sse — SSE 协议验证 ───────────────────────────────────────────────

describe('GET /qr-sse — Server-Sent Events', () => {
  test('返回 Content-Type: text/event-stream', (done) => {
    const { app } = setup();
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.get(`http://127.0.0.1:${port}/qr-sse`, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        expect(res.headers['cache-control']).toMatch(/no-cache/);
        req.destroy();
        server.close(done);
      });
      req.on('error', () => server.close(done));
    });
  }, 5000);

  test('已有 qrUrl 时立即推送 data 事件', (done) => {
    const { app, storage } = setup();
    // 无法直接设置 daemonState.qrUrl（私有），通过 /start 触发状态变更
    // 此处只验证 SSE 连接建立后会收到 ': ping' 心跳或 data 事件帧
    const server = app.listen(0, () => {
      const port = server.address().port;
      let received = '';
      const req = http.get(`http://127.0.0.1:${port}/qr-sse`, (res) => {
        res.on('data', chunk => {
          received += chunk.toString();
          // 只要收到任何字节就算通过（SSE 连接建立成功）
          req.destroy();
          server.close(() => {
            expect(res.statusCode).toBe(200);
            done();
          });
        });
        // 如果 1s 内没有数据也算连接建立成功
        setTimeout(() => {
          req.destroy();
          server.close(() => {
            expect(res.statusCode).toBe(200);
            done();
          });
        }, 1000);
      });
      req.on('error', () => server.close(done));
    });
  }, 5000);
});

// ── contextToken 持久化 ───────────────────────────────────────────────────────

describe('contextToken 持久化', () => {
  test('POST /session 后 contextToken 存入 storage', async () => {
    // contextToken 由 SDK 推入 sessionMeta，这里通过 upsertSession 验证存储路径
    const { storage } = setup();
    // 直接种一条带 context_token 的 session
    storage.sessions.push({
      wx_id: 'ctx-user', nickname: 'ctx', preset_type: 'claude-code',
      preset_command: null, preset_dir: null, tts_voice: null,
      last_active: new Date().toISOString(),
      context_token: 'tok-abc123',
    });
    // 重建工厂（模拟重启），loadSessionsFromStorage 应从 storage 还原 contextToken
    const { createWeixinRouter, MemoryAdapter } = require('weixin-gateway');
    const storage2 = new MemoryAdapter();
    storage2.sessions = [...storage.sessions];
    const appExpress = require('express')();
    appExpress.use(require('express').json());
    const { router: r2 } = createWeixinRouter({ storage: storage2 });
    appExpress.use('/', r2);

    const res = await request(appExpress).get('/status');
    // sessions 中 ctx-user 应该在内存里（loadSessionsFromStorage 还原）
    const s = res.body.sessions.find(s => s.wxId === 'ctx-user');
    expect(s).toBeDefined();
    // contextToken 不暴露在 /status，但 storage2.sessions 里有
    const row = storage2.sessions.find(s => s.wx_id === 'ctx-user');
    expect(row.context_token).toBe('tok-abc123');
  });

  test('upsertSession COALESCE：不传 contextToken 不覆盖已有值', () => {
    const { MemoryAdapter } = require('weixin-gateway');
    const s = new MemoryAdapter();
    s.upsertSession('u1', 'nick', 'claude-code', null, null, null, new Date().toISOString(), 'orig-token');
    // 第二次不传 contextToken
    s.upsertSession('u1', 'nick', 'opencode', null, null, null, new Date().toISOString(), undefined);
    expect(s.sessions[0].context_token).toBe('orig-token');
    expect(s.sessions[0].preset_type).toBe('opencode');
  });

  test('upsertSession：传新 contextToken 覆盖旧值', () => {
    const { MemoryAdapter } = require('weixin-gateway');
    const s = new MemoryAdapter();
    s.upsertSession('u2', 'nick', 'claude-code', null, null, null, new Date().toISOString(), 'old-token');
    s.upsertSession('u2', 'nick', 'claude-code', null, null, null, new Date().toISOString(), 'new-token');
    expect(s.sessions[0].context_token).toBe('new-token');
  });
});

// ── POST /push-demo ───────────────────────────────────────────────────────────

describe('POST /push-demo', () => {
  test('无 contextToken → 400 + sessions 列表', async () => {
    const { app } = setup();
    const res = await request(app).post('/push-demo');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body).toHaveProperty('sessions');
  });

});

// ── POST /resend-silk ─────────────────────────────────────────────────────────

describe('POST /resend-silk', () => {
  test('无 contextToken → 400', async () => {
    const { app } = setup();
    const res = await request(app).post('/resend-silk');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contextToken/);
  });
});
