/**
 * VCrewChatView — Virtual Crew chat view component.
 *
 * Renders a single-conversation multi-role collaboration session.
 * Assistant messages are split by ---ROLE: xxx--- signals into
 * per-role segments, each rendered with role identity (icon + name).
 *
 * Key design:
 *   - parseRoleSegments(messages) splits store.messages into role segments
 *   - splitByRoleSignal(text) handles code-block safety & partial streaming
 *   - Reuses MarkdownRenderer (renderMarkdown) and ToolLine for rendering
 *   - Fully reactive via computed — streaming updates work automatically
 */

import { renderMarkdown } from '../utils/markdown.js';
import ToolLine from './ToolLine.js';

// ── Role signal parsing ────────────────────────────────────────────

/**
 * Check whether a line is a partial (truncated) ---ROLE: xxx--- signal.
 * During streaming, the signal may be cut mid-way (e.g. "---RO" or "---ROLE: de").
 * We hide such partial lines so they don't flash as content.
 */
function isPartialRoleSignal(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('---')) return false;
  // Full match would be caught by the regex in splitByRoleSignal, so
  // if we reach here starting with --- it's either a partial signal or a divider.
  // Match progressive prefixes of ---ROLE: xxx---
  return /^---\s*R(O(L(E(:(\s\w*(-(-(-)?)?)?)?)?)?)?)?$/.test(trimmed);
}

/**
 * Split a text block by ---ROLE: xxx--- signals.
 * Respects code blocks (``` fences) — signals inside code are ignored.
 *
 * @param {string} text - The assistant message text
 * @param {boolean} isStreaming - Whether this message is still streaming
 * @returns {Array<{role: string|null, content: string}>}
 */
function splitByRoleSignal(text, isStreaming = false) {
  const results = [];
  let currentContent = '';
  let detectedRole = null;
  let inCodeBlock = false;

  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code block boundaries
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentContent += line + '\n';
      continue;
    }

    // Inside code blocks — no role detection
    if (inCodeBlock) {
      currentContent += line + '\n';
      continue;
    }

    // Detect role switch signal: ---ROLE: xxx--- (must be on its own line)
    const roleMatch = line.match(/^---\s*ROLE:\s*(\w[\w-]*)\s*---$/);
    if (roleMatch) {
      // Save the current segment
      if (currentContent) {
        results.push({ role: detectedRole, content: currentContent });
        currentContent = '';
      }
      detectedRole = roleMatch[1].toLowerCase();
      continue; // Signal line itself is not rendered
    }

    // During streaming, hide partial signal at the very last line
    if (isStreaming && i === lines.length - 1 && isPartialRoleSignal(line)) {
      continue;
    }

    currentContent += line + '\n';
  }

  // Final segment
  if (currentContent) {
    results.push({ role: detectedRole, content: currentContent });
  }

  // Fallback: if nothing parsed, return raw text
  if (results.length === 0) {
    results.push({ role: null, content: text });
  }

  return results;
}

/**
 * Parse store.messages into a flat list of renderable segments.
 *
 * Segment types:
 *   - user:      { type:'user', content, id, attachments }
 *   - system:    { type:'system'|'error', content, id }
 *   - role-text: { type:'role-text', role, content, isStreaming }
 *   - tool:      { type:'tool', role, toolName, toolInput, toolResult, hasResult, id }
 *   - question:  { type:'user-question', ... }  (passthrough)
 *
 * @param {Array} messages - store.messages array
 * @returns {Array} segments
 */
function parseRoleSegments(messages) {
  const segments = [];
  let currentRole = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // User messages
    if (msg.type === 'user') {
      segments.push({
        type: 'user',
        content: msg.content,
        id: msg.id,
        attachments: msg.attachments,
      });
      continue;
    }

    // System / error messages
    if (msg.type === 'system' || msg.type === 'error') {
      segments.push({ type: msg.type, content: msg.content, id: msg.id });
      continue;
    }

    // User question (AskUserQuestion)
    if (msg.type === 'user-question') {
      segments.push({
        type: 'user-question',
        role: currentRole,
        msg,
        id: msg.id,
      });
      continue;
    }

    // Tool use messages — attribute to current role
    if (msg.type === 'tool-use') {
      // TodoWrite is rendered specially (progress list)
      if (msg.toolName === 'TodoWrite' && msg.toolInput?.todos) {
        segments.push({
          type: 'todo',
          role: currentRole,
          todos: msg.toolInput.todos,
          id: msg.id,
        });
        continue;
      }
      segments.push({
        type: 'tool',
        role: currentRole,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolResult: msg.toolResult,
        hasResult: msg.hasResult,
        startTime: msg.startTime,
        id: msg.id,
      });
      continue;
    }

    // Assistant text messages — split by ---ROLE---
    if (msg.type === 'assistant') {
      const text = msg.content || '';
      if (!text.trim()) continue;

      const isStreaming = !!msg.isStreaming;
      const parts = splitByRoleSignal(text, isStreaming);

      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part.role) {
          currentRole = part.role;
        }
        if (part.content.trim()) {
          segments.push({
            type: 'role-text',
            role: currentRole || 'assistant',
            content: part.content,
            isStreaming: isStreaming && j === parts.length - 1,
          });
        }
      }
      continue;
    }
  }

  return segments;
}

// ── Role color palette ─────────────────────────────────────────────

const ROLE_COLORS = {
  pm:       { color: '#e6a23c', border: '#e6a23c' },
  dev:      { color: '#409eff', border: '#409eff' },
  reviewer: { color: '#67c23a', border: '#67c23a' },
  tester:   { color: '#f56c6c', border: '#f56c6c' },
  designer: { color: '#b37feb', border: '#b37feb' },
  assistant:{ color: 'var(--text-secondary)', border: 'var(--border-color)' },
};

function getRoleColor(roleName) {
  return ROLE_COLORS[roleName] || ROLE_COLORS.assistant;
}

// ── Component ──────────────────────────────────────────────────────

export default {
  name: 'VCrewChatView',
  components: { ToolLine },
  template: `
    <div class="vcrew-chat">
      <!-- Top: active role indicator -->
      <div class="vcrew-role-indicator" v-if="activeRole && store.isProcessing">
        <span class="vcrew-role-ind-icon">{{ getRoleInfo(activeRole)?.icon || '🤖' }}</span>
        <span class="vcrew-role-ind-name">{{ getRoleInfo(activeRole)?.displayName || activeRole }}</span>
        <span class="vcrew-role-ind-status">{{ $t('vcrew.working') }}</span>
      </div>

      <!-- Messages -->
      <div class="vcrew-messages" ref="messagesRef">
        <div v-if="roleSegments.length === 0 && !store.isProcessing" class="vcrew-empty">
          <div class="vcrew-empty-icon">🎭</div>
          <div class="vcrew-empty-text">{{ $t('vcrew.emptyHint') }}</div>
        </div>

        <template v-for="(seg, idx) in roleSegments" :key="seg.id || idx">
          <!-- User message -->
          <div v-if="seg.type === 'user'" class="vcrew-msg vcrew-msg-user">
            <div class="vcrew-msg-content markdown-body" v-html="mdRender(seg.content)"></div>
            <div v-if="seg.attachments && seg.attachments.length > 0" class="vcrew-attachments">
              <span v-for="(a, ai) in seg.attachments" :key="ai" class="vcrew-attachment-badge">📎 {{ a.name || a.fileName }}</span>
            </div>
          </div>

          <!-- System / error -->
          <div v-else-if="seg.type === 'system' || seg.type === 'error'" class="vcrew-msg vcrew-msg-system" :class="{ 'vcrew-msg-error': seg.type === 'error' }">
            {{ seg.content }}
          </div>

          <!-- Role text segment -->
          <div v-else-if="seg.type === 'role-text'"
               class="vcrew-msg vcrew-msg-role"
               :style="{ '--role-color': getRoleColor(seg.role).color, '--role-border': getRoleColor(seg.role).border }">
            <!-- Role divider (shown on role change) -->
            <div class="vcrew-role-divider" v-if="isRoleChange(idx)">
              <span class="vcrew-role-div-icon">{{ getRoleInfo(seg.role)?.icon || '🤖' }}</span>
              <span class="vcrew-role-div-name">{{ getRoleInfo(seg.role)?.displayName || seg.role }}</span>
            </div>
            <div class="vcrew-role-content markdown-body" v-html="mdRender(seg.content)"></div>
            <span v-if="seg.isStreaming" class="cursor-blink"></span>
          </div>

          <!-- Tool call -->
          <div v-else-if="seg.type === 'tool'"
               class="vcrew-msg vcrew-msg-tool"
               :style="{ '--role-color': getRoleColor(seg.role).color }">
            <ToolLine
              :tool-name="seg.toolName"
              :tool-input="seg.toolInput"
              :tool-result="seg.toolResult"
              :has-result="seg.hasResult"
              :start-time="seg.startTime"
            />
          </div>

          <!-- Todo progress -->
          <div v-else-if="seg.type === 'todo'" class="vcrew-msg vcrew-msg-todo">
            <div v-for="todo in seg.todos" :key="todo.content"
                 class="vcrew-todo-item" :class="todo.status">
              <span class="vcrew-todo-checkbox">
                <span v-if="todo.status === 'completed'">✓</span>
                <span v-else-if="todo.status === 'in_progress'" class="vcrew-todo-spinner"></span>
              </span>
              <span class="vcrew-todo-text">{{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}</span>
            </div>
          </div>

          <!-- User question (AskUserQuestion) -->
          <div v-else-if="seg.type === 'user-question'" class="vcrew-msg vcrew-msg-question">
            <div class="vcrew-question-header">
              <span class="vcrew-question-icon">❓</span>
              <span>{{ getRoleInfo(seg.role)?.displayName || seg.role }} {{ $t('vcrew.askingYou') }}</span>
            </div>
          </div>
        </template>

        <!-- Typing dots when processing but no streaming -->
        <div v-if="store.isProcessing && !hasStreamingSegment" class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    return { store };
  },

  computed: {
    /** Parsed role segments from store.messages */
    roleSegments() {
      return parseRoleSegments(this.store.messages);
    },

    /** The currently active (most recent) role */
    activeRole() {
      for (let i = this.roleSegments.length - 1; i >= 0; i--) {
        const seg = this.roleSegments[i];
        if (seg.role && (seg.type === 'role-text' || seg.type === 'tool' || seg.type === 'todo')) {
          return seg.role;
        }
      }
      return null;
    },

    /** VCrew session info for current conversation */
    vcrewSession() {
      return this.store.vcrewSessions?.[this.store.currentConversation] || null;
    },

    /** Whether any segment is currently streaming */
    hasStreamingSegment() {
      return this.roleSegments.some(s => s.isStreaming);
    },
  },

  methods: {
    mdRender: renderMarkdown,

    getRoleColor,

    /** Get role info (icon, displayName) from vcrew session */
    getRoleInfo(roleName) {
      if (!this.vcrewSession || !roleName) return null;
      const roles = this.vcrewSession.roles || [];
      return roles.find(r => r.name === roleName) || null;
    },

    /**
     * Determine whether a role-change divider should be shown at segment index.
     * Shows divider when:
     *   - First role-text segment
     *   - Role changed from previous role-text/tool segment
     *   - After a user message
     */
    isRoleChange(idx) {
      const segments = this.roleSegments;
      const seg = segments[idx];
      if (seg.type !== 'role-text') return false;
      if (idx === 0) return true;

      for (let i = idx - 1; i >= 0; i--) {
        const prev = segments[i];
        if (prev.type === 'role-text' || prev.type === 'tool' || prev.type === 'todo') {
          return prev.role !== seg.role;
        }
        if (prev.type === 'user') return true;
      }
      return true;
    },
  },

  watch: {
    'store.messages': {
      handler() {
        this.$nextTick(() => {
          const el = this.$refs.messagesRef;
          if (!el) return;
          // Auto-scroll to bottom if user is near bottom
          const threshold = 150;
          const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
          if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
          }
        });
      },
      deep: true,
    },
  },

  mounted() {
    this.$nextTick(() => {
      const el = this.$refs.messagesRef;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
};

// Export parsing functions for testing
export { parseRoleSegments, splitByRoleSignal, isPartialRoleSignal };
