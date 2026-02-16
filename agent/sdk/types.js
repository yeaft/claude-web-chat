/**
 * Error classes for Claude Code SDK integration
 */

/**
 * Abort error for cancelled operations
 */
export class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
  }
}
