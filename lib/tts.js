'use strict';

/**
 * TTS pipeline factory.
 *
 * Pipeline: text → msedge-tts MP3 → ffmpeg PCM s16le 16kHz → silk-sdk SILK → CDN upload → voice_item
 *
 * Usage:
 *   const generateAndSendVoice = createTtsPipeline({ ffmpeg, mediaEnv, ilink, getUserVoice, getPairId, logMedia });
 *   await generateAndSendVoice(wxId, text, contextToken);
 */

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const crypto       = require('crypto');
const { execFile } = require('child_process');

/**
 * @param {{ ffmpeg: string, mediaEnv: object, ilink: object, getUserVoice: Function, getPairId: Function, logMedia: Function }} deps
 * @returns {(wxId: string, text: string, contextToken: string) => Promise<void>}
 */
function createTtsPipeline({ ffmpeg, mediaEnv, ilink, getUserVoice, getPairId, logMedia }) {
  const TMPDIR = os.tmpdir();
  return async function generateAndSendVoice(wxId, text, contextToken) {
    if (!ilink.loaded || !contextToken) return;

    // Strip attachment hint suffix and code/markdown artifacts; cap at 200 chars for TTS
    const ttsText = text
      .replace(/📄[^\n]*$/m, '')
      .replace(/[▸【】]/g, '')
      .trim()
      .slice(0, 200);
    if (!ttsText) return;

    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const silkSdk = require('silk-sdk');
    const stamp    = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const mp3Path  = path.join(TMPDIR, `weixin-tts-${stamp}.mp3`);
    const pcmPath  = path.join(TMPDIR, `weixin-tts-${stamp}.pcm`);
    const silkPath = path.join(TMPDIR, `weixin-tts-${stamp}.silk`);

    // Capture pair_id synchronously before any awaits (avoids race with next inbound message)
    const mediaPairId = getPairId(wxId);

    try {
      // 1. TTS → MP3
      const tts = new MsEdgeTTS();
      await tts.setMetadata(getUserVoice(wxId), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(ttsText);
      const mp3Chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on('data',  c => mp3Chunks.push(c));
        audioStream.on('end',   resolve);
        audioStream.on('error', reject);
      });
      fs.writeFileSync(mp3Path, Buffer.concat(mp3Chunks));
      // Save MP3 for in-browser preview (before encoding to SILK)
      logMedia(wxId, mediaPairId, 'out', 'voice', 'audio/mpeg', fs.readFileSync(mp3Path));

      // 2. MP3 → PCM s16le 16kHz mono (match WeChat iOS native voice format)
      await new Promise((resolve, reject) => {
        execFile(ffmpeg, [
          '-y', '-i', mp3Path,
          '-f', 's16le', '-ar', '16000', '-ac', '1',
          pcmPath,
        ], { timeout: 15000, env: mediaEnv }, err => err ? reject(err) : resolve());
      });

      // 3. PCM → SILK V3 16kHz tencent (match WeChat iOS inbound: sample_rate=16000)
      const pcmBuf   = fs.readFileSync(pcmPath);
      const playtime = Math.round(pcmBuf.length / 32000 * 1000); // ms (16kHz×2bytes/sample)
      const silkBuf  = silkSdk.encode(pcmBuf, { fsHz: 16000, tencent: true });
      fs.writeFileSync(silkPath, silkBuf);
      console.log(`[weixin-gateway] TTS pipeline: mp3=${fs.statSync(mp3Path).size}B pcm=${pcmBuf.length}B(${(pcmBuf.length / 32000).toFixed(2)}s) silk=${silkBuf.length}B playtime=${playtime}ms`);

      // 4. Upload SILK to WeChat CDN
      const up = await ilink.uploadMedia(wxId, silkPath, 4 /* VOICE */);

      // 5. Send as voice_item
      // After CDN change (2026-03-27): VOICE uploads no longer return queryParam.
      // Use uploadParam as download token — getuploadurl returns upload_param which is a valid
      // encrypted_query_param token for CDN downloads (confirmed: server-side returns 200).
      const voiceItem = {
        type: 3, // VOICE
        voice_item: {
          encode_type:     4,
          bits_per_sample: 16,
          sample_rate:     16000,
          playtime,
          media: {
            encrypt_query_param: up.uploadParam,
            aes_key:             Buffer.from(up.aeskey).toString('base64'),
            encrypt_type:        1,
          },
          mid_size: up.fileSizeCiphertext,
        },
      };
      console.log(`[weixin-gateway] TTS voice_item: ${JSON.stringify(voiceItem.voice_item)}`);
      await ilink.sendItem(wxId, contextToken, voiceItem);
      console.log(`[weixin-gateway] TTS voice sent to ${wxId} as voice_item silk=${silkBuf.length}B playtime=${playtime}ms`);
    } finally {
      for (const p of [mp3Path, pcmPath, silkPath]) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  };
}

module.exports = { createTtsPipeline };
