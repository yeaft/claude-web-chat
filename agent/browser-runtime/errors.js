export class BrowserRuntimeError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = 'BrowserRuntimeError';
    this.code = code;
    this.details = details;
  }
}
