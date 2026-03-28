'use strict';

/**
 * TTS voice aliases, notes, and resolver.
 * Pure data — no external state or side effects.
 */

const WECHAT_VOICE_DEFAULT = 'zh-CN-XiaoyiNeural';

// { alias → ShortName }
const VOICE_ALIASES = {
  '晓晓': 'zh-CN-XiaoxiaoNeural',  'xiaoxiao': 'zh-CN-XiaoxiaoNeural',
  '晓伊': 'zh-CN-XiaoyiNeural',    'xiaoyi':   'zh-CN-XiaoyiNeural',
  '云希': 'zh-CN-YunxiNeural',     'yunxi':    'zh-CN-YunxiNeural',
  '云扬': 'zh-CN-YunyangNeural',   'yunyang':  'zh-CN-YunyangNeural',
  '云健': 'zh-CN-YunjianNeural',   'yunjian':  'zh-CN-YunjianNeural',
  '云夏': 'zh-CN-YunxiaNeural',    'yunxia':   'zh-CN-YunxiaNeural',
  '东北': 'zh-CN-liaoning-XiaobeiNeural', 'xiaobei': 'zh-CN-liaoning-XiaobeiNeural',
  '陕西': 'zh-CN-shaanxi-XiaoniNeural',   'xiaoni':  'zh-CN-shaanxi-XiaoniNeural',
  '台湾': 'zh-TW-HsiaoChenNeural', 'taiwan':   'zh-TW-HsiaoChenNeural',
  '晓雨': 'zh-TW-HsiaoYuNeural',   'xiaoyu':   'zh-TW-HsiaoYuNeural',
  '云哲': 'zh-TW-YunJheNeural',    'yunjhe':   'zh-TW-YunJheNeural',
  '晓佳': 'zh-HK-HiuGaaiNeural',   'yue':      'zh-HK-HiuGaaiNeural',
  '晓曼': 'zh-HK-HiuMaanNeural',   'hiuman':   'zh-HK-HiuMaanNeural',
  '云龙': 'zh-HK-WanLungNeural',   'wanlung':  'zh-HK-WanLungNeural',
  'ava':    'en-US-AvaMultilingualNeural',
  'emma':   'en-US-EmmaMultilingualNeural',
  'andrew': 'en-US-AndrewMultilingualNeural',
  'brian':  'en-US-BrianMultilingualNeural',
  'jenny':  'en-US-JennyNeural',
  'aria':   'en-US-AriaNeural',
  'guy':    'en-US-GuyNeural',
  'sonia':  'en-GB-SoniaNeural',
  'ryan':   'en-GB-RyanNeural',
};

// 中文别名对应的简要备注（用于 /voice 查询展示）
const VOICE_NOTES = {
  '晓晓': '女 · 温暖自然 ⭐',
  '晓伊': '女 · 活泼（默认）',
  '云希': '男 · 活泼阳光',
  '云扬': '男 · 专业播报',
  '云健': '男 · 激情',
  '云夏': '男 · 可爱',
  '东北': '女 · 东北方言',
  '陕西': '女 · 陕西方言',
  '台湾': '女 · 台湾腔',
  '晓雨': '女 · 台湾腔',
  '云哲': '男 · 台湾腔',
  '晓佳': '女 · 粤语',
  '晓曼': '女 · 粤语',
  '云龙': '男 · 粤语',
  'ava':    '女 · 多语言 中英自动切换',
  'emma':   '女 · 多语言 中英自动切换',
  'andrew': '男 · 多语言 中英自动切换',
  'brian':  '男 · 多语言 中英自动切换',
  'jenny':  '女 · 英文 亲切',
  'aria':   '女 · 英文 自信',
  'guy':    '男 · 英文 激情',
  'sonia':  '女 · 英式',
  'ryan':   '男 · 英式',
};

/**
 * Resolve an alias or ShortName to a canonical msedge-tts ShortName.
 * Returns null for unrecognised inputs that don't contain "Neural".
 */
function resolveVoice(input) {
  const k = input.trim().toLowerCase();
  return VOICE_ALIASES[input.trim()] || VOICE_ALIASES[k] || (input.includes('Neural') ? input.trim() : null);
}

module.exports = { WECHAT_VOICE_DEFAULT, VOICE_ALIASES, VOICE_NOTES, resolveVoice };
