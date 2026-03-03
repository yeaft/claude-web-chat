/**
 * Shared Markdown rendering utilities
 * Extracted from MessageItem.js for reuse in CrewChatView
 */

let _configured = false;

export function configureMarked() {
  if (_configured || typeof marked === 'undefined') return;
  marked.setOptions({
    highlight: (code, lang) => {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      return code;
    },
    breaks: true,
    gfm: true
  });
  _configured = true;
}

export function addCodeBlockCopyButtons(html) {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (match, attrs, code) => {
      const langMatch = attrs.match(/class="language-(\w+)"/);
      const lang = langMatch ? langMatch[1] : '';
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${lang}</span>
          <button class="code-copy-btn" onclick="window.copyCodeBlock(this)" title="Copy">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
          </button>
        </div>
        <pre><code${attrs}>${code}</code></pre>
      </div>`;
    });
}

export function wrapTables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g,
    (match) => `<div class="table-scroll-wrapper">${match}</div>`);
}

export function simpleMarkdownFallback(text) {
  if (!text || typeof text !== 'string') return '';
  const escape = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<div class="code-block-wrapper"><pre><code class="language-${lang}">${escape(code.trim())}</code></pre></div>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\n/g, '<br>');
}

/**
 * Render markdown text to HTML.
 * Strips ROUTE blocks, uses marked.js with code highlighting,
 * falls back to simple regex-based rendering.
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  // Strip ROUTE blocks
  text = text.replace(/---ROUTE---[\s\S]*?---END_ROUTE---/g, '').trim();
  if (!text) return '';

  configureMarked();

  if (typeof marked !== 'undefined') {
    try {
      const html = marked.parse(text);
      return wrapTables(addCodeBlockCopyButtons(html));
    } catch (e) {
      console.error('Markdown parsing error:', e);
    }
  }
  return simpleMarkdownFallback(text);
}
