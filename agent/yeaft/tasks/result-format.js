/**
 * Model-only rendering for asynchronous task results.
 *
 * This output may contain command, log, and provider result details. It is
 * owner-scoped prompt context and must never be reused as a public wire
 * projection.
 */
export function formatTaskResultForVp(task) {
  const result = task?.result || {};
  const log = task?.log || {};
  const lines = [
    `<task-result id="${task?.id || 'unknown'}" kind="${task?.kind || 'tool'}" status="${task?.status || 'unknown'}">`,
    `title: ${task?.title || task?.kind || task?.id || 'task'}`,
  ];
  if (task?.runtime?.command) lines.push(`command: ${task.runtime.command}`);
  if (result.exitCode !== undefined && result.exitCode !== null) lines.push(`exitCode: ${result.exitCode}`);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.summary) lines.push(`summary: ${result.summary}`);
  if (log.path) lines.push(`log: ${log.path}`);
  if (log.preview) {
    lines.push('logTail:');
    lines.push(String(log.preview).slice(-4000).split('\n').map(line => `  ${line}`).join('\n'));
  }
  lines.push('</task-result>');
  lines.push('This is an asynchronous tool result from a background task, not a user message. Consume it now: tell the user the outcome or continue the work. Do not wait for another user turn.');
  return lines.join('\n');
}
