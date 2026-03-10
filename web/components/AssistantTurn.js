import ToolLine from './ToolLine.js';

export default {
  name: 'AssistantTurn',
  components: { ToolLine },
  props: {
    turn: {
      type: Object,
      required: true
    }
  },
  template: `
    <div class="assistant-turn" :class="{ streaming: turn.isStreaming }">
      <!-- 1. Text content -->
      <div v-if="turn.textContent" class="turn-content">
        <div class="turn-header">
          <button class="copy-btn" @click="copyContent" :title="copied ? $t('message.copied') : $t('message.copy')">
            <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </button>
        </div>
        <div class="turn-text markdown-body" v-html="renderedContent"></div>
        <span v-if="turn.isStreaming" class="cursor-blink"></span>
      </div>

      <!-- 2. Todo progress (TodoWrite) -->
      <div v-if="turn.todoMsg" class="turn-todos">
        <div v-for="todo in turn.todoMsg.toolInput.todos" :key="todo.content"
             class="todo-item" :class="todo.status">
          <span class="todo-checkbox">
            <span v-if="todo.status === 'completed'">✓</span>
            <span v-else-if="todo.status === 'in_progress'" class="todo-spinner"></span>
          </span>
          <span class="todo-text">{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
        </div>
      </div>

      <!-- 3. Tool actions -->
      <div v-if="showToolActions" class="turn-actions">
        <div v-if="expanded" class="turn-actions-history">
          <template v-for="(tool, i) in historyTools" :key="i">
            <ToolLine :tool-name="tool.toolName" :tool-input="tool.toolInput"
                      :tool-result="tool.toolResult" :has-result="!!tool.hasResult" :start-time="tool.startTime" />
          </template>
        </div>
        <div class="turn-actions-latest">
          <button v-if="turn.toolMsgs.length > 1" class="turn-expand-btn" @click="toggleExpand">
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path v-if="expanded" fill="currentColor" d="M7 14l5-5 5 5z"/>
              <path v-else fill="currentColor" d="M7 10l5 5 5-5z"/>
            </svg>
            <span>{{ turn.toolMsgs.length - 1 }} more</span>
          </button>
          <ToolLine :tool-name="latestTool.toolName" :tool-input="latestTool.toolInput"
                    :tool-result="latestTool.toolResult" :has-result="!!latestTool.hasResult" :start-time="latestTool.startTime" />
        </div>
      </div>

      <!-- 4. AskUserQuestion interactive card -->
      <div v-if="turn.askMsg" class="turn-ask">
        <!-- Collapsed summary for answered questions -->
        <div v-if="isAskAnswered" class="ask-summary">
          <span class="ask-summary-icon">✓</span>
          <span class="ask-summary-text">{{ askSummaryText }}</span>
        </div>
        <!-- Full interactive card for unanswered questions -->
        <div v-else class="ask-card" :class="{ 'ask-waiting': !!turn.askMsg.askRequestId }">
          <div class="ask-icon-row">
            <span class="ask-icon">❓</span>
            <span class="ask-label">{{ $t('message.askInput') }}</span>
          </div>
          <div v-for="(q, qIdx) in effectiveQuestions" :key="qIdx" class="ask-question">
            <div class="ask-q-text">
              <span class="ask-q-chip" v-if="q.header">{{ q.header }}</span>
              {{ q.question }}
            </div>
            <div class="ask-options">
              <button
                v-for="opt in q.options"
                :key="opt.label"
                class="ask-opt"
                :class="{ selected: isOptionSelected(q.question, opt.label) }"
                :disabled="!turn.askMsg.askRequestId"
                @click="selectOption(q, opt)"
              >
                <span class="ask-opt-radio" :class="{ checked: isOptionSelected(q.question, opt.label) }"></span>
                <span class="ask-opt-body">
                  <span class="ask-opt-label">{{ opt.label }}</span>
                  <span class="ask-opt-desc" v-if="opt.description">{{ opt.description }}</span>
                </span>
              </button>
            </div>
            <div class="ask-custom" v-if="turn.askMsg.askRequestId">
              <input
                type="text"
                :placeholder="$t('message.askCustomPlaceholder')"
                :value="customAnswers[q.question] || ''"
                @input="setCustomAnswer(q.question, $event.target.value)"
                @keyup.enter="submitToolAnswers"
              />
            </div>
          </div>
          <div class="ask-actions" v-if="turn.askMsg.askRequestId">
            <button class="ask-submit" @click="submitToolAnswers" :disabled="!hasAnyToolSelection">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              {{ $t('message.askSubmit') }}
            </button>
          </div>
          <div class="ask-waiting-hint" v-if="!turn.askMsg.askRequestId">
            <span class="ask-waiting-spinner"></span>
            {{ $t('message.askWaiting') }}
          </div>
        </div>
      </div>
    </div>
  `,
  setup(props) {
    const store = Pinia.useChatStore();
    const copied = Vue.ref(false);
    const expanded = Vue.ref(false);
    const t = Vue.inject('t');

    // AskUserQuestion state
    const selectedOptions = Vue.reactive({});
    const customAnswers = Vue.reactive({});

    const showToolActions = Vue.computed(() => {
      return props.turn.toolMsgs.length > 0;
    });

    const latestTool = Vue.computed(() => {
      const tools = props.turn.toolMsgs;
      return tools[tools.length - 1];
    });

    const historyTools = Vue.computed(() => {
      return props.turn.toolMsgs.slice(0, -1);
    });

    const toggleExpand = () => {
      expanded.value = !expanded.value;
    };

    // Markdown rendering
    const configureMarked = () => {
      if (typeof marked !== 'undefined') {
        marked.setOptions({
          highlight: function(code, lang) {
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
              try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
            }
            return code;
          },
          breaks: true,
          gfm: true
        });
      }
    };
    configureMarked();

    const renderedContent = Vue.computed(() => {
      if (!props.turn.textContent) return '';
      let content = props.turn.textContent;
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
      const esc = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      };
      return text
        .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
          `<div class="code-block-wrapper"><pre><code class="language-${lang}">${esc(code.trim())}</code></pre></div>`)
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
        await navigator.clipboard.writeText(props.turn.textContent || '');
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
      } catch (e) {
        console.error('Copy failed:', e);
      }
    };

    // AskUserQuestion logic
    const isAskAnswered = Vue.computed(() => {
      const ask = props.turn.askMsg;
      return ask && (!!ask.askAnswered || !!ask.selectedAnswers);
    });

    const effectiveQuestions = Vue.computed(() => {
      const ask = props.turn.askMsg;
      return ask?.askQuestions || ask?.toolInput?.questions || [];
    });

    const isOptionSelected = (questionText, label) => {
      const sel = selectedOptions[questionText];
      if (Array.isArray(sel)) return sel.includes(label);
      return sel === label;
    };

    const selectOption = (q, opt) => {
      if (isAskAnswered.value) return;
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
      if (value) delete selectedOptions[questionText];
    };

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

    const submitToolAnswers = () => {
      if (isAskAnswered.value || !hasAnyToolSelection.value) return;
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
      const requestId = props.turn.askMsg.askRequestId;
      if (!requestId) return;
      store.answerUserQuestion(requestId, answers);
      props.turn.askMsg.askAnswered = true;
      props.turn.askMsg.selectedAnswers = answers;
    };

    const getAnswerForQuestion = (questionText) => {
      const answers = props.turn.askMsg?.selectedAnswers;
      if (!answers) return '-';
      return answers[questionText] || '-';
    };

    // Summary text for collapsed answered card
    const askSummaryText = Vue.computed(() => {
      const answers = props.turn.askMsg?.selectedAnswers;
      if (!answers) return '';
      const values = Object.values(answers).filter(v => v && v !== '-');
      return values.join(', ');
    });

    // Syntax highlighting
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
            } catch (e) { console.error('Copy failed:', e); }
          }
        };
      }
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code:not([data-highlighted])').forEach(block => {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          });
        }
      });
    });

    Vue.watch(() => props.turn.textContent, () => {
      Vue.nextTick(() => {
        if (typeof hljs !== 'undefined') {
          document.querySelectorAll('pre code:not([data-highlighted])').forEach(block => {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          });
        }
      });
    });

    return {
      copied,
      expanded,
      showToolActions,
      latestTool,
      historyTools,
      toggleExpand,
      renderedContent,
      copyContent,
      isAskAnswered,
      effectiveQuestions,
      isOptionSelected,
      selectOption,
      setCustomAnswer,
      customAnswers,
      hasAnyToolSelection,
      submitToolAnswers,
      getAnswerForQuestion,
      askSummaryText
    };
  }
};
