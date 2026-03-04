export default {
  name: 'MessageItem',
  props: {
    message: {
      type: Object,
      required: true
    }
  },
  template: `
    <div :class="messageClass">
      <!-- User message -->
      <template v-if="message.type === 'user'">
        <div class="message-content" v-if="message.content">{{ message.content }}</div>
        <!-- Attachments indicator (Claude Code style) -->
        <div class="user-attachments-indicator" v-if="message.attachments && message.attachments.length > 0">
          <span class="attachments-badge" @click="toggleAttachments">
            <span class="badge-icon">📎</span>
            <span class="badge-text">{{ getAttachmentsText(message.attachments) }}</span>
            <span class="badge-toggle" :class="{ expanded: showAttachments }">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
            </span>
          </span>
        </div>
        <!-- Expanded attachments preview -->
        <div class="user-attachments" v-if="message.attachments && message.attachments.length > 0 && showAttachments">
          <div
            v-for="(attachment, index) in message.attachments"
            :key="index"
            class="user-attachment-item"
            :class="{ 'is-image': attachment.isImage }"
          >
            <img
              v-if="attachment.isImage && attachment.preview"
              :src="attachment.preview"
              :alt="attachment.name"
              class="user-attachment-image"
              @click="openImagePreview(attachment.preview)"
            />
            <div v-else class="user-attachment-file">
              <span class="file-icon">{{ getFileIcon(attachment.mimeType) }}</span>
              <span class="file-name">{{ attachment.name }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Assistant message -->
      <template v-else-if="message.type === 'assistant' && (message.content || message.isStreaming)">
        <div class="message-header">
          <button class="copy-btn" @click="copyContent" :title="copied ? $t('message.copied') : $t('message.copy')">
            <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </button>
        </div>
        <div class="message-content markdown-body" v-html="renderedContent"></div>
        <span v-if="message.isStreaming" class="cursor-blink"></span>
      </template>

      <!-- System message -->
      <template v-else-if="message.type === 'system'">
        {{ message.content }}
      </template>

      <!-- Error message -->
      <template v-else-if="message.type === 'error'">
        {{ message.content }}
      </template>

      <!-- Tool use - Simple one-line style -->
      <template v-else-if="message.type === 'tool-use'">
        <!-- TodoWrite: special checklist display -->
        <div v-if="message.toolName === 'TodoWrite' && message.toolInput?.todos" class="todo-list">
          <div v-for="(todo, idx) in message.toolInput.todos" :key="idx" class="todo-item" :class="todo.status">
            <span class="todo-checkbox">
              <span v-if="todo.status === 'completed'">✓</span>
              <span v-else-if="todo.status === 'in_progress'" class="todo-spinner"></span>
            </span>
            <span class="todo-text">{{ todo.content }}</span>
          </div>
        </div>
        <!-- AskUserQuestion: interactive card display -->
        <div v-else-if="message.toolName === 'AskUserQuestion' && message.toolInput?.questions" class="ask-card" :class="{ 'ask-answered': isAskAnswered, 'ask-waiting': !isAskAnswered && !!message.askRequestId }">
          <div class="ask-icon-row">
            <span class="ask-icon">❓</span>
            <span class="ask-label">{{ $t('message.askInput') }}</span>
            <span class="ask-answered-tag" v-if="isAskAnswered">✓ {{ $t('message.askAnswered') }}</span>
          </div>
          <div v-for="(q, qIdx) in effectiveQuestions" :key="qIdx" class="ask-question">
            <div class="ask-q-text">
              <span class="ask-q-chip" v-if="q.header">{{ q.header }}</span>
              {{ q.question }}
            </div>
            <!-- 未回答状态：显示选项 -->
            <template v-if="!isAskAnswered">
              <div class="ask-options">
                <button
                  v-for="opt in q.options"
                  :key="opt.label"
                  class="ask-opt"
                  :class="{ selected: isOptionSelected(q.question, opt.label) }"
                  :disabled="!message.askRequestId"
                  @click="selectOption(q, opt)"
                >
                  <span class="ask-opt-radio" :class="{ checked: isOptionSelected(q.question, opt.label) }"></span>
                  <span class="ask-opt-body">
                    <span class="ask-opt-label">{{ opt.label }}</span>
                    <span class="ask-opt-desc" v-if="opt.description">{{ opt.description }}</span>
                  </span>
                </button>
              </div>
              <div class="ask-custom" v-if="message.askRequestId">
                <input
                  type="text"
                  :placeholder="$t('message.askCustomPlaceholder')"
                  :value="customAnswers[q.question] || ''"
                  @input="setCustomAnswer(q.question, $event.target.value)"
                  @keyup.enter="submitToolAnswers"
                />
              </div>
            </template>
            <!-- 已回答状态：显示所选答案 -->
            <div v-else class="ask-answer-display">
              <span class="ask-answer-value">{{ getAnswerForQuestion(q.question) }}</span>
            </div>
          </div>
          <div class="ask-actions" v-if="!isAskAnswered && message.askRequestId">
            <button class="ask-submit" @click="submitToolAnswers" :disabled="!hasAnyToolSelection">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              {{ $t('message.askSubmit') }}
            </button>
          </div>
          <div class="ask-waiting-hint" v-if="!isAskAnswered && !message.askRequestId">
            <span class="ask-waiting-spinner"></span>
            {{ $t('message.askWaiting') }}
          </div>
        </div>
        <!-- Other tools: one-line display -->
        <template v-else>
          <div class="tool-line" :class="{ expandable: hasExpandableContent, expanded: isToolExpanded, completed: message.hasResult, running: !message.hasResult && !message.isHistory, 'has-file': canOpenInEditor }" @click="handleToolLineClick">
            <span class="tool-line-icon">{{ getToolIcon(message.toolName) }}</span>
            <span class="tool-line-text">{{ getToolOneLine(message.toolName, message.toolInput) }}</span>
            <span class="tool-line-status completed" v-if="message.hasResult">✓</span>
            <span class="tool-line-status running" v-else-if="!message.isHistory"><span class="tool-dots"><span></span><span></span><span></span></span></span>
            <button v-if="canOpenInEditor" class="tool-open-editor" @click.stop="openInEditor" :title="$t('message.openInEditor')">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
            </button>
            <span class="tool-line-toggle" v-if="hasExpandableContent" @click.stop="toggleToolExpand">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
            </span>
          </div>
          <!-- Expanded content -->
          <div class="tool-expand" v-if="isToolExpanded && hasExpandableContent" @click.stop>
            <!-- Edit tool: show diff -->
            <div v-if="isEditTool && hasDiff" v-html="renderDiff(message.toolInput)"></div>
            <!-- Write tool: show content -->
            <div v-else-if="message.toolName === 'Write' && message.toolInput?.content" class="tool-expand-code">
              <pre><code>{{ message.toolInput.content }}</code></pre>
            </div>
            <!-- Bash tool: show full command and result -->
            <div v-else-if="message.toolName === 'Bash' && message.toolInput?.command" class="tool-expand-code">
              <pre><code>{{ message.toolInput.command }}</code></pre>
              <div v-if="message.hasResult && bashOutput" class="bash-output">
                <div class="bash-output-header">Output</div>
                <pre class="bash-output-content"><code>{{ bashOutput }}</code></pre>
              </div>
            </div>
            <!-- Other tools: show JSON -->
            <div v-else class="tool-expand-code">
              <pre><code>{{ formatToolInput(message.toolInput) }}</code></pre>
            </div>
          </div>
        </template>
      </template>

      <!-- Tool result - 已合并到 tool-use 中，不再单独显示 -->

      <!-- AskUserQuestion - 已统一到 tool-use 中处理 -->
    </div>
  `,
  setup(props) {
    const copied = Vue.ref(false);
    // Auto-expand Edit tools to show diff by default
    const isToolExpanded = Vue.ref(props.message.toolName === 'Edit');
    const isResultExpanded = Vue.ref(false);
    const showAttachments = Vue.ref(false);

    const t = Vue.inject('t');

    // AskUserQuestion interactive state
    const selectedOptions = Vue.reactive({});  // { questionText: label | [labels] }
    const customAnswers = Vue.reactive({});    // { questionText: customText }

    // 是否已回答（tool-use AskUserQuestion）
    const isAskAnswered = Vue.computed(() => {
      return !!props.message.askAnswered || !!props.message.selectedAnswers;
    });

    // 使用 askQuestions（从 ask_user_question 消息关联过来的）优先级高于 toolInput.questions
    const effectiveQuestions = Vue.computed(() => {
      return props.message.askQuestions || props.message.toolInput?.questions || [];
    });

    const isOptionSelected = (questionText, label) => {
      const sel = selectedOptions[questionText];
      if (Array.isArray(sel)) return sel.includes(label);
      return sel === label;
    };

    const selectOption = (q, opt) => {
      if (props.message.answered) return;
      // Clear custom input when selecting an option
      customAnswers[q.question] = '';
      if (q.multiSelect) {
        const arr = selectedOptions[q.question] || [];
        const newArr = Array.isArray(arr) ? [...arr] : [];
        const idx = newArr.indexOf(opt.label);
        if (idx >= 0) newArr.splice(idx, 1);
        else newArr.push(opt.label);
        selectedOptions[q.question] = newArr;
      } else {
        selectedOptions[q.question] = opt.label;
      }
    };

    const setCustomAnswer = (questionText, value) => {
      customAnswers[questionText] = value;
      // Clear option selection when typing custom
      if (value) {
        delete selectedOptions[questionText];
      }
    };

    const hasAnySelection = Vue.computed(() => {
      if (!props.message.questions) return false;
      return props.message.questions.some(q => {
        const sel = selectedOptions[q.question];
        const custom = customAnswers[q.question];
        if (custom) return true;
        if (Array.isArray(sel)) return sel.length > 0;
        return !!sel;
      });
    });

    // For tool-use AskUserQuestion cards
    const hasAnyToolSelection = Vue.computed(() => {
      const questions = effectiveQuestions.value;
      if (!questions || questions.length === 0) return false;
      return questions.some(q => {
        const sel = selectedOptions[q.question];
        const custom = customAnswers[q.question];
        if (custom) return true;
        if (Array.isArray(sel)) return sel.length > 0;
        return !!sel;
      });
    });

    const submitAnswers = () => {
      if (props.message.answered || !hasAnySelection.value) return;
      const store = Pinia.useChatStore();
      const answers = {};
      for (const q of props.message.questions) {
        const custom = customAnswers[q.question];
        if (custom) {
          answers[q.question] = custom;
        } else {
          const sel = selectedOptions[q.question];
          if (Array.isArray(sel) && sel.length > 0) {
            answers[q.question] = sel.join(', ');
          } else if (sel) {
            answers[q.question] = sel;
          }
        }
      }
      store.answerUserQuestion(props.message.requestId, answers);
    };

    // Submit answers from a tool-use AskUserQuestion card
    const submitToolAnswers = () => {
      if (props.message.askAnswered || !hasAnyToolSelection.value) return;
      const store = Pinia.useChatStore();
      const questions = effectiveQuestions.value;
      const answers = {};
      for (const q of questions) {
        const custom = customAnswers[q.question];
        if (custom) {
          answers[q.question] = custom;
        } else {
          const sel = selectedOptions[q.question];
          if (Array.isArray(sel) && sel.length > 0) {
            answers[q.question] = sel.join(', ');
          } else if (sel) {
            answers[q.question] = sel;
          }
        }
      }
      // Use the message's askRequestId
      const requestId = props.message.askRequestId;
      if (!requestId) {
        console.warn('[AskUser] No requestId available, cannot submit');
        return;
      }
      store.answerUserQuestion(requestId, answers);
      // Mark as answered locally
      props.message.askAnswered = true;
      props.message.selectedAnswers = answers;
    };

    // 获取某个问题的回答文本
    const getAnswerForQuestion = (questionText) => {
      const answers = props.message.selectedAnswers;
      if (!answers) return '-';
      return answers[questionText] || '-';
    };

    const toggleAttachments = () => {
      showAttachments.value = !showAttachments.value;
    };

    const getAttachmentsText = (attachments) => {
      if (!attachments || attachments.length === 0) return '';
      const imageCount = attachments.filter(a => a.isImage).length;
      const fileCount = attachments.length - imageCount;

      const parts = [];
      if (imageCount > 0) {
        parts.push(t('message.imageCount', { count: imageCount }));
      }
      if (fileCount > 0) {
        parts.push(t('message.fileCount', { count: fileCount }));
      }
      return parts.join(t('common.comma'));
    };

    // Check if this tool can open file in editor
    const canOpenInEditor = Vue.computed(() => {
      const t = props.message.toolName;
      return (t === 'Read' || t === 'Edit' || t === 'Write') && !!props.message.toolInput?.file_path;
    });

    const openInEditor = () => {
      const store = Pinia.useChatStore();
      store.openFileInExplorer(props.message.toolInput.file_path);
    };

    const bashOutput = Vue.computed(() => {
      if (props.message.toolName !== 'Bash' || !props.message.toolResult) return '';
      const result = props.message.toolResult;
      if (typeof result === 'string') return result;
      if (Array.isArray(result)) {
        return result.map(r => {
          if (typeof r === 'string') return r;
          if (r?.type === 'text' && r?.text) return r.text;
          return '';
        }).filter(Boolean).join('\n');
      }
      if (result?.type === 'text' && result?.text) return result.text;
      if (result?.content) {
        if (typeof result.content === 'string') return result.content;
        if (Array.isArray(result.content)) {
          return result.content.map(r => {
            if (typeof r === 'string') return r;
            if (r?.type === 'text' && r?.text) return r.text;
            return '';
          }).filter(Boolean).join('\n');
        }
      }
      return '';
    });

    const messageClass = Vue.computed(() => {
      const base = ['message', props.message.type];
      if (props.message.isStreaming) base.push('streaming');
      if (props.message.type === 'tool-use') {
        if (props.message.isFirst) base.push('is-first');
        if (props.message.isLast) base.push('is-last');
        if (props.message.isRunning) base.push('is-running');
        if (props.message.isCompleted) base.push('is-completed');
      }
      return base;
    });

    // Check if this is an Edit tool
    const isEditTool = Vue.computed(() => {
      return props.message.toolName === 'Edit';
    });

    // Check if we have diff data
    const hasDiff = Vue.computed(() => {
      const input = props.message.toolInput;
      return input && input.old_string !== undefined && input.new_string !== undefined;
    });

    // Check if tool has expandable content
    const hasExpandableContent = Vue.computed(() => {
      const toolName = props.message.toolName;
      const input = props.message.toolInput;
      if (!input) return false;
      if (toolName === 'Edit') return hasDiff.value;
      if (toolName === 'Bash') return !!(input.command?.length > 60 || props.message.hasResult);
      if (toolName === 'Read') return !!input.file_path;
      if (toolName === 'Write') return !!input.content;
      return Object.keys(input).length > 0;
    });

    // Check if result has content
    const hasResultContent = Vue.computed(() => {
      const result = props.message.toolResult;
      if (!result) return false;
      if (typeof result === 'string') return result.length > 50;
      if (result?.type === 'text' && result?.file) return true;
      return true;
    });

    // Toggle tool expansion
    const toggleToolExpand = () => {
      if (hasExpandableContent.value) {
        isToolExpanded.value = !isToolExpanded.value;
      }
    };

    // Handle tool line click: file tools → open in editor, others → toggle expand
    const handleToolLineClick = () => {
      if (canOpenInEditor.value) {
        openInEditor();
      } else if (hasExpandableContent.value) {
        isToolExpanded.value = !isToolExpanded.value;
      }
    };

    const toggleResultExpand = () => {
      if (hasResultContent.value) {
        isResultExpanded.value = !isResultExpanded.value;
      }
    };

    // Get tool icon
    const getToolIcon = (toolName) => {
      const icons = {
        'Read': '📖',
        'Edit': '✏️',
        'Write': '📝',
        'Bash': '⚡',
        'Glob': '🔍',
        'Grep': '🔎',
        'Task': '📋',
        'WebFetch': '🌐',
        'WebSearch': '🔍',
        'TodoWrite': '✅'
      };
      return icons[toolName] || '⚙️';
    };

    // Get tool summary - short version for inline display
    const getToolSummary = (toolName, input) => {
      if (!input) return '';
      if (toolName === 'Read' && input.file_path) {
        return input.file_path;
      }
      if (toolName === 'Edit' && input.file_path) {
        return input.file_path;
      }
      if (toolName === 'Write' && input.file_path) {
        return input.file_path;
      }
      if (toolName === 'Bash' && input.command) {
        const cmd = input.command;
        return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
      }
      if (toolName === 'Glob' && input.pattern) {
        return input.pattern;
      }
      if (toolName === 'Grep' && input.pattern) {
        return `"${input.pattern}"` + (input.path ? ` in ${input.path}` : '');
      }
      if (toolName === 'Task' && input.description) {
        return input.description;
      }
      if (toolName === 'WebFetch' && input.url) {
        return input.url;
      }
      if (toolName === 'WebSearch' && input.query) {
        return `"${input.query}"`;
      }
      return '';
    };

    // Get one-line description for tool (includes tool name)
    const getToolOneLine = (toolName, input) => {
      if (!input) return toolName;
      if (toolName === 'Read' && input.file_path) {
        let line = `Read ${input.file_path}`;
        if (input.offset || input.limit) {
          const start = (input.offset || 0) + 1;
          const end = input.limit ? start + input.limit - 1 : '∞';
          line += `:${start}-${end}`;
        }
        return line;
      }
      if (toolName === 'Edit' && input.file_path) {
        return `Edit ${input.file_path}`;
      }
      if (toolName === 'Write' && input.file_path) {
        return `Write ${input.file_path}`;
      }
      if (toolName === 'Bash' && input.command) {
        const cmd = input.command;
        return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
      }
      if (toolName === 'Glob' && input.pattern) {
        return `Glob ${input.pattern}` + (input.path ? ` in ${input.path}` : '');
      }
      if (toolName === 'Grep' && input.pattern) {
        let line = `Grep "${input.pattern}"`;
        if (input.path) line += ` in ${input.path}`;
        if (input.glob) line += ` (${input.glob})`;
        return line;
      }
      if (toolName === 'Task') {
        const agent = input.subagent_type || 'agent';
        const desc = input.description || input.prompt?.slice(0, 40) || '';
        return `Task [${agent}]: ${desc}`;
      }
      if (toolName === 'WebFetch' && input.url) {
        try {
          const url = new URL(input.url);
          return `Fetch ${url.hostname}${url.pathname.length > 20 ? url.pathname.slice(0, 20) + '...' : url.pathname}`;
        } catch {
          return `Fetch ${input.url.length > 50 ? input.url.slice(0, 50) + '...' : input.url}`;
        }
      }
      if (toolName === 'WebSearch' && input.query) {
        return `Search "${input.query}"`;
      }
      if (toolName === 'TodoWrite' && input.todos) {
        const todos = input.todos;
        const completed = todos.filter(t => t.status === 'completed').length;
        const inProgress = todos.filter(t => t.status === 'in_progress').length;
        return `Todo: ${completed}/${todos.length} done` + (inProgress > 0 ? `, ${inProgress} in progress` : '');
      }
      if (toolName === 'NotebookEdit') {
        const mode = input.edit_mode || 'replace';
        return `NotebookEdit [${mode}] ${input.notebook_path || ''}`;
      }
      if (toolName === 'AskUserQuestion') {
        const q = input.questions?.[0]?.question || '';
        return `Ask: ${q.length > 50 ? q.slice(0, 50) + '...' : q}`;
      }
      return toolName;
    };

    // Get result summary
    const getResultSummary = (result) => {
      if (!result) return t('message.done');
      if (result?.type === 'text' && result?.file) {
        return t('message.readFile', { name: result.file.filePath?.split(/[/\\]/).pop() || t('message.file') });
      }
      if (typeof result === 'string') {
        const clean = result.trim().split('\n')[0];
        return clean.length > 80 ? clean.slice(0, 80) + '...' : clean;
      }
      return t('message.done');
    };

    // Render full diff (no truncation)
    const renderDiff = (input) => {
      if (!input || input.old_string === undefined || input.new_string === undefined) return '';

      const oldLines = input.old_string.split('\n');
      const newLines = input.new_string.split('\n');

      let html = '<div class="diff-compact">';

      // Deletions (all lines)
      oldLines.forEach((line) => {
        html += `<div class="diff-line del">- ${escapeHtml(line)}</div>`;
      });

      // Additions (all lines)
      newLines.forEach((line) => {
        html += `<div class="diff-line add">+ ${escapeHtml(line)}</div>`;
      });

      html += '</div>';
      return html;
    };

    const escapeHtml = (str) => {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    // Get Write tool preview
    const getWritePreview = (input) => {
      if (!input?.content) return '';
      const lines = input.content.split('\n').slice(0, 5);
      let preview = lines.join('\n');
      if (input.content.split('\n').length > 5) {
        preview += '\n...';
      }
      return preview;
    };

    // Format tool input for JSON display
    const formatToolInput = (input) => {
      try {
        return JSON.stringify(input, null, 2);
      } catch {
        return String(input);
      }
    };

    // Format result preview (limited lines)
    const formatResultPreview = (result) => {
      if (result?.type === 'text' && result?.file) {
        const content = result.file.content || '';
        const lines = content.split('\n').slice(0, 10);
        let preview = lines.join('\n');
        if (content.split('\n').length > 10) {
          preview += '\n... (more content)';
        }
        return preview;
      }
      if (typeof result === 'string') {
        const lines = result.split('\n').slice(0, 10);
        let preview = lines.join('\n');
        if (result.split('\n').length > 10) {
          preview += '\n... (more content)';
        }
        return preview;
      }
      try {
        return JSON.stringify(result, null, 2);
      } catch {
        return String(result);
      }
    };

    // Configure marked
    const configureMarked = () => {
      if (typeof marked !== 'undefined') {
        marked.setOptions({
          highlight: function(code, lang) {
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
              try {
                return hljs.highlight(code, { language: lang }).value;
              } catch (e) {}
            }
            return code;
          },
          breaks: true,
          gfm: true
        });
      }
    };

    // Initialize marked configuration
    configureMarked();

    const renderedContent = Vue.computed(() => {
      if (!props.message.content) return '';

      // Ensure content is a string before parsing
      let content = props.message.content;
      if (typeof content !== 'string') {
        if (Array.isArray(content)) {
          content = content.map(block => {
            if (typeof block === 'string') return block;
            if (block && block.type === 'text') return block.text || '';
            return '';
          }).join('');
        } else {
          content = String(content);
        }
      }
      if (!content) return '';

      try {
        if (typeof marked !== 'undefined') {
          const html = marked.parse(content);
          return wrapTables(addCodeBlockCopyButtons(html));
        }
      } catch (e) {
        console.error('Markdown parsing error:', e);
      }

      return simpleMarkdown(content);
    });

    const addCodeBlockCopyButtons = (html) => {
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
    };

    const wrapTables = (html) => {
      return html.replace(/<table>([\s\S]*?)<\/table>/g,
        (match) => `<div class="table-scroll-wrapper">${match}</div>`);
    };

    const simpleMarkdown = (text) => {
      if (!text) return '';
      if (typeof text !== 'string') text = String(text);
      const escapeHtml = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      };

      return text
        .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
          return `<div class="code-block-wrapper"><pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre></div>`;
        })
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\n/g, '<br>');
    };

    const copyContent = async () => {
      try {
        const content = typeof props.message.content === 'string'
          ? props.message.content
          : String(props.message.content || '');
        await navigator.clipboard.writeText(content);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    };

    const getFileIcon = (mimeType) => {
      if (!mimeType) return '📄';
      if (mimeType.startsWith('image/')) return '🖼️';
      if (mimeType.startsWith('video/')) return '🎬';
      if (mimeType.startsWith('audio/')) return '🎵';
      if (mimeType.includes('pdf')) return '📕';
      if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
      if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
      if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
      if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive')) return '📦';
      if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('xml')) return '📃';
      return '📄';
    };

    const openImagePreview = (src) => {
      window.open(src, '_blank');
    };

    // Register global copy function for code blocks
    Vue.onMounted(() => {
      if (!window.copyCodeBlock) {
        window.copyCodeBlock = async function(btn) {
          const wrapper = btn.closest('.code-block-wrapper');
          const code = wrapper.querySelector('code');
          if (code) {
            try {
              await navigator.clipboard.writeText(code.textContent);
              btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
              setTimeout(() => {
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
              }, 2000);
            } catch (e) {
              console.error('Copy failed:', e);
            }
          }
        };
      }

      // Apply syntax highlighting to existing code blocks
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code').forEach((block) => {
            if (!block.dataset.highlighted) {
              hljs.highlightElement(block);
              block.dataset.highlighted = 'true';
            }
          });
        }
      });
    });

    // Re-highlight when content changes
    Vue.watch(() => props.message.content, () => {
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code:not([data-highlighted])').forEach((block) => {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          });
        }
      });
    });

    return {
      messageClass,
      renderedContent,
      copied,
      copyContent,
      formatToolInput,
      formatResultPreview,
      getFileIcon,
      openImagePreview,
      isToolExpanded,
      isResultExpanded,
      isEditTool,
      hasDiff,
      bashOutput,
      hasExpandableContent,
      hasResultContent,
      toggleToolExpand,
      handleToolLineClick,
      toggleResultExpand,
      getToolIcon,
      getToolSummary,
      getToolOneLine,
      getResultSummary,
      renderDiff,
      getWritePreview,
      showAttachments,
      toggleAttachments,
      getAttachmentsText,
      canOpenInEditor,
      openInEditor,
      selectedOptions,
      customAnswers,
      isOptionSelected,
      selectOption,
      setCustomAnswer,
      hasAnySelection,
      submitAnswers,
      hasAnyToolSelection,
      submitToolAnswers,
      isAskAnswered,
      effectiveQuestions,
      getAnswerForQuestion
    };
  }
};
