/**
 * memory/prompt-cleanup.js — prompt-facing memory text hygiene.
 *
 * Disk memory can carry operational metadata such as the per-scope Dream
 * marker. That metadata is useful for schedulers, not for the model. Keep the
 * storage schema compatible and clean only at read / prompt boundaries.
 */

const DREAM_STATE_BLOCK_RE = /<!--\s*dream-state\s*-->[\s\S]*?<!--\s*\/dream-state\s*-->/gi;
const DREAM_RECENT_TRANSCRIPT_HEADER_RE = /^\s*Recent session details from the latest Dream pass:\s*$/i;
const DREAM_TRANSCRIPT_LINE_RE = /^\s*[-*]\s+\S+\s+(?:user|assistant|tool)(?:\/[^:\s]+)?:\s*/i;

const TRANSIENT_MEMORY_RE = /\b(work\s*item|current\s+(?:state|work|task)|in[_ -]?progress|todo|next\s+step|blocker|blocked|pr\s*#?\d+|pull\s+request|review|merge\s+commit|release\s+tag|tag\s+v\d|v\d+\.\d+\.\d+)\b|(?:工作项|当前(?:状态|任务|工作)|正在|待办|下一步|阻塞|评审|合并|发布|标签|已推|已合并|已完成)/i;
const ASCII_WORD_RE = /[a-z0-9_]{3,}/gi;
const CJK_RUN_RE = /[\u4e00-\u9fff]{2,}/g;
const MARKDOWN_LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const COMMON_INTENT_TOKENS = new Set([
  'current', 'state', 'work', 'task', 'item', 'items', 'todo', 'todos',
  'next', 'step', 'steps', 'done', 'completed', 'finish', 'finished',
  'merge', 'merged', 'review', 'reviewed', 'release', 'tag', 'tags',
  'pr', 'pull', 'request', 'issue', 'fix', 'feat', 'test', 'tests',
  'dream', 'memory', 'session', 'topic', 'status', 'blocker', 'blocked',
  '当前', '状态', '任务', '工作', '工作项', '待办', '下一步', '完成', '已完成',
  '合并', '评审', '发布', '标签', '记忆', '主题', '阻塞', '正在',
  '内容', '用户', '需求', '设计', '决策', '搜索', '发现', '需要', '应该',
  '添加', '无关', '不相', '相干', '完全', '明细', '看看', '还有', '这个',
  '比如', '每个', '如果',
]);

/**
 * Remove Dream scheduler metadata blocks from memory text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDreamStateBlocks(text) {
  return String(text || '').replace(DREAM_STATE_BLOCK_RE, '').trim();
}

/**
 * Clean text before it is eligible for prompt injection.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanMemoryPromptText(text) {
  return stripGeneratedDreamTranscript(stripDreamStateBlocks(text))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripGeneratedDreamTranscript(text) {
  const kept = [];
  let generatedTranscript = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (DREAM_RECENT_TRANSCRIPT_HEADER_RE.test(line)) {
      generatedTranscript = true;
      continue;
    }
    if (generatedTranscript && DREAM_TRANSCRIPT_LINE_RE.test(line)) continue;
    generatedTranscript = false;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether a memory item describes short-lived execution state rather than a
 * stable preference / project fact. Transient memory is still valid on disk, but
 * should only enter the prompt when it is related to the current user turn.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isTransientMemoryText(text) {
  return TRANSIENT_MEMORY_RE.test(cleanMemoryPromptText(text));
}

/**
 * Conservative prompt relevance gate for transient Dream memories. Stable
 * memories are handled by the caller; this function only answers whether a
 * known-transient item has lexical overlap with the current user request.
 *
 * @param {string} memoryText
 * @param {string} userText
 * @returns {boolean}
 */
export function isTransientMemoryRelevant(memoryText, userText) {
  return isMemoryPromptRelevant(memoryText, userText);
}

/**
 * Conservative lexical relevance check used only at prompt assembly time. It is
 * deliberately not semantic clustering: if there is no concrete token overlap,
 * the memory should win again through FTS when the user asks for it explicitly.
 *
 * @param {string} memoryText
 * @param {string} userText
 * @returns {boolean}
 */
export function isMemoryPromptRelevant(memoryText, userText) {
  const memoryTokens = promptRelevanceTokens(memoryText);
  const userTokens = promptRelevanceTokens(userText);
  if (memoryTokens.size === 0 || userTokens.size === 0) return false;
  for (const token of memoryTokens) {
    if (userTokens.has(token)) return true;
  }
  return false;
}

/**
 * Drop irrelevant transient paragraphs while preserving stable memory text. This
 * keeps disk memory intact; it only trims what enters the current prompt.
 *
 * @param {string} text
 * @param {string} userText
 * @returns {string}
 */
export function filterMemoryPromptTextForPrompt(text, userText) {
  const cleaned = cleanMemoryPromptText(text);
  if (!cleaned || !userText) return cleaned;
  const kept = [];
  for (const chunk of splitMemoryPromptChunks(cleaned)) {
    if (!isTransientMemoryText(chunk) || isTransientMemoryRelevant(chunk, userText)) {
      kept.push(chunk);
    }
  }
  return joinMemoryPromptChunks(kept).trim();
}

/**
 * Project sibling content is a broad historical source, not resident state for
 * the active Session. Keep only chunks with concrete lexical support from the
 * current user turn; if none match, the sibling contributes no prompt block.
 *
 * @param {string} text
 * @param {string} userText
 * @returns {string}
 */
export function filterRelatedSessionPromptText(text, userText) {
  const cleaned = cleanMemoryPromptText(text);
  if (!cleaned || !userText) return '';
  const kept = [];
  let pendingHeading = '';
  for (const chunk of splitMemoryPromptChunks(cleaned)) {
    if (/^#{1,6}\s+\S/.test(chunk)) {
      pendingHeading = chunk;
      continue;
    }
    if (!isMemoryPromptRelevant(chunk, userText)) continue;
    if (pendingHeading) kept.push(pendingHeading);
    pendingHeading = '';
    kept.push(chunk);
  }
  return joinMemoryPromptChunks(kept).trim();
}

function splitMemoryPromptChunks(text) {
  const chunks = [];
  for (const block of String(text || '').split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    chunks.push(...splitListBlock(trimmed));
  }
  return chunks;
}

function splitListBlock(block) {
  const lines = block.split('\n');
  if (!lines.some(line => MARKDOWN_LIST_ITEM_RE.test(line))) return [block];

  const chunks = [];
  let current = [];
  for (const line of lines) {
    if (MARKDOWN_LIST_ITEM_RE.test(line) && current.length > 0) {
      chunks.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n').trim());
  return chunks.filter(Boolean);
}

function joinMemoryPromptChunks(chunks) {
  const out = [];
  let previousWasList = false;
  for (const chunk of chunks) {
    const isList = MARKDOWN_LIST_ITEM_RE.test(chunk);
    if (out.length > 0 && !(previousWasList && isList)) out.push('');
    out.push(chunk);
    previousWasList = isList;
  }
  return out.join('\n');
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function promptRelevanceTokens(text) {
  const cleaned = cleanMemoryPromptText(text).toLowerCase();
  const out = new Set();
  for (const match of cleaned.matchAll(ASCII_WORD_RE)) {
    const token = match[0];
    if (!COMMON_INTENT_TOKENS.has(token)) out.add(token);
  }
  for (const match of cleaned.matchAll(CJK_RUN_RE)) {
    for (const token of cjkBigrams(match[0])) {
      if (!COMMON_INTENT_TOKENS.has(token)) out.add(token);
    }
  }
  return out;
}

function cjkBigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Normalized key for conservative prompt dedupe. This is intentionally simple:
 * exact semantic clustering belongs in Dream; prompt assembly only removes
 * obvious repeats and near-contained copies.
 *
 * @param {string} text
 * @returns {string}
 */
export function memoryDedupeKey(text) {
  return cleanMemoryPromptText(text)
    .toLowerCase()
    .replace(/[`*_>#\-\[\]().,，。:：;；!！?？"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a candidate is redundant with text already emitted to the prompt.
 * Does not mutate `seen`; call `rememberMemoryText` only after the candidate
 * is actually selected into the snapshot.
 *
 * @param {string} candidate
 * @param {Set<string>} seen
 * @returns {boolean}
 */
export function isDuplicateMemoryText(candidate, seen) {
  const key = memoryDedupeKey(candidate);
  if (!key) return true;
  if (seen.has(key)) return true;

  // Avoid dropping tiny generic snippets via containment. A candidate is
  // redundant only when already-selected text covers it. If the candidate is
  // longer and contains the selected text, keep it: actual memory often carries
  // details that a resident summary compressed away.
  if (key.length >= 80) {
    for (const existing of seen) {
      if (existing.length >= 80 && existing.includes(key)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Mark text as emitted to the prompt for later dedupe checks.
 *
 * @param {string} text
 * @param {Set<string>} seen
 */
export function rememberMemoryText(text, seen) {
  const key = memoryDedupeKey(text);
  if (key) seen.add(key);
}
