'use strict';

// weixin-gateway/index.js
// WeChat personal assistant gateway — QR login, keep-alive, and multi-type message sending.
// Factory function wraps all logic as closures over shared mutable state.

const { Router }       = require('express');
const { execFileSync, execFile } = require('child_process');
const fs               = require('fs');
const os               = require('os');
const path             = require('path');
const QRCode           = require('qrcode');
const { WECHAT_VOICE_DEFAULT, resolveVoice } = require('./lib/voice');
const { createILinkClient }                       = require('./lib/ilink');
const { createTtsPipeline }                       = require('./lib/tts');
const { createMediaSender }                       = require('./lib/media');

// ── Storage adapter resolution ────────────────────────────────────────────────

function resolveStorage(config) {
  if (config.storage) return config.storage;
  const { MemoryAdapter } = require('./adapters/memory');
  return new MemoryAdapter();
}

// ── Binary discovery ──────────────────────────────────────────────────────────

function findBinary(name, hint) {
  if (hint) return hint;
  const extraDirs = ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin')];
  const searchPath = [process.env.PATH || '', ...extraDirs].join(':');
  try {
    const result = execFileSync('which', [name],
      { env: { ...process.env, PATH: searchPath }, encoding: 'utf8', timeout: 3000 });
    const found = result.trim();
    if (found) return found;
  } catch {}
  for (const dir of extraDirs) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  console.warn(`[weixin-gateway] ${name} not found — some features may fail`);
  return name;
}

/**
 * Create a WeChat gateway instance.
 *
 * @param {object} config
 * @param {object}   [config.storage]     - storage adapter (default: MemoryAdapter)
 * @param {string}   [config.voice]       - default TTS voice ShortName (default: zh-CN-XiaoxiaoNeural)
 * @param {Array}    [config.commands]    - user-injectable WeChat commands [{match(text,wxId)→string|null, usage?, desc?}]
 * @param {Function} [config.onMessage]   - message handler async ({wxId, text, media, contextToken, sendMessage})=>({text}|null)
 * @param {string}   [config.ffmpegPath]  - override ffmpeg binary path
 * @param {string}   [config.ytdlpPath]   - override yt-dlp binary path
 * @returns {{
 *   start: (preset?: object) => Promise<void>,
 *   stop: () => void,
 *   startIfLoggedIn: (preset?: object) => Promise<void>,
 *   restore: (accountId: string, sessions: object[]) => void,
 *   getStatus: () => object,
 *   getSessions: () => object[],
 *   sendText: (wxId: string, text: string) => Promise<void>,
 *   sendVoice: (wxId: string, text: string) => Promise<void>,
 *   sendImage: (wxId: string, urlOrPath: string) => Promise<void>,
 *   sendVideo: (wxId: string, url: string) => Promise<void>,
 *   sendFile:  (wxId: string, filePath: string) => Promise<void>,
 *   deleteSession: (wxId: string) => void,
 *   subscribe: (fn: Function) => Function,
 * }}
 */
function createWeixinGateway(config = {}) {
  const storage       = resolveStorage(config);
  const _defaultVoice = typeof config.voice      === 'string'   ? config.voice      : null;
  const _userCmds     = Array.isArray(config.commands)          ? config.commands   : [];
  const _onMessage    = typeof config.onMessage  === 'function' ? config.onMessage  : null;

  const FFMPEG = findBinary('ffmpeg', config.ffmpegPath);
  const YTDLP  = findBinary('yt-dlp', config.ytdlpPath);

  // Extended PATH passed to media download subprocesses
  const MEDIA_ENV = {
    ...process.env,
    PATH: [process.env.PATH || '', '/usr/local/bin', '/opt/homebrew/bin'].join(':'),
  };
  // ───────────────────────────────────────────────────────────────────────────

  // task-397: ~/.openclaw token file paths
  const OPENCLAW_ACCOUNTS_FILE =
    path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts.json');

  function readSavedAccountId() {
    try {
      const accounts = JSON.parse(fs.readFileSync(OPENCLAW_ACCOUNTS_FILE, 'utf8'));
      if (Array.isArray(accounts) && accounts.length > 0) return accounts[0];
    } catch {}
    return null;
  }

  // ── Voice state ─────────────────────────────────────────────────────────────
  const _userVoice = new Map(); // wxId → ShortName

  function getUserVoice(wxId) {
    return _userVoice.get(wxId) || _defaultVoice || WECHAT_VOICE_DEFAULT;
  }

  // ── iLink client ─────────────────────────────────────────────────────────────
  const ilink = createILinkClient();

  // ── TTS pipeline ─────────────────────────────────────────────────────────────
  const generateAndSendVoice = createTtsPipeline({
    ffmpeg:      FFMPEG,
    mediaEnv:    MEDIA_ENV,
    ilink,
    getUserVoice,
    getPairId:   wxId => _pairIds.get(wxId) || 1,
    logMedia,
  });

  // ── Media sender ──────────────────────────────────────────────────────────────
  const { sendImageFromUrl, sendLocalImageFile, sendLocalVideoFile, sendVideoFromUrl, downloadAndSendBilibili } =
    createMediaSender({ ilink, ffmpeg: FFMPEG, ytdlp: YTDLP, mediaEnv: MEDIA_ENV });

  // ── Daemon state ─────────────────────────────────────────────────────────────

  const daemonState = {
    state: 'idle',         // 'idle' | 'qr_pending' | 'logging_in' | 'connected'
    qrUrl: null,
    userInfo: null,
    accountId: null,
    abortController: null,
    loginAbort: null,
    defaultPreset: { type: 'claude-code' },
  };

  // wxId → session metadata { wxId, lastActive, nickname, contextToken? }
  const sessionMeta = new Map();

  // ── Storage helpers ──────────────────────────────────────────────────────────

  // wx_id → current pair_id (seeded from storage on init via migratePairIds)
  const _pairIds = new Map();

  // Assign pair_ids to historical messages that have pair_id = 0, and seed _pairIds.
  function migratePairIds() {
    try {
      const msgs = storage.getUnpairedMessages();
      if (msgs.length > 0) {
        const localPairs = new Map();
        const updates    = [];
        for (const m of msgs) {
          if (m.direction === 'in') {
            const next = (localPairs.get(m.wx_id) || 0) + 1;
            localPairs.set(m.wx_id, next);
            updates.push({ id: m.id, pairId: next });
          } else {
            updates.push({ id: m.id, pairId: localPairs.get(m.wx_id) || 1 });
          }
        }
        storage.updateMessagePairIds(updates);
        console.log(`[weixin-gateway] migrated ${updates.length} messages with pair_ids`);
      }
      const maxes = storage.getMaxPairIds();
      for (const row of maxes) _pairIds.set(row.wx_id, row.max_pair);
    } catch (err) {
      console.error('[weixin-gateway] migratePairIds error:', err.message);
    }
  }

  migratePairIds();

  function logMessage(wxId, direction, content) {
    let pairId;
    if (direction === 'in') {
      const last = _pairIds.get(wxId) || 0;
      pairId = last + 1;
      _pairIds.set(wxId, pairId);
    } else {
      pairId = _pairIds.get(wxId) || 1;
    }
    try {
      storage.saveMessage(wxId, direction, content, pairId, new Date().toISOString());
    } catch (err) {
      console.error('[weixin-gateway] logMessage error:', err.message);
    }
  }

  function logMedia(wxId, pairId, direction, mediaType, mime, data) {
    try {
      storage.saveMedia(wxId, pairId, direction, mediaType, mime, data, new Date().toISOString());
    } catch (err) {
      console.error('[weixin-gateway] logMedia error:', err.message);
    }
  }

  function upsertSessionDb(wxId, nickname, contextToken) {
    try {
      storage.upsertSession(
        wxId,
        nickname || wxId.slice(-8),
        null, null, null,
        _userVoice.get(wxId) || null,
        new Date().toISOString(),
        contextToken ?? sessionMeta.get(wxId)?.contextToken ?? null,
      );
    } catch (err) {
      console.error('[weixin-gateway] upsertSessionDb error:', err.message);
    }
  }

  function loadSessionsFromStorage() {
    try {
      const rows = storage.getSessions();
      for (const row of rows) {
        sessionMeta.set(row.wx_id, {
          wxId:         row.wx_id,
          nickname:     row.nickname || row.wx_id.slice(-8),
          lastActive:   row.last_active,
          contextToken: row.context_token || undefined,
        });
        if (row.tts_voice) _userVoice.set(row.wx_id, row.tts_voice);
      }
      if (rows.length) console.log(`[weixin-gateway] Loaded ${rows.length} sessions from storage`);
    } catch (err) {
      console.error('[weixin-gateway] loadSessionsFromStorage error:', err.message);
    }
  }

  function cleanupOldMessages(daysToKeep = 90) {
    try {
      const cutoff = new Date(Date.now() - daysToKeep * 86400_000).toISOString();
      const result = storage.deleteOldMessages(cutoff);
      if (result.changes > 0)
        console.log(`[weixin-gateway] Pruned ${result.changes} messages older than ${daysToKeep} days`);
    } catch (err) {
      console.error('[weixin-gateway] cleanupOldMessages error:', err.message);
    }
  }

  loadSessionsFromStorage();
  cleanupOldMessages();

  // ── Event subscription ────────────────────────────────────────────────────────
  const _listeners = new Set();
  /** Subscribe to gateway events ({ type: 'status'|'qr', ... }). Returns unsubscribe fn. */
  function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
  function _emit(event)  { for (const fn of _listeners) { try { fn(event); } catch {} } }
  function pushQrToClients(qrUrl) { _emit({ type: 'qr',    qrUrl }); }
  function broadcastStatus()      { _emit({ type: 'status', state: daemonState.state }); }

  // ── User-injectable WeChat commands ─────────────────────────────────────────
  // Each entry: { match(text, wxId) → string|null, usage?: string, desc?: string }
  // /help auto-generated from entries that have usage + desc.

  function handleWeixinCommand(text, openId) {
    const t = text.trim();

    // User-provided commands
    for (const cmd of _userCmds) {
      try {
        const reply = cmd.match(t, openId);
        if (reply !== null && reply !== undefined) return { text: String(reply) };
      } catch {}
    }

    // Built-in /help — only if user has registered commands with usage/desc
    if (/^(帮助|\/help)$/i.test(t)) {
      const described = _userCmds.filter(c => c.usage && c.desc);
      if (described.length === 0) return null;
      const lines = ['🤖 可用指令', ''];
      for (const { usage, slash, desc } of described) {
        lines.push(`• ${usage}${slash ? `（${slash}）` : ''}`);
        lines.push(`  ${desc}`);
      }
      return { text: lines.join('\n') };
    }

    return null;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // ── Agent implementation ─────────────────────────────────────────────────────

  // task-393: per-user serial queue { tail: Promise, size: number }
  const userQueues = new Map();
  const USER_QUEUE_MAX = 3;

  class WeixinChatAgent {
    async chat(params) {
      const openId = params.conversationId || 'unknown';
      const q      = userQueues.get(openId) || { tail: Promise.resolve(), size: 0 };
      if (q.size >= USER_QUEUE_MAX) {
        return { text: '消息太多啦，等一会儿再发吧 😅' };
      }
      const wasQueued = q.size > 0;
      const newSize   = q.size + 1;
      const next = q.tail.then(async () => {
        if (wasQueued && typeof params.sendMessage === 'function') {
          try { await params.sendMessage({ text: '上一条还没回完，已帮你排好队，稍等～' }); } catch {}
        }
        return this._doChat(params);
      });
      userQueues.set(openId, { tail: next.catch(() => {}), size: newSize });
      next.finally(() => {
        const cur = userQueues.get(openId);
        if (!cur) return;
        const remaining = cur.size - 1;
        if (remaining <= 0) userQueues.delete(openId);
        else userQueues.set(openId, { ...cur, size: remaining });
      });
      return next;
    }

    async _doChat({ conversationId, text, media, contextToken, sendMessage }) {
      const openId = conversationId || 'unknown';

      // Update session metadata + persist contextToken
      const existing = sessionMeta.get(openId) || { wxId: openId, nickname: openId.slice(-8) };
      const updated  = { ...existing, lastActive: new Date().toISOString(),
                         ...(contextToken ? { contextToken } : {}) };
      sessionMeta.set(openId, updated);
      upsertSessionDb(openId, updated.nickname, contextToken || null);

      // User-injectable commands (run before onMessage)
      if (!media) {
        const cmdResult = handleWeixinCommand(text || '', openId);
        if (cmdResult) {
          logMessage(openId, 'in',  text || '');
          logMessage(openId, 'out', cmdResult.text);
          return cmdResult;
        }
      }

      logMessage(openId, 'in', text || (media ? `[${media.type || 'media'}]` : ''));

      if (!_onMessage) return {};

      const result = await _onMessage({ wxId: openId, text, media, contextToken: updated.contextToken, sendMessage });
      return result ?? {};
    }

    clearSession(conversationId) {
      userQueues.delete(conversationId || 'unknown');
      console.log(`[weixin-gateway] clearSession for ${conversationId}`);
    }
  }

  // ── Daemon lifecycle ─────────────────────────────────────────────────────────

  let _sdkPromise = null;
  function loadSdk() {
    if (!_sdkPromise) {
      _sdkPromise = import('weixin-agent-sdk').catch(err => {
        console.error('[weixin-gateway] Failed to load weixin-agent-sdk:', err.message);
        _sdkPromise = null;
        throw err;
      });
    }
    return _sdkPromise;
  }

  // ── Capture contextToken from SDK's getupdates responses ─────────────────────
  let _fetchPatched = false;
  function patchFetchForContextCapture() {
    if (_fetchPatched) return;
    _fetchPatched = true;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async function(input, init) {
      const res = await origFetch(input, init);
      try {
        const url = (typeof input === 'string' ? input : input?.url) ?? '';
        if (url.includes('/ilink/bot/getupdates')) {
          res.clone().json().then(data => {
            for (const msg of (data?.msgs ?? [])) {
              if (msg.from_user_id && msg.context_token) {
                const existing = sessionMeta.get(msg.from_user_id) || { wxId: msg.from_user_id, nickname: msg.from_user_id.slice(-8) };
                const updated  = { ...existing, contextToken: msg.context_token };
                sessionMeta.set(msg.from_user_id, updated);
                upsertSessionDb(msg.from_user_id, updated.nickname, msg.context_token);
              }
              for (const item of (msg.item_list ?? [])) {
                if (item.type === 3) console.log('[weixin-gateway] DEBUG inbound voice_item:', JSON.stringify(item));
                if (item.type === 2) console.log('[weixin-gateway] DEBUG inbound image_item:', JSON.stringify(item));
              }
            }
          }).catch(() => {});
        }
      } catch {}
      return res;
    };
    console.log('[weixin-gateway] fetch interceptor installed for contextToken capture');
  }

  // task-397: shared post-login logic
  async function runConnectedSession(sdk, accountId) {
    daemonState.accountId = accountId;
    daemonState.state     = 'connected';
    daemonState.qrUrl     = null;
    broadcastStatus();
    ilink.load(accountId);
    patchFetchForContextCapture();
    console.log(`[weixin-gateway] Connected as ${accountId}`);

    const agent = new WeixinChatAgent();
    await sdk.start(agent, {
      accountId,
      abortSignal: daemonState.abortController?.signal,
      log: (msg) => console.log('[weixin-gateway]', msg),
    });
  }

  async function runLoginLoop(sdk, tryTokenFirst = false) {
    while (true) {
      if (daemonState.loginAbort?.signal.aborted) return;
      try {
        // Token-based auto-reconnect (task-397)
        if (tryTokenFirst) {
          tryTokenFirst = false;
          const savedId = readSavedAccountId();
          if (savedId && typeof sdk.isLoggedIn === 'function' && sdk.isLoggedIn()) {
            console.log(`[weixin-gateway] Token found — auto-reconnecting as ${savedId}`);
            try {
              await runConnectedSession(sdk, savedId);
              if (daemonState.abortController?.signal.aborted) {
                daemonState.state = 'idle'; broadcastStatus(); return;
              }
              console.log('[weixin-gateway] Token session dropped, falling back to QR scan...');
            } catch (tokenErr) {
              if (daemonState.abortController?.signal.aborted) {
                daemonState.state = 'idle'; broadcastStatus(); return;
              }
              console.log(`[weixin-gateway] Token login failed (${tokenErr.message}), falling back to QR scan`);
            }
            daemonState.state     = 'qr_pending';
            daemonState.accountId = null;
            broadcastStatus();
            await sleep(1000);
            continue;
          }
        }

        // QR scan flow
        daemonState.state = 'qr_pending';
        broadcastStatus();

        const log = (msg) => {
          console.log('[weixin-gateway]', msg);
          if (typeof msg === 'string') {
            const urlMatch = msg.match(/https?:\/\/\S+/);
            if (urlMatch && (msg.includes('二维码') || msg.includes('qrcode') || msg.includes('qrcode_img_content'))) {
              daemonState.qrUrl = urlMatch[0];
              pushQrToClients(daemonState.qrUrl);
            }
          }
        };

        let qrtModule = null, origGenerate = null;
        try {
          qrtModule = await import('qrcode-terminal');
          origGenerate = qrtModule.default.generate.bind(qrtModule.default);
          qrtModule.default.generate = (content, opts, cb) => {
            QRCode.toDataURL(content, { margin: 1, width: 300 })
              .then(dataUrl => { daemonState.qrUrl = dataUrl; pushQrToClients(dataUrl); })
              .catch(() => { daemonState.qrUrl = content; pushQrToClients(content); });
            origGenerate(content, opts, cb);
          };
        } catch {}

        let accountId;
        try {
          accountId = await sdk.login({ log });
        } finally {
          if (qrtModule && origGenerate) qrtModule.default.generate = origGenerate;
        }

        await runConnectedSession(sdk, accountId);

        if (daemonState.abortController?.signal.aborted) {
          daemonState.state = 'idle'; broadcastStatus(); return;
        }

        console.log('[weixin-gateway] Connection lost, reconnecting in 5s...');
        daemonState.state = 'qr_pending';
        broadcastStatus();
        await sleep(5000);

      } catch (err) {
        if (daemonState.abortController?.signal.aborted ||
            daemonState.loginAbort?.signal.aborted) {
          daemonState.state = 'idle'; broadcastStatus(); return;
        }
        console.error('[weixin-gateway] Error in login loop:', err.message);
        daemonState.state = 'qr_pending';
        broadcastStatus();
        await sleep(5000);
      }
    }
  }

  async function startDaemon(preset) {
    if (daemonState.state !== 'idle') throw new Error('Daemon already running');
    daemonState.defaultPreset   = preset;
    daemonState.abortController = new AbortController();
    daemonState.loginAbort      = daemonState.abortController;
    daemonState.state           = 'qr_pending';
    broadcastStatus();
    const sdk = await loadSdk();
    runLoginLoop(sdk).catch(err => {
      console.error('[weixin-gateway] runLoginLoop fatal:', err.message);
      daemonState.state = 'idle';
      daemonState.abortController = null;
      broadcastStatus();
    });
  }

  // Auto-reconnect using a saved token if WeChat is already logged in.
  async function autoStartIfLoggedIn(preset) {
    try {
      const savedPreset = preset || null;
      if (!savedPreset) return;
      const sdk = await loadSdk();
      if (typeof sdk.isLoggedIn !== 'function' || !sdk.isLoggedIn()) return;
      if (!readSavedAccountId()) return;
      if (daemonState.state !== 'idle') return;
      console.log('[weixin-gateway] Auto-starting daemon with saved token...');
      daemonState.defaultPreset   = savedPreset;
      daemonState.abortController = new AbortController();
      daemonState.loginAbort      = daemonState.abortController;
      daemonState.state           = 'qr_pending';
      broadcastStatus();
      runLoginLoop(sdk, true /* tryTokenFirst */).catch(err => {
        console.error('[weixin-gateway] autoStart runLoginLoop fatal:', err.message);
        daemonState.state = 'idle';
        daemonState.abortController = null;
        broadcastStatus();
      });
    } catch (err) {
      console.log('[weixin-gateway] autoStartIfLoggedIn skipped:', err.message);
    }
  }

  function stopDaemon() {
    if (daemonState.abortController) {
      daemonState.abortController.abort();
      daemonState.abortController = null;
    }
    sessionMeta.clear();
    loadSdk().then(sdk => { try { sdk.logout(); } catch {} }).catch(() => {});
    daemonState.state     = 'idle';
    daemonState.qrUrl     = null;
    daemonState.userInfo  = null;
    daemonState.accountId = null;
    ilink.reset();
    broadcastStatus();
  }

  // ── Restore from saved credentials (no QR scan required) ─────────────────────
  /**
   * Inject an existing WeChat session into a gateway instance that was just created.
   * Useful for testing or CLI tools that already have a valid accountId + contextToken.
   *
   * @param {string}   accountId          - from ~/.openclaw/openclaw-weixin/accounts.json
   * @param {object[]} sessions           - array of { wxId, contextToken, nickname? }
   */
  function restore(accountId, sessions) {
    ilink.load(accountId);
    patchFetchForContextCapture();
    daemonState.accountId = accountId;
    daemonState.state     = 'connected';
    for (const s of sessions) {
      if (!s.wxId || !s.contextToken) continue;
      sessionMeta.set(s.wxId, {
        wxId:         s.wxId,
        nickname:     s.nickname || s.wxId.slice(-8),
        lastActive:   s.lastActive || new Date().toISOString(),
        contextToken: s.contextToken,
      });
    }
  }

  // ── Helper: find first session with a valid contextToken ──────────────────────
  function getActiveSession() {
    for (const [wxId, meta] of sessionMeta) {
      if (meta.contextToken) return { wxId, contextToken: meta.contextToken };
    }
    return null;
  }

  // ── Public SDK methods ────────────────────────────────────────────────────────

  function getStatus() {
    return {
      state:         daemonState.state,
      qrUrl:         daemonState.qrUrl,
      accountId:     daemonState.accountId,
      userInfo:      daemonState.userInfo,
      sessions:      [...sessionMeta.values()].map(m => ({
        wxId:         m.wxId,
        nickname:     m.nickname,
        lastActive:   m.lastActive,
        contextToken: m.contextToken || null,
      })),
      defaultPreset: daemonState.defaultPreset,
    };
  }

  function getSessions() { return getStatus().sessions; }

  function deleteSession(wxId) {
    if (!wxId) throw new Error('wxId required');
    sessionMeta.delete(wxId);
  }

  async function sendText(wxId, text) {
    const meta = sessionMeta.get(wxId);
    if (!meta?.contextToken) throw new Error(`No contextToken for ${wxId} — send a WeChat message first`);
    if (!ilink.loaded) throw new Error('iLink not loaded — connect WeChat first');
    return ilink.sendText(wxId, text, meta.contextToken, 2);
  }

  async function sendVoice(wxId, text, voice) {
    if (!ilink.loaded) throw new Error('iLink not loaded — connect WeChat first');
    const meta = sessionMeta.get(wxId);
    if (!meta?.contextToken) throw new Error(`No contextToken for ${wxId} — send a WeChat message first`);
    if (voice) _userVoice.set(wxId, resolveVoice(voice) || voice);
    return generateAndSendVoice(wxId, text, meta.contextToken);
  }

  async function sendImage(wxId, urlOrPath) {
    if (!ilink.loaded) throw new Error('iLink not loaded — connect WeChat first');
    const meta = sessionMeta.get(wxId);
    if (!meta?.contextToken) throw new Error(`No contextToken for ${wxId} — send a WeChat message first`);
    if (/^https?:\/\//.test(urlOrPath)) return sendImageFromUrl(wxId, meta.contextToken, urlOrPath);
    return sendLocalImageFile(wxId, meta.contextToken, urlOrPath);
  }

  async function sendVideo(wxId, urlOrPath) {
    if (!ilink.loaded) throw new Error('iLink not loaded — connect WeChat first');
    const meta = sessionMeta.get(wxId);
    if (!meta?.contextToken) throw new Error(`No contextToken for ${wxId} — send a WeChat message first`);
    if (/bilibili\.com\/video/.test(urlOrPath)) return downloadAndSendBilibili(wxId, meta.contextToken, urlOrPath);
    if (/^https?:\/\//.test(urlOrPath)) return sendVideoFromUrl(wxId, meta.contextToken, urlOrPath);
    return sendLocalVideoFile(wxId, meta.contextToken, urlOrPath);
  }

  async function sendFile(wxId, filePath) {
    if (!ilink.loaded) throw new Error('iLink not loaded — connect WeChat first');
    const meta = sessionMeta.get(wxId);
    if (!meta?.contextToken) throw new Error(`No contextToken for ${wxId} — send a WeChat message first`);
    const up = await ilink.uploadMedia(wxId, filePath, 3 /* FILE */);
    return ilink.sendItem(wxId, meta.contextToken, {
      type: 4,
      file_item: {
        media: { encrypt_query_param: up.downloadEncryptedQueryParam,
                 aes_key: Buffer.from(up.aeskey).toString('base64'), encrypt_type: 1 },
        file_name: path.basename(filePath),
        len: String(up.fileSize),
      },
    });
  }

  // ── HTTP router (Express) ─────────────────────────────────────────────────────
  // createWeixinRouter() calls this to get an Express Router with all HTTP endpoints.

  function _buildRouter() {
    const router      = Router();
    const sseClients  = new Set();

    // Forward gateway events to SSE clients
    subscribe(event => {
      let msg;
      if (event.type === 'status') {
        msg = `data: ${JSON.stringify({ type: 'weixin_status', state: event.state })}\n\n`;
      } else if (event.type === 'qr') {
        msg = `data: ${JSON.stringify({ qrUrl: event.qrUrl })}\n\n`;
      } else { return; }
      for (const client of sseClients) { try { client.write(msg); } catch {} }
    });

  // ── Routes ───────────────────────────────────────────────────────────────────

  // GET /status
  router.get('/status', (req, res) => {
    res.json(getStatus());
  });

  // GET /qr-sse
  router.get('/qr-sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    sseClients.add(res);
    if (daemonState.qrUrl) {
      res.write(`data: ${JSON.stringify({ qrUrl: daemonState.qrUrl })}\n\n`);
    }
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  });

  // POST /start
  router.post('/start', async (req, res) => {
    const { preset, command } = req.body ?? {};
    const presetType = preset || 'claude-code';
    if (!['claude-code', 'opencode', 'shell', 'custom'].includes(presetType))
      return res.status(400).json({ ok: false, error: 'Invalid preset type' });
    if (presetType === 'custom' && !command)
      return res.status(400).json({ ok: false, error: 'command required for custom preset' });
    if (daemonState.state !== 'idle')
      return res.status(400).json({ ok: false, error: 'Daemon already running', state: daemonState.state });
    const presetObj = { type: presetType, ...(command ? { command } : {}) };
    try {
      await startDaemon(presetObj);
      res.json({ ok: true, state: daemonState.state });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /stop
  router.post('/stop', (req, res) => {
    stopDaemon();
    res.json({ ok: true, state: 'idle' });
  });

  // POST /tts — TTS text → voice → send to wxId (or first active session)
  router.post('/tts', async (req, res) => {
    const { text, wxId: targetWxId } = req.body ?? {};
    if (!text || typeof text !== 'string' || !text.trim())
      return res.status(400).json({ ok: false, error: 'text required' });
    const wxId = targetWxId || getActiveSession()?.wxId;
    if (!wxId) return res.status(400).json({ ok: false, error: 'No active session with contextToken' });
    try {
      await sendVoice(wxId, text.trim());
      res.json({ ok: true, wxId, text: text.trim().slice(0, 50) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /session/:wxId — remove a user session from in-memory state
  router.delete('/session/:wxId', (req, res) => {
    try {
      deleteSession(req.params.wxId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // GET /media/:id — serve stored media blob (MP3, image, video)
  router.get('/media/:id', (req, res) => {
    try {
      const row = storage.getMedia(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      res.set('Content-Type', row.mime);
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(row.data));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /localfile?path=/tmp/xxx.png — serve local screenshot for frontend preview
  router.get('/localfile', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') return res.status(400).end();
    if (!filePath.startsWith('/tmp/')) return res.status(403).end();
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  });

  // GET /rounds?wxId=xxx&limit=30&offset=0
  router.get('/rounds', (req, res) => {
    const { wxId, limit = '30', offset = '0' } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 30, 100);
    const off = parseInt(offset, 10) || 0;
    try {
      const { rounds, total } = storage.getRounds(wxId || null, lim, off);
      res.json({ ok: true, rounds, total });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /messages?wxId=xxx&limit=50&offset=0
  router.get('/messages', (req, res) => {
    const { wxId, limit = '50', offset = '0' } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const off = parseInt(offset, 10) || 0;
    try {
      const { messages, total } = storage.getMessages(wxId || null, lim, off);
      res.json({ ok: true, messages, total });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /resend-silk — re-upload and re-send the last inbound SILK voice file
  router.post('/resend-silk', async (req, res) => {
    const active = getActiveSession();
    if (!active) return res.status(400).json({ ok: false, error: 'No active session with contextToken' });
    if (!ilink.loaded) return res.status(400).json({ ok: false, error: 'iLink credentials not loaded' });
    const silkPath = '/tmp/inbound-voice.silk';
    if (!fs.existsSync(silkPath))
      return res.status(400).json({ ok: false, error: 'No /tmp/inbound-voice.silk — trigger an inbound voice first' });
    try {
      const silkBuf = fs.readFileSync(silkPath);
      const tmpSilk = path.join(os.tmpdir(), `weixin-resend-${Date.now()}.silk`);
      fs.writeFileSync(tmpSilk, silkBuf);
      const up = await ilink.uploadMedia(active.wxId, tmpSilk, 4 /* VOICE */);
      try { fs.unlinkSync(tmpSilk); } catch {}
      await ilink.sendItem(active.wxId, active.contextToken, {
        type: 3,
        voice_item: {
          encode_type: 4, bits_per_sample: 16, sample_rate: 16000, playtime: 1520,
          media: { encrypt_query_param: up.downloadEncryptedQueryParam,
                   aes_key: Buffer.from(up.aeskey).toString('base64'), encrypt_type: 1 },
          mid_size: up.fileSizeCiphertext,
        },
      });
      res.json({ ok: true, silkSize: silkBuf.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /push-demo — send TEXT + IMAGE + FILE + VOICE + VIDEO to first active session
  router.post('/push-demo', async (req, res) => {
    const active = getActiveSession();
    if (!active) {
      return res.status(400).json({
        ok: false,
        error: 'No active session with contextToken. Send any WeChat message first to establish context.',
        sessions: [...sessionMeta.values()].map(m => ({ wxId: m.wxId, nickname: m.nickname, hasToken: !!m.contextToken })),
      });
    }
    if (!ilink.loaded) return res.status(400).json({ ok: false, error: 'iLink credentials not loaded. Connect WeChat first.' });

    const results = [], errors = [];
    const delay   = ms => new Promise(r => setTimeout(r, ms));
    const { wxId, contextToken } = active;

    // TEXT
    try {
      await ilink.sendText(wxId, `① TEXT 测试：纯文本消息 ✅\n当前时间：${new Date().toLocaleString('zh-CN')}`, contextToken, 2);
      results.push('TEXT: OK');
    } catch (err) { errors.push(`TEXT: ${err.message}`); }
    await delay(600);

    // IMAGE — generate PNG via qrcode
    try {
      const imgBuf  = await QRCode.toBuffer('weixin-gateway push-demo image', { margin: 2, width: 200 });
      const imgPath = path.join(os.tmpdir(), `weixin-demo-${Date.now()}.png`);
      fs.writeFileSync(imgPath, imgBuf);
      const up = await ilink.uploadMedia(wxId, imgPath, 1 /* IMAGE */);
      try { fs.unlinkSync(imgPath); } catch {}
      await ilink.sendItem(wxId, contextToken, {
        type: 2,
        image_item: {
          media: { encrypt_query_param: up.downloadEncryptedQueryParam,
                   aes_key: Buffer.from(up.aeskey).toString('base64'), encrypt_type: 1 },
          mid_size: up.fileSizeCiphertext,
        },
      });
      results.push('IMAGE: OK');
    } catch (err) { errors.push(`IMAGE: ${err.message}`); }
    await delay(600);

    // FILE
    try {
      const filePath = path.join(os.tmpdir(), `weixin-demo-${Date.now()}.txt`);
      fs.writeFileSync(filePath, `③ FILE 格式测试\n时间戳：${new Date().toISOString()}\n来自 weixin-gateway push-demo`, 'utf8');
      const up = await ilink.uploadMedia(wxId, filePath, 3 /* FILE */);
      try { fs.unlinkSync(filePath); } catch {}
      await ilink.sendItem(wxId, contextToken, {
        type: 4,
        file_item: {
          media: { encrypt_query_param: up.downloadEncryptedQueryParam,
                   aes_key: Buffer.from(up.aeskey).toString('base64'), encrypt_type: 1 },
          file_name: `demo-${Date.now()}.txt`,
          len: String(up.fileSize),
        },
      });
      results.push('FILE: OK');
    } catch (err) { errors.push(`FILE: ${err.message}`); }
    await delay(600);

    // VOICE — TTS "你好" → SILK
    try {
      await generateAndSendVoice(wxId, '你好', contextToken);
      results.push('VOICE: OK');
    } catch (err) { errors.push(`VOICE: ${err.message}`); }
    await delay(600);

    // VIDEO — 1s blue-screen MP4 via ffmpeg
    try {
      const videoPath = path.join(os.tmpdir(), `weixin-demo-${Date.now()}.mp4`);
      await new Promise((resolve, reject) => {
        execFile(FFMPEG, [
          '-y',
          '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '64k',
          videoPath,
        ], { timeout: 15000 }, (err) => err ? reject(err) : resolve());
      });
      const up = await ilink.uploadMedia(wxId, videoPath, 2 /* VIDEO */);
      try { fs.unlinkSync(videoPath); } catch {}
      await ilink.sendItem(wxId, contextToken, {
        type: 5,
        video_item: {
          media: { encrypt_query_param: up.downloadEncryptedQueryParam,
                   aes_key: Buffer.from(up.aeskey).toString('base64'), encrypt_type: 1 },
          video_size: up.fileSizeCiphertext,
        },
      });
      results.push('VIDEO: OK');
    } catch (err) { errors.push(`VIDEO: ${err.message}`); }

    res.json({ ok: true, wxId, results, errors });
  });

    return router;
  } // end _buildRouter

  return {
    // Lifecycle
    start:           startDaemon,
    stop:            stopDaemon,
    startIfLoggedIn: autoStartIfLoggedIn,
    restore,
    // Status
    getStatus,
    getSessions,
    // Proactive sends
    sendText,
    sendVoice,
    sendImage,
    sendVideo,
    sendFile,
    // Session management
    deleteSession,
    // Events
    subscribe,
    // Internal — used by createWeixinRouter
    _buildRouter,
  };
}

/**
 * Create an Express Router wired to a WeChat gateway.
 * @param {object} config — same options as createWeixinGateway
 * @returns {{ router: import('express').Router, autoStartIfLoggedIn: () => Promise<void> }}
 */
function createWeixinRouter(config = {}) {
  const gw = createWeixinGateway(config);
  return { router: gw._buildRouter(), autoStartIfLoggedIn: gw.startIfLoggedIn };
}

const { MemoryAdapter } = require('./adapters/memory');

module.exports = { createWeixinGateway, createWeixinRouter, MemoryAdapter };
