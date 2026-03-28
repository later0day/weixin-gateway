'use strict';

/**
 * Media send helpers — fetch, upload, and forward media items to WeChat.
 *
 * Usage:
 *   const { createMediaSender } = require('./lib/media');
 *   const media = createMediaSender({ ilink, ffmpeg, ytdlp, mediaEnv });
 *   await media.sendImageFromUrl(wxId, ctxToken, url);
 *   await media.sendLocalImageFile(wxId, ctxToken, filePath);
 *   await media.sendVideoFromUrl(wxId, ctxToken, url);
 *   await media.downloadAndSendBilibili(wxId, ctxToken, url);
 */

const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const { execFile } = require('child_process');

/**
 * @param {{ ilink: object, ffmpeg: string, ytdlp: string, mediaEnv: object }} deps
 */
function createMediaSender({ ilink, ffmpeg, ytdlp, mediaEnv }) {
  const TMPDIR = os.tmpdir();

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /** Build the media object used in every image/video/voice item_list entry */
  function _mediaObj(up) {
    return {
      encrypt_query_param: up.downloadEncryptedQueryParam,
      aes_key:             Buffer.from(up.aeskey).toString('base64'),
      encrypt_type:        1,
    };
  }

  /** Download a remote URL to a local temp file. Returns the temp path. */
  async function fetchToTempFile(url, ext) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const buf     = Buffer.from(await res.arrayBuffer());
    const tmpPath = path.join(TMPDIR, `weixin-dl-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
  }

  // ── Public send functions ─────────────────────────────────────────────────────

  /** Fetch an image URL and send as image_item. */
  async function sendImageFromUrl(wxId, ctxToken, url) {
    if (!ctxToken) return;
    const extMatch = url.match(/\.(jpe?g|png|gif|webp)(\?|$)/i);
    const ext      = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    const tmpPath  = await fetchToTempFile(url, ext);
    try {
      const up = await ilink.uploadMedia(wxId, tmpPath, 1 /* IMAGE */);
      await ilink.sendItem(wxId, ctxToken, {
        type: 2,
        image_item: { media: _mediaObj(up), mid_size: up.fileSizeCiphertext },
      });
      console.log(`[weixin-gateway] image sent to ${wxId} from ${url}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  /** Send a local file (e.g. screenshot) that already exists on disk as an image. */
  async function sendLocalImageFile(wxId, ctxToken, filePath) {
    if (!ctxToken) {
      console.warn(`[weixin-gateway] sendLocalImageFile: no contextToken for ${wxId}, cannot send ${filePath}`);
      return;
    }
    if (!fs.existsSync(filePath)) throw new Error(`截图文件不存在: ${filePath}`);
    const up = await ilink.uploadMedia(wxId, filePath, 1 /* IMAGE */);
    await ilink.sendItem(wxId, ctxToken, {
      type: 2,
      image_item: { media: _mediaObj(up), mid_size: up.fileSizeCiphertext },
    });
    console.log(`[weixin-gateway] screenshot sent to ${wxId} from ${filePath}`);
  }

  /** Fetch a video URL and send as video_item. */
  async function sendVideoFromUrl(wxId, ctxToken, url) {
    if (!ctxToken) return;
    const tmpPath = await fetchToTempFile(url, 'mp4');
    try {
      const up = await ilink.uploadMedia(wxId, tmpPath, 2 /* VIDEO */);
      await ilink.sendItem(wxId, ctxToken, {
        type: 5,
        video_item: { media: _mediaObj(up), video_size: up.fileSizeCiphertext },
      });
      console.log(`[weixin-gateway] video sent to ${wxId} from ${url}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  /**
   * Download a Bilibili video with yt-dlp and send it as a video_item.
   * Probes codec; re-encodes to H.264 if needed for WeChat compatibility.
   * Fire-and-forget: call with .catch().
   */
  async function downloadAndSendBilibili(wxId, ctxToken, url) {
    if (!ctxToken) return;
    const stamp       = Date.now();
    const outTemplate = path.join(TMPDIR, `weixin-bili-${stamp}.%(ext)s`);

    await new Promise((resolve, reject) => {
      execFile(ytdlp, [
        '--no-playlist',
        // Prefer H.264 (avc1) — WeChat only supports H.264. Fall back to any mp4 then best if unavailable.
        '-f', 'bestvideo[ext=mp4][vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1][height<=720]+bestaudio/bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--ffmpeg-location', path.dirname(ffmpeg),
        '-o', outTemplate,
        url,
      ], { timeout: 180000, env: mediaEnv }, (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).slice(0, 300)));
        else resolve();
      });
    });

    // Glob actual output file (extension may differ despite remux flag)
    const outFiles = fs.readdirSync(TMPDIR).filter(f => f.startsWith(`weixin-bili-${stamp}.`));
    let outPath    = outFiles.length > 0 ? path.join(TMPDIR, outFiles[0]) : path.join(TMPDIR, `weixin-bili-${stamp}.mp4`);

    // Probe codec; re-encode to H.264 if necessary
    try {
      const { stdout: probeOut } = await new Promise((res, rej) => {
        execFile(path.join(path.dirname(ffmpeg), 'ffprobe'), [
          '-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', outPath,
        ], { timeout: 10000 }, (err, stdout) => err ? rej(err) : res({ stdout }));
      });
      const vs = JSON.parse(probeOut)?.streams?.[0];
      console.log(`[weixin-gateway] bilibili video codec=${vs?.codec_name} profile=${vs?.profile} w=${vs?.width} h=${vs?.height} dur=${vs?.duration}`);
      if (vs?.codec_name && vs.codec_name !== 'h264') {
        console.log(`[weixin-gateway] re-encoding ${vs.codec_name} → H.264 for WeChat compatibility`);
        const recodePath = path.join(TMPDIR, `weixin-bili-${stamp}-h264.mp4`);
        await new Promise((res, rej) => {
          execFile(ffmpeg, [
            '-i', outPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', recodePath,
          ], { timeout: 300000, env: mediaEnv }, (err, _stdout, stderr) => {
            if (err) rej(new Error((stderr || err.message).slice(0, 300)));
            else res();
          });
        });
        try { fs.unlinkSync(outPath); } catch {}
        outPath = recodePath;
        console.log(`[weixin-gateway] re-encode done → ${recodePath}`);
      }
    } catch (e) { console.log(`[weixin-gateway] ffprobe/recode error: ${e.message}`); }

    try {
      const up = await ilink.uploadMedia(wxId, outPath, 2 /* VIDEO */);
      await ilink.sendItem(wxId, ctxToken, {
        type: 5,
        video_item: { media: _mediaObj(up), video_size: up.fileSizeCiphertext },
      });
      console.log(`[weixin-gateway] bilibili video sent to ${wxId} size=${up.fileSizeCiphertext}`);
    } finally {
      try { fs.unlinkSync(outPath); } catch {}
    }
  }

  return { fetchToTempFile, sendImageFromUrl, sendLocalImageFile, sendVideoFromUrl, downloadAndSendBilibili };
}

module.exports = { createMediaSender };
