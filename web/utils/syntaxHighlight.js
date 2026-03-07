/**
 * Lightweight syntax highlighter for diff view
 * Supports common languages based on file extension
 */

// Language definitions: array of [regex, cssClass] pairs
// Order matters — first match wins for each position

const COMMON_PATTERNS = {
  // Strings (double-quoted, single-quoted, backtick)
  string: /("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)/g,
  // Numbers
  number: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?|0x[\da-fA-F]+|0b[01]+|0o[0-7]+)\b/g,
  // Generic single-line comment
  comment1: /(\/\/.*$)/gm,
  // Hash comment
  commentHash: /(#.*$)/gm,
  // Block comments (simplified — single-line only for diff)
  commentBlock: /(\/\*.*?\*\/)/g,
};

const LANG_DEFINITIONS = {
  js: {
    keywords: /\b(const|let|var|function|class|extends|return|if|else|for|while|do|switch|case|break|continue|new|this|super|import|export|from|default|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|null|undefined|true|false|NaN|Infinity)\b/g,
    builtins: /\b(console|window|document|Math|JSON|Array|Object|String|Number|Boolean|Promise|Map|Set|WeakMap|WeakSet|Symbol|Proxy|Reflect|RegExp|Error|Date|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|fetch|require|module|exports|process)\b/g,
    operators: /(=>|\.\.\.|\?\.|&&|\|\||===|!==|==|!=|>=|<=|>>>=|>>>|>>=|<<=|\+\+|--|[+\-*/%&|^~!<>]=?|\?|:)/g,
  },
  ts: 'js', // alias
  jsx: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  vue: 'js',

  py: {
    keywords: /\b(def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|yield|lambda|and|or|not|is|in|True|False|None|global|nonlocal|del|assert|async|await)\b/g,
    builtins: /\b(print|len|range|int|float|str|bool|list|dict|set|tuple|type|isinstance|super|property|staticmethod|classmethod|enumerate|zip|map|filter|sorted|reversed|open|input|hasattr|getattr|setattr|id|hex|oct|bin|abs|max|min|sum|all|any|iter|next)\b/g,
    decorators: /(@\w+)/g,
    commentType: 'hash',
  },
  rb: {
    keywords: /\b(def|class|module|end|return|if|elsif|else|unless|for|while|until|do|break|next|case|when|begin|rescue|ensure|raise|yield|require|include|extend|attr_accessor|attr_reader|attr_writer|self|super|nil|true|false|and|or|not|then|puts|print)\b/g,
    commentType: 'hash',
  },

  go: {
    keywords: /\b(func|package|import|var|const|type|struct|interface|map|chan|go|select|switch|case|default|if|else|for|range|break|continue|return|defer|fallthrough|nil|true|false|iota)\b/g,
    builtins: /\b(fmt|make|len|cap|append|copy|delete|close|panic|recover|new|error|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|bool|byte|rune|complex64|complex128)\b/g,
  },

  rs: {
    keywords: /\b(fn|let|mut|const|pub|mod|use|struct|enum|impl|trait|where|for|loop|while|if|else|match|return|break|continue|move|ref|self|Self|super|crate|as|in|unsafe|async|await|dyn|true|false|Some|None|Ok|Err)\b/g,
    builtins: /\b(String|Vec|Box|Rc|Arc|Option|Result|HashMap|HashSet|println|eprintln|format|panic|todo|unimplemented|assert|assert_eq|assert_ne|dbg|cfg|derive|macro_rules)\b/g,
    macros: /(\w+!)/g,
  },

  java: {
    keywords: /\b(class|interface|extends|implements|public|private|protected|static|final|abstract|synchronized|volatile|transient|native|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|import|package|this|super|void|null|true|false|instanceof)\b/g,
    builtins: /\b(System|String|Integer|Long|Double|Float|Boolean|List|ArrayList|Map|HashMap|Set|HashSet|Optional|Stream|Object|Exception|RuntimeException|Thread|Runnable|Override|Deprecated)\b/g,
  },

  cs: {
    keywords: /\b(class|struct|interface|enum|record|delegate|event|namespace|using|public|private|protected|internal|static|readonly|const|sealed|abstract|virtual|override|new|return|if|else|for|foreach|while|do|switch|case|default|break|continue|try|catch|finally|throw|async|await|yield|var|dynamic|is|as|in|out|ref|params|this|base|null|true|false|void|get|set|init|required|partial|where|select|from|orderby|group|join|let|into)\b/g,
    builtins: /\b(Console|String|Int32|Int64|Double|Boolean|List|Dictionary|HashSet|Task|IEnumerable|ILogger|IOptions|IFeatures|Exception|Guid|DateTime|TimeSpan|CancellationToken|Action|Func|Span|Memory|ReadOnlySpan)\b/g,
    attributes: /(\[[\w]+(?:\(.*?\))?\])/g,
  },

  cpp: {
    keywords: /\b(class|struct|enum|union|namespace|using|template|typename|public|private|protected|static|const|constexpr|volatile|virtual|override|final|explicit|inline|extern|auto|decltype|new|delete|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|throw|sizeof|alignof|typeid|static_cast|dynamic_cast|reinterpret_cast|const_cast|nullptr|true|false|void|this|operator|friend|noexcept|co_await|co_yield|co_return|concept|requires)\b/g,
    builtins: /\b(std|string|vector|map|unordered_map|set|array|pair|tuple|shared_ptr|unique_ptr|weak_ptr|optional|variant|any|cout|cin|endl|printf|scanf|malloc|free|sizeof|size_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t)\b/g,
    preprocessor: /(#\s*(?:include|define|undef|if|ifdef|ifndef|else|elif|endif|pragma|error|warning).*$)/gm,
  },
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',

  html: {
    tags: /(<\/?[\w-]+|>|\/>)/g,
    attrs: /\b([\w-]+)(?==)/g,
    commentType: 'html',
    commentHtml: /(<!--[\s\S]*?-->)/g,
  },
  xml: 'html',
  svg: 'html',

  css: {
    selectors: /([\w.#\[\]:,>+~*-]+)\s*\{/g,
    properties: /\b([\w-]+)(?=\s*:)/g,
    values: /:\s*([^;{}]+)/g,
    commentType: 'block',
  },
  scss: 'css',
  less: 'css',

  json: {
    keys: /("[\w.-]+")\s*:/g,
    commentType: 'none',
  },

  yaml: {
    keys: /([\w.-]+)\s*:/g,
    commentType: 'hash',
  },
  yml: 'yaml',

  md: {
    headings: /^(#{1,6}\s.*)$/gm,
    bold: /(\*\*[^*]+\*\*|__[^_]+__)/g,
    italic: /(\*[^*]+\*|_[^_]+_)/g,
    code: /(`[^`]+`)/g,
    links: /(\[[^\]]+\]\([^)]+\))/g,
    commentType: 'none',
  },

  sh: {
    keywords: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|local|readonly|unset|set|shift|eval|exec|trap|source|alias|cd|pwd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|find|xargs|sort|uniq|wc|head|tail|tee|cut|tr|test)\b/g,
    variables: /(\$\{?\w+\}?|\$\(|\$\{)/g,
    commentType: 'hash',
  },
  bash: 'sh',
  zsh: 'sh',

  sql: {
    keywords: /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LIKE|BETWEEN|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|AS|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE|BEGIN|END|IF|ELSE|THEN|CASE|WHEN|DECLARE|EXEC|UNION|ALL|DISTINCT|TOP|EXISTS|NULL|IS|ASC|DESC|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|CASCADE|TRUNCATE|COMMIT|ROLLBACK|GRANT|REVOKE)\b/gi,
    commentType: 'both',
  },

  lua: {
    keywords: /\b(and|break|do|else|elseif|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while)\b/g,
    builtins: /\b(print|type|tostring|tonumber|pairs|ipairs|next|select|unpack|error|pcall|xpcall|assert|require|table|string|math|io|os|coroutine|setmetatable|getmetatable|rawget|rawset)\b/g,
    commentLine: /(--(?!\[).*$)/gm,
    commentBlock: /(--\[\[[\s\S]*?\]\])/g,
  },

  php: {
    keywords: /\b(function|class|interface|trait|extends|implements|public|private|protected|static|final|abstract|const|var|new|return|if|else|elseif|for|foreach|while|do|switch|case|default|break|continue|try|catch|finally|throw|use|namespace|require|include|require_once|include_once|echo|print|die|exit|null|true|false|array|list|match|fn|yield|from)\b/g,
    variables: /(\$\w+)/g,
  },

  swift: {
    keywords: /\b(func|class|struct|enum|protocol|extension|let|var|guard|if|else|for|while|repeat|switch|case|default|break|continue|return|throw|try|catch|defer|import|typealias|associatedtype|init|deinit|subscript|operator|precedencegroup|self|Self|super|nil|true|false|is|as|in|inout|throws|rethrows|where|some|any|weak|unowned|lazy|mutating|nonmutating|override|final|required|convenience|optional|dynamic|async|await|actor|nonisolated|isolated|sending|consuming|borrowing)\b/g,
  },

  kt: {
    keywords: /\b(fun|class|object|interface|val|var|if|else|when|for|while|do|return|break|continue|throw|try|catch|finally|import|package|as|is|in|out|by|init|constructor|companion|data|sealed|enum|abstract|open|override|private|protected|internal|public|inline|reified|suspend|coroutine|null|true|false|this|super|it|typealias|annotation|lateinit|lazy|get|set)\b/g,
  },

  dart: {
    keywords: /\b(class|extends|implements|with|mixin|abstract|sealed|base|interface|final|const|var|late|required|dynamic|void|static|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|rethrow|assert|new|this|super|null|true|false|is|as|in|async|await|yield|import|export|library|part|show|hide|deferred|typedef|enum|extension|on)\b/g,
  },

  r: {
    keywords: /\b(if|else|for|while|repeat|function|return|break|next|in|TRUE|FALSE|NULL|NA|Inf|NaN|library|require|source|print|cat|paste|paste0|sprintf|stop|warning|message)\b/g,
    commentType: 'hash',
  },

  toml: {
    keys: /([\w.-]+)\s*=/g,
    sections: /(\[[\w.]+\])/g,
    commentType: 'hash',
  },

  proto: {
    keywords: /\b(syntax|package|import|option|message|enum|service|rpc|returns|repeated|optional|required|map|oneof|reserved|extensions|extend|group|default|packed|deprecated|java_package|java_outer_classname|optimize_for|cc_enable_arenas|objc_class_prefix|csharp_namespace|swift_prefix|php_class_prefix|php_namespace|ruby_package|string|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64|float|double|bool|bytes)\b/g,
  },
};

// CSS classes for highlighting
const CSS = {
  keyword:     'hl-kw',
  builtin:     'hl-bi',
  string:      'hl-st',
  number:      'hl-nm',
  comment:     'hl-cm',
  operator:    'hl-op',
  decorator:   'hl-dc',
  macro:       'hl-mc',
  preprocessor:'hl-pp',
  attribute:   'hl-at',
  tag:         'hl-tg',
  property:    'hl-pr',
  variable:    'hl-vr',
  heading:     'hl-hd',
  bold:        'hl-bd',
  link:        'hl-lk',
  key:         'hl-ky',
  section:     'hl-sc',
};

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Simple token-based highlighter
 * Works by finding all matches, sorting by position, and building output
 */
function highlightLine(text, langDef) {
  if (!text || !langDef) return escapeHtml(text);

  // Collect all tokens: { start, end, cls }
  const tokens = [];

  const addMatches = (regex, cls) => {
    if (!regex) return;
    const re = new RegExp(regex.source, regex.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      // Use first capturing group if available, else full match
      const matched = m[1] !== undefined ? m[1] : m[0];
      const start = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
      tokens.push({ start, end: start + matched.length, cls });
      if (!re.global) break;
    }
  };

  // Comment detection — varies per language
  const commentType = langDef.commentType || 'slash';
  if (commentType === 'slash' || commentType === 'both') {
    addMatches(COMMON_PATTERNS.comment1, CSS.comment);
    addMatches(COMMON_PATTERNS.commentBlock, CSS.comment);
  }
  if (commentType === 'hash' || commentType === 'both') {
    addMatches(COMMON_PATTERNS.commentHash, CSS.comment);
  }
  if (commentType === 'html') {
    addMatches(langDef.commentHtml, CSS.comment);
  }
  if (langDef.commentLine) {
    addMatches(langDef.commentLine, CSS.comment);
  }
  if (langDef.commentBlock) {
    addMatches(langDef.commentBlock, CSS.comment);
  }

  // Strings — always match
  if (commentType !== 'none') {
    addMatches(COMMON_PATTERNS.string, CSS.string);
  } else {
    addMatches(COMMON_PATTERNS.string, CSS.string);
  }

  // Numbers
  addMatches(COMMON_PATTERNS.number, CSS.number);

  // Language-specific patterns
  if (langDef.keywords)      addMatches(langDef.keywords, CSS.keyword);
  if (langDef.builtins)      addMatches(langDef.builtins, CSS.builtin);
  if (langDef.operators)     addMatches(langDef.operators, CSS.operator);
  if (langDef.decorators)    addMatches(langDef.decorators, CSS.decorator);
  if (langDef.macros)        addMatches(langDef.macros, CSS.macro);
  if (langDef.preprocessor)  addMatches(langDef.preprocessor, CSS.preprocessor);
  if (langDef.attributes)    addMatches(langDef.attributes, CSS.attribute);
  if (langDef.tags)          addMatches(langDef.tags, CSS.tag);
  if (langDef.properties)    addMatches(langDef.properties, CSS.property);
  if (langDef.variables)     addMatches(langDef.variables, CSS.variable);
  if (langDef.headings)      addMatches(langDef.headings, CSS.heading);
  if (langDef.bold)          addMatches(langDef.bold, CSS.bold);
  if (langDef.links)         addMatches(langDef.links, CSS.link);
  if (langDef.keys)          addMatches(langDef.keys, CSS.key);
  if (langDef.sections)      addMatches(langDef.sections, CSS.section);
  if (langDef.selectors)     addMatches(langDef.selectors, CSS.keyword);
  if (langDef.values)        addMatches(langDef.values, CSS.number);
  if (langDef.code)          addMatches(langDef.code, CSS.string);
  if (langDef.italic)        addMatches(langDef.italic, CSS.builtin);
  if (langDef.attrs)         addMatches(langDef.attrs, CSS.attribute);

  if (tokens.length === 0) return escapeHtml(text);

  // Sort by start position; longer matches first for ties
  tokens.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Build output, resolving overlaps (first match wins)
  let result = '';
  let pos = 0;

  for (const token of tokens) {
    if (token.start < pos) continue; // skip overlapping
    // Add plain text before this token
    if (token.start > pos) {
      result += escapeHtml(text.slice(pos, token.start));
    }
    result += `<span class="${token.cls}">${escapeHtml(text.slice(token.start, token.end))}</span>`;
    pos = token.end;
  }

  // Add remaining text
  if (pos < text.length) {
    result += escapeHtml(text.slice(pos));
  }

  return result;
}

/**
 * Get language definition for a file path
 */
function getLangDef(filePath) {
  if (!filePath) return null;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  let def = LANG_DEFINITIONS[ext];
  // Resolve alias
  if (typeof def === 'string') def = LANG_DEFINITIONS[def];
  return def || null;
}

/**
 * Highlight a line of code based on file extension
 * @param {string} text - The line of code
 * @param {string} filePath - File path to detect language
 * @returns {string} HTML string with syntax highlighting spans
 */
export function highlightCode(text, filePath) {
  if (!text) return escapeHtml(text || '');
  const langDef = getLangDef(filePath);
  if (!langDef) return escapeHtml(text);
  return highlightLine(text, langDef);
}

/**
 * Check if syntax highlighting is available for a file
 */
export function hasHighlighting(filePath) {
  return getLangDef(filePath) !== null;
}
