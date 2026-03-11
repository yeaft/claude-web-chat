/**
 * rolePlayAdapter.js — Convert RolePlay messages into Crew-compatible format.
 *
 * RolePlay uses a single conversation where assistant text contains
 * `---ROLE: xxx---` markers to separate role segments.  The Crew UI
 * expects an array of structured messages with `{ type, role, roleName,
 * roleIcon, content, taskId, ... }`.
 *
 * This adapter bridges the two by:
 *   1. Walking store.messages (user, assistant, tool-use, system, ...)
 *   2. Splitting assistant text by ---ROLE: xxx--- signals
 *   3. Extracting ---ROUTE--- blocks from text
 *   4. Producing an array that buildTurns / appendToSegments can consume directly
 *
 * The adapter is pure-function — no side-effects, no store mutation.
 */

// ── Role signal parsing (lifted from RolePlayChatView) ─────────────

/**
 * Check if a line is a partial (truncated) ---ROLE: xxx--- signal during streaming.
 */
function isPartialRoleSignal(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('---')) return false;
  return /^---\s*R(O(L(E(:(\s\w*(-(-(-)?)?)?)?)?)?)?)?$/.test(trimmed);
}

/**
 * Check if a line is a partial ROUTE block during streaming.
 */
function isPartialRouteBlock(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('---')) return false;
  return /^---\s*R(O(U(T(E(-(-(-)?)?)?)?)?)?)?$/.test(trimmed);
}

/**
 * Split text by ---ROLE: xxx--- signals, respecting code fences.
 * Returns [{ role: string|null, content: string }].
 */
function splitByRoleSignal(text, isStreaming = false) {
  const results = [];
  let currentContent = '';
  let detectedRole = null;
  let inCodeBlock = false;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentContent += line + '\n';
      continue;
    }
    if (inCodeBlock) {
      currentContent += line + '\n';
      continue;
    }

    const roleMatch = line.match(/^---\s*ROLE:\s*(\w[\w-]*)\s*---$/);
    if (roleMatch) {
      if (currentContent) {
        results.push({ role: detectedRole, content: currentContent });
        currentContent = '';
      }
      detectedRole = roleMatch[1].toLowerCase();
      continue;
    }

    if (isStreaming && i === lines.length - 1 && (isPartialRoleSignal(line) || isPartialRouteBlock(line))) {
      continue;
    }

    currentContent += line + '\n';
  }

  if (currentContent) {
    results.push({ role: detectedRole, content: currentContent });
  }
  if (results.length === 0) {
    results.push({ role: null, content: text });
  }
  return results;
}

// ── ROUTE block extraction ──────────────────────────────────────────

const ROUTE_RE = /---ROUTE---([\s\S]*?)---END_ROUTE---/g;
const ROUTE_LINE_TO = /^to:\s*(.+)$/m;
const ROUTE_LINE_SUMMARY = /^summary:\s*([\s\S]+?)(?=^(?:to|task|---)|$)/m;

/**
 * Extract ROUTE blocks from text content.
 * Returns { cleanContent, routes: [{ routeTo, routeSummary }] }.
 */
function extractRouteBlocks(text) {
  const routes = [];
  let match;
  ROUTE_RE.lastIndex = 0;
  while ((match = ROUTE_RE.exec(text)) !== null) {
    const body = match[1];
    const toMatch = body.match(ROUTE_LINE_TO);
    const summaryMatch = body.match(ROUTE_LINE_SUMMARY);
    if (toMatch) {
      routes.push({
        routeTo: toMatch[1].trim(),
        routeSummary: summaryMatch ? summaryMatch[1].trim() : ''
      });
    }
  }
  const cleanContent = text.replace(ROUTE_RE, '').trim();
  return { cleanContent, routes };
}

// ── Main adapter ────────────────────────────────────────────────────

/**
 * Resolve role info (icon, displayName) from the rolePlay session.
 */
function resolveRole(roleName, rolesMap) {
  if (!roleName) return { roleName: 'Assistant', roleIcon: '🤖' };
  const info = rolesMap.get(roleName);
  if (info) return { roleName: info.displayName || roleName, roleIcon: info.icon || '🤖' };
  return { roleName, roleIcon: '🤖' };
}

/**
 * Convert RolePlay store.messages into Crew-compatible message array.
 *
 * @param {Array} messages     - store.messages for the RolePlay conversation
 * @param {Array} sessionRoles - rolePlaySession.roles array [{name, displayName, icon, ...}]
 * @param {string|null} fallbackRole - current role from rolePlayStatuses, used when no ---ROLE--- signal detected
 * @returns {Array} Crew-format messages ready for buildTurns / appendToSegments
 */
export function adaptRolePlayMessages(messages, sessionRoles, fallbackRole = null) {
  const rolesMap = new Map();
  if (sessionRoles) {
    for (const r of sessionRoles) {
      rolesMap.set(r.name, r);
    }
  }

  const result = [];
  let currentRole = null;
  let msgCounter = 0;

  for (const msg of messages) {
    // User messages → type: 'text', role: 'human'
    if (msg.type === 'user') {
      result.push({
        id: msg.id || msgCounter++,
        type: 'text',
        role: 'human',
        roleName: 'Human',
        roleIcon: '👤',
        content: msg.content || '',
        timestamp: msg.timestamp || Date.now(),
        attachments: msg.attachments,
        _streaming: false,
      });
      continue;
    }

    // System / error → type: 'system'
    if (msg.type === 'system' || msg.type === 'error') {
      result.push({
        id: msg.id || msgCounter++,
        type: 'system',
        role: 'system',
        roleName: 'System',
        roleIcon: '⚙️',
        content: msg.content || '',
        timestamp: msg.timestamp || Date.now(),
        _streaming: false,
      });
      continue;
    }

    // Tool-use → type: 'tool', attributed to current role
    if (msg.type === 'tool-use') {
      const effectiveRole = currentRole || fallbackRole;
      const rInfo = resolveRole(effectiveRole, rolesMap);
      result.push({
        id: msg.id || msgCounter++,
        type: 'tool',
        role: effectiveRole || 'assistant',
        roleName: rInfo.roleName,
        roleIcon: rInfo.roleIcon,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolResult: msg.toolResult,
        hasResult: msg.hasResult,
        content: '',
        timestamp: msg.timestamp || Date.now(),
        startTime: msg.startTime,
        _streaming: false,
      });
      continue;
    }

    // User question (AskUserQuestion) → type: 'human_needed'
    if (msg.type === 'user-question') {
      const effectiveRole = currentRole || fallbackRole;
      const rInfo = resolveRole(effectiveRole, rolesMap);
      result.push({
        id: msg.id || msgCounter++,
        type: 'human_needed',
        role: effectiveRole || 'assistant',
        roleName: rInfo.roleName,
        roleIcon: rInfo.roleIcon,
        content: `${rInfo.roleName} is asking you a question`,
        timestamp: msg.timestamp || Date.now(),
        _streaming: false,
        askRequestId: msg.askRequestId,
        askQuestions: msg.askQuestions,
        askAnswered: msg.askAnswered,
        toolInput: msg.toolInput,
      });
      continue;
    }

    // Assistant text → split by ---ROLE---
    if (msg.type === 'assistant') {
      const text = msg.content || '';
      if (!text.trim()) continue;

      const isStreaming = !!msg.isStreaming;
      const parts = splitByRoleSignal(text, isStreaming);

      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part.role) currentRole = part.role;

        // Fallback: when no ---ROLE--- signal detected, use the server-tracked currentRole
        const effectiveRole = currentRole || fallbackRole;
        const rInfo = resolveRole(effectiveRole, rolesMap);
        const { cleanContent, routes } = extractRouteBlocks(part.content);

        // Emit text message (if there's non-route content)
        if (cleanContent.trim()) {
          result.push({
            id: `${msg.id || msgCounter++}_p${j}`,
            type: 'text',
            role: effectiveRole || 'assistant',
            roleName: rInfo.roleName,
            roleIcon: rInfo.roleIcon,
            content: cleanContent,
            timestamp: msg.timestamp || Date.now(),
            _streaming: isStreaming && j === parts.length - 1,
          });
        }

        // Emit route messages
        for (let k = 0; k < routes.length; k++) {
          const r = routes[k];
          const targetInfo = resolveRole(r.routeTo, rolesMap);
          result.push({
            id: `${msg.id || msgCounter++}_r${j}_${k}`,
            type: 'route',
            role: effectiveRole || 'assistant',
            roleName: rInfo.roleName,
            roleIcon: rInfo.roleIcon,
            routeTo: r.routeTo,
            routeToName: targetInfo.roleName,
            routeSummary: r.routeSummary,
            content: '',
            timestamp: msg.timestamp || Date.now(),
            _streaming: false,
          });
        }
      }
      continue;
    }
  }

  return result;
}

// Export parsing helpers for testing
export { splitByRoleSignal, extractRouteBlocks, isPartialRoleSignal, isPartialRouteBlock };
