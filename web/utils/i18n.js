/**
 * Lightweight i18n module for WebChat
 * Uses Vue.ref for reactive locale tracking — template $t() calls auto-update on language change.
 */

let _locale = null;     // Vue.ref — reactive
let _translations = {};  // { 'zh-CN': {...}, 'en': {...} }

/**
 * Translate a key, with optional interpolation.
 * @param {string} key - Dot-separated translation key
 * @param {Object} [params] - Interpolation parameters, e.g. { count: 3 }
 * @returns {string}
 */
export function t(key, params) {
  const lang = _locale?.value || 'zh-CN';
  const dict = _translations[lang] || _translations['zh-CN'] || {};
  let text = dict[key];

  // Fallback to zh-CN if current locale misses the key
  if (text === undefined && lang !== 'zh-CN') {
    text = (_translations['zh-CN'] || {})[key];
  }
  // Final fallback: return the key itself
  if (text === undefined) return key;

  // Interpolation: replace {name} with params.name
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return text;
}

/**
 * Get the current locale value (non-reactive, for JS usage).
 */
export function getLocale() {
  return _locale?.value || 'zh-CN';
}

/**
 * Set locale, persist to localStorage, update <html lang>.
 */
export function setLocale(locale) {
  if (!_translations[locale]) return;
  if (_locale) _locale.value = locale;
  localStorage.setItem('locale', locale);
  document.documentElement.setAttribute('lang', locale);
}

/**
 * Detect initial locale from localStorage or browser settings.
 */
function detectLocale() {
  const stored = localStorage.getItem('locale');
  if (stored && _translations[stored]) return stored;

  const browserLang = navigator.language || navigator.userLanguage || '';
  if (browserLang.startsWith('en')) return 'en';
  return 'zh-CN';
}

/**
 * Install i18n into a Vue app.
 * Call this BEFORE app.mount().
 *
 * @param {import('vue').App} app - Vue app instance
 * @param {Object} translations - { 'zh-CN': {...}, 'en': {...} }
 */
export function createI18n(app, translations) {
  _translations = translations;
  _locale = Vue.ref(detectLocale());

  // Set initial <html lang>
  document.documentElement.setAttribute('lang', _locale.value);

  // Make $t available in all templates (reactive because t() reads _locale.value)
  app.config.globalProperties.$t = t;
  app.config.globalProperties.$locale = _locale;

  // Also provide for Composition API inject
  app.provide('t', t);
  app.provide('locale', _locale);

  return { t, setLocale, getLocale, locale: _locale };
}
