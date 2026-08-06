const MAX_QUOTE_CONTENT_LENGTH = 100_000;
const MAX_QUOTE_TODOS = 100;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function formatSessionMessageDateTime(value) {
  const timestamp = quoteTimestamp(value);
  if (!timestamp) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function normalizedTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.slice(0, MAX_QUOTE_TODOS).map((todo) => ({
    content: text(todo?.content).slice(0, 2_000),
    status: ['pending', 'in_progress', 'completed'].includes(todo?.status)
      ? todo.status
      : 'pending',
    ...(text(todo?.activeForm) ? { activeForm: text(todo.activeForm).slice(0, 2_000) } : {}),
  })).filter(todo => todo.content);
}

export function normalizeSessionMessageQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const content = text(quote.content).slice(0, MAX_QUOTE_CONTENT_LENGTH);
  const todos = normalizedTodos(quote.todos);
  if (!content && todos.length === 0) return null;
  const role = quote.role === 'assistant' ? 'assistant' : 'user';
  const timestamp = quoteTimestamp(quote.timestamp);
  return {
    id: text(quote.id).slice(0, 256) || null,
    role,
    author: text(quote.author).slice(0, 256) || (role === 'assistant' ? 'Assistant' : 'User'),
    content,
    ...(timestamp ? { timestamp } : {}),
    ...(todos.length > 0 ? { todos } : {}),
  };
}

export function quoteFromUserMessage(message, author) {
  return normalizeSessionMessageQuote({
    id: message?.messageId || message?.id || null,
    role: 'user',
    author,
    content: message?.content || '',
    timestamp: message?.timestamp || message?.createdAt || message?.ts || message?.time || null,
  });
}

export function quoteFromAssistantTurn(turn, author) {
  const todos = turn?.todoMsg?.toolInput?.todos;
  const toolNames = Array.isArray(turn?.toolMsgs)
    ? turn.toolMsgs.map(tool => text(tool?.toolName)).filter(Boolean)
    : [];
  const fallbackContent = toolNames.length > 0
    ? `Tool actions: ${toolNames.join(', ')}`
    : '';
  return normalizeSessionMessageQuote({
    id: turn?.atMessageId || turn?.messageId || turn?.id || turn?.turnId || null,
    role: 'assistant',
    author,
    content: turn?.textContent || fallbackContent,
    timestamp: turn?.timestamp || turn?.createdAt || turn?.speakerTimestamp || null,
    todos,
  });
}
