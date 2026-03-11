import devZh from './dev-zh.js';
import devEn from './dev-en.js';
import writingZh from './writing-zh.js';
import writingEn from './writing-en.js';
import tradingZh from './trading-zh.js';
import tradingEn from './trading-en.js';
import videoZh from './video-zh.js';
import videoEn from './video-en.js';
import roleplayDevZh from './roleplay-dev-zh.js';
import roleplayDevEn from './roleplay-dev-en.js';
import roleplayWritingZh from './roleplay-writing-zh.js';
import roleplayWritingEn from './roleplay-writing-en.js';
import roleplayTradingZh from './roleplay-trading-zh.js';
import roleplayTradingEn from './roleplay-trading-en.js';
import roleplayVideoZh from './roleplay-video-zh.js';
import roleplayVideoEn from './roleplay-video-en.js';

const templates = {
  dev: { 'zh-CN': devZh, en: devEn },
  writing: { 'zh-CN': writingZh, en: writingEn },
  trading: { 'zh-CN': tradingZh, en: tradingEn },
  video: { 'zh-CN': videoZh, en: videoEn },
};

/**
 * Get template roles for the given type and locale.
 * Falls back to zh-CN if the locale is not available.
 */
export function getTemplate(type, locale) {
  const tmpl = templates[type];
  if (!tmpl) return null;
  return tmpl[locale] || tmpl['zh-CN'] || null;
}

// =====================
// Role Play templates (single-conversation multi-role)
// =====================
const rolePlayTemplates = {
  dev: { 'zh-CN': roleplayDevZh, en: roleplayDevEn },
  writing: { 'zh-CN': roleplayWritingZh, en: roleplayWritingEn },
  trading: { 'zh-CN': roleplayTradingZh, en: roleplayTradingEn },
  video: { 'zh-CN': roleplayVideoZh, en: roleplayVideoEn },
};

/**
 * Get Role Play template roles for the given type and locale.
 * Falls back to zh-CN if the locale is not available.
 */
export function getRolePlayTemplate(type, locale) {
  const tmpl = rolePlayTemplates[type];
  if (!tmpl) return null;
  return tmpl[locale] || tmpl['zh-CN'] || null;
}
