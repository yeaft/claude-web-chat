/**
 * keywords.js — pure-rule keyword extraction shared by memory recall paths.
 *
 * Pure CPU, no LLM, <1ms. Used by `sessions/pre-flow.js` to derive FTS
 * query terms from the user message before hitting `memory/preflow.js`.
 */

/** Common stop words filtered out before frequency counting. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'up', 'it', 'its', 'my', 'me', 'i', 'you',
  'your', 'we', 'our', 'they', 'them', 'their', 'this', 'that', 'what',
  'which', 'who', 'whom', 'these', 'those',
  // Chinese stop words
  '的', '了', '在', '是', '我', '有', '和', '就',
  '不', '人', '都', '一', '一个', '上', '也',
  '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这',
  '他', '她', '吗', '呢', '吧', '把', '被',
  '那', '它', '让', '给', '可以', '什么',
  '怎么', '帮', '帮我', '请', '能', '想',
  // Generic execution / memory vocabulary is not discriminative enough to
  // select persistent context on its own.
  'current', 'state', 'work', 'task', 'item', 'items', 'todo', 'next', 'step',
  'merge', 'review', 'release', 'tag', 'tags', 'pr', 'pull', 'request', 'issue',
  'fix', 'feat', 'test', 'tests', 'dream', 'memory', 'session', 'topic', 'status',
  'blocker', 'blocked', 'context', 'latest',
  '当前', '状态', '任务', '工作', '工作项', '待办', '下一步', '完成', '合并',
  '评审', '发布', '标签', '记忆', '主题', '阻塞', '正在', '上下文', '最新',
  // Generic feedback / request language is especially noisy after Chinese
  // bigram tokenisation. It must not select persistent context on its own.
  '内容', '用户', '需求', '设计', '决策', '搜索', '发现', '需要', '应该', '添加',
  '无关', '不相干', '完全', '明细', '看看', '还有', '这个', '比如', '每个', '如果',
]);
const CJK_STOP_PHRASES = [...STOP_WORDS]
  .filter(word => word.length >= 2 && /^[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+$/.test(word))
  .sort((a, b) => b.length - a.length);

/**
 * Extract keywords from a prompt (pure rules, no LLM).
 *
 * @param {string} prompt
 * @returns {string[]} keywords sorted by frequency descending then alpha.
 */
export function extractKeywords(prompt) {
  if (!prompt || !prompt.trim()) return [];

  const normalized = prompt.toLowerCase();
  const tokens = [];
  for (const match of normalized.matchAll(/[a-z0-9_]{2,}/g)) {
    if (!STOP_WORDS.has(match[0])) tokens.push(match[0]);
  }
  for (const match of normalized.matchAll(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]{2,}/g)) {
    const runs = removeCjkStopPhrases(match[0]).match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]{2,}/g) || [];
    for (const run of runs) {
      if (STOP_WORDS.has(run)) continue;
      if (run.length === 2) tokens.push(run);
      else {
        for (let i = 0; i < run.length - 1; i += 1) {
          const term = run.slice(i, i + 2);
          if (!STOP_WORDS.has(term)) tokens.push(term);
        }
      }
    }
  }

  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
}

function removeCjkStopPhrases(run) {
  let cleaned = run;
  for (const phrase of CJK_STOP_PHRASES) cleaned = cleaned.split(phrase).join(' ');
  return cleaned;
}
