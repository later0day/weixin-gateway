'use strict';

/**
 * ILinkClient — encapsulates all direct iLink API calls.
 *
 * Usage:
 *   const { createILinkClient } = require('./lib/ilink');
 *   const ilink = createILinkClient();
 *   ilink.load(accountId);           // load credentials from ~/.openclaw
 *   await ilink.sendText(to, text, ctxToken);
 *   await ilink.sendItem(to, ctxToken, item);
 *   const up = await ilink.uploadMedia(to, filePath, mediaType);
 */

const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

function createILinkClient() {
  let _creds = null; // { token, baseUrl }

  // ── Credential management ────────────────────────────────────────────────────

  function load(accountId) {
    try {
      const normalized = accountId.trim().toLowerCase().replace(/[@.]/g, '-');
      const file = path.join(
        os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts', `${normalized}.json`
      );
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      _creds = {
        token:   data.token,
        baseUrl: data.baseUrl || 'https://ilinkai.weixin.qq.com',
      };
      console.log('[weixin-gateway] iLink credentials loaded for direct API calls');
    } catch (err) {
      console.error('[weixin-gateway] loadIlinkCreds error:', err.message);
    }
  }

  function reset() { _creds = null; }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  function _buildHeaders(token, body) {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const wxUin  = Buffer.from(String(uint32), 'utf8').toString('base64');
    return {
      'Content-Type':      'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization':     `Bearer ${token.trim()}`,
      'Content-Length':    Buffer.byteLength(body),
      'X-WECHAT-UIN':      wxUin,
    };
  }

  // ── Send helpers ─────────────────────────────────────────────────────────────

  /** MessageState: 1 = GENERATING, 2 = FINISH */
  async function sendText(to, text, contextToken, messageState = 2) {
    if (!_creds || !contextToken) return false;
    const clientId = `openclaw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const body = JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id:   to,
        client_id:    clientId,
        message_type:  2, // BOT
        message_state: messageState,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: '0.2.0' },
    });
    try {
      const url = new URL(`${_creds.baseUrl}/ilink/bot/sendmessage`);
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: url.hostname,
          path:     url.pathname,
          method:   'POST',
          headers:  _buildHeaders(_creds.token, body),
        }, res => { res.resume(); resolve(); });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      return true;
    } catch (err) {
      console.error('[weixin-gateway] ilinkSendText error:', err.message);
      return false;
    }
  }

  /** Send any single item_list entry (IMAGE / FILE / VIDEO / VOICE) */
  async function sendItem(to, contextToken, item) {
    if (!_creds || !contextToken) return false;
    const clientId = `openclaw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const itemType = item.type;
    const body = JSON.stringify({
      msg: {
        from_user_id:  '',
        to_user_id:    to,
        client_id:     clientId,
        message_type:  2, // BOT
        message_state: 2, // FINISH
        item_list:     [item],
        context_token: contextToken,
      },
      base_info: { channel_version: '0.2.0' },
    });
    console.log(`[ilinkSend] sending type=${itemType} item=${JSON.stringify(item).slice(0, 400)}`);
    const u = new URL(`${_creds.baseUrl}/ilink/bot/sendmessage`);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        path:     u.pathname,
        method:   'POST',
        headers:  _buildHeaders(_creds.token, body),
      }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          console.log(`[ilinkSend] type=${itemType} status=${res.statusCode} body=${d.slice(0, 300)}`);
          try {
            const parsed = JSON.parse(d);
            if (parsed.base_resp?.ret !== 0 && parsed.base_resp?.ret !== undefined) {
              console.error(`[ilinkSend] API error type=${itemType} ret=${parsed.base_resp.ret} errmsg=${parsed.base_resp.errmsg}`);
            } else if (parsed.errcode && parsed.errcode !== 0) {
              console.error(`[ilinkSend] API error type=${itemType} errcode=${parsed.errcode} errmsg=${parsed.errmsg}`);
            }
          } catch {}
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    return true;
  }

  // ── Media upload ─────────────────────────────────────────────────────────────

  /**
   * Upload a local file to WeChat CDN.
   * mediaType: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE
   * Returns { downloadEncryptedQueryParam, queryParam, shortParam, uploadParam, aeskey, fileSize, fileSizeCiphertext }
   */
  async function uploadMedia(toUserId, filePath, mediaType) {
    if (!_creds) throw new Error('iLink credentials not loaded');
    const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

    const plaintext  = fs.readFileSync(filePath);
    const rawsize    = plaintext.length;
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const filesize   = Math.ceil((rawsize + 1) / 16) * 16; // AES-128-ECB PKCS7 padded size
    const filekey    = crypto.randomBytes(16).toString('hex');
    const aeskey     = crypto.randomBytes(16);

    // 1. Get pre-signed upload URL
    const uploadBody = JSON.stringify({
      filekey,
      media_type:    mediaType,
      to_user_id:    toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey:        aeskey.toString('hex'),
      base_info:     { channel_version: '0.2.0' },
    });
    const uploadResp = await new Promise((resolve, reject) => {
      const u = new URL(`${_creds.baseUrl}/ilink/bot/getuploadurl`);
      const req = https.request({
        hostname: u.hostname,
        path:     u.pathname,
        method:   'POST',
        headers:  _buildHeaders(_creds.token, uploadBody),
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(uploadBody);
      req.end();
    });

    console.log(`[weixin-gateway] getuploadurl resp (type=${mediaType}):`, JSON.stringify(uploadResp));
    const uploadParam = uploadResp.upload_param;
    if (!uploadParam)
      throw new Error(`getuploadurl no upload_param: ${JSON.stringify(uploadResp)}`);

    // 2. Encrypt with AES-128-ECB
    const cipher     = crypto.createCipheriv('aes-128-ecb', aeskey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    // 3. POST ciphertext to CDN
    const cdnUrl = `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    const cdnRes = await fetch(cdnUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    ciphertext,
    });
    const cdnBody = await cdnRes.text();
    if (!cdnRes.ok) {
      const errHeaders = {};
      cdnRes.headers.forEach((v, k) => { errHeaders[k] = v; });
      console.log(`[weixin-gateway] CDN upload error headers mediaType=${mediaType}:`, JSON.stringify(errHeaders));
      throw new Error(`CDN upload failed: ${cdnRes.status} ${cdnBody}`);
    }
    const allHeaders = {};
    cdnRes.headers.forEach((v, k) => { allHeaders[k] = v; });
    console.log(`[weixin-gateway] CDN upload headers mediaType=${mediaType}:`, JSON.stringify(allHeaders));
    if (cdnBody) console.log(`[weixin-gateway] CDN upload body mediaType=${mediaType}:`, cdnBody.slice(0, 500));

    // CDN returns two tokens:
    //   x-encrypted-query-param (queryParam) — preferred for VOICE and FILE
    //   x-encrypted-param        (shortParam) — correct for IMAGE and VIDEO
    const queryParam = cdnRes.headers.get('x-encrypted-query-param');
    const shortParam = cdnRes.headers.get('x-encrypted-param');
    console.log(`[weixin-gateway] CDN tokens mediaType=${mediaType} queryParam=${queryParam?.length ?? 'missing'}chars shortParam=${shortParam?.length ?? 'missing'}chars`);

    const downloadParam = (mediaType === 1 || mediaType === 2) ? (shortParam || queryParam) : (queryParam || shortParam);
    if (!downloadParam) throw new Error('CDN upload missing download token response header');
    console.log(`[weixin-gateway] CDN upload OK mediaType=${mediaType} downloadToken=${downloadParam.length}chars rawsize=${rawsize}`);

    return {
      downloadEncryptedQueryParam: downloadParam,
      queryParam:         queryParam || null,
      shortParam:         shortParam || null,
      uploadParam,
      aeskey:             aeskey.toString('hex'),
      fileSize:           rawsize,
      fileSizeCiphertext: filesize,
    };
  }

  return {
    load,
    reset,
    sendText,
    sendItem,
    uploadMedia,
    get loaded() { return !!_creds; },
  };
}

module.exports = { createILinkClient };
