import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const MAX_BRIDGE_MESSAGE_BYTES = 128 * 1024;

function bridgeToken() {
  return randomBytes(32).toString('base64url');
}

function parseMessage(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw || ''), 'utf8');
  if (bytes <= 0 || bytes > MAX_BRIDGE_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(raw.toString());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Loopback-only authenticated bridge between the Agent and its bundled MV3
 * extension. Tokens are random per Browser Session and never leave the Agent.
 */
export class BrowserExtensionBridge {
  constructor() {
    this.server = null;
    this.address = null;
    this.sessionsByToken = new Map();
    this.sessionsById = new Map();
    this.startPromise = null;
  }

  async start() {
    if (this.server) return this.address;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        maxPayload: MAX_BRIDGE_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      const fail = error => {
        server.close();
        this.startPromise = null;
        reject(error);
      };
      server.once('error', fail);
      server.once('listening', () => {
        server.off('error', fail);
        server.on('error', error => console.warn('[BrowserRuntime] extension bridge error:', error.message));
        server.on('connection', (socket, request) => this.#accept(socket, request));
        const address = server.address();
        if (!address || typeof address === 'string') return fail(new Error('Browser bridge address unavailable'));
        this.server = server;
        this.address = Object.freeze({ host: '127.0.0.1', port: address.port });
        resolve(this.address);
      });
    });
    return this.startPromise;
  }

  async registerSession(browserSessionId, handlers = {}) {
    if (!browserSessionId || this.sessionsById.has(browserSessionId)) {
      throw new Error('Browser bridge session already registered');
    }
    const address = await this.start();
    const token = bridgeToken();
    const record = {
      browserSessionId,
      token,
      socket: null,
      ready: false,
      closed: false,
      readyMessage: null,
      readyWaiters: new Set(),
      onMessage: typeof handlers.onMessage === 'function' ? handlers.onMessage : () => {},
      onDisconnect: typeof handlers.onDisconnect === 'function' ? handlers.onDisconnect : () => {},
    };
    this.sessionsByToken.set(token, record);
    this.sessionsById.set(browserSessionId, record);
    return Object.freeze({
      token,
      bridgeUrl: `ws://${address.host}:${address.port}/browser-runtime/${token}`,
      waitUntilReady: timeoutMs => this.waitUntilReady(browserSessionId, timeoutMs),
    });
  }

  #accept(socket, request) {
    const pathname = (() => {
      try { return new URL(request.url || '/', 'ws://127.0.0.1').pathname; } catch { return ''; }
    })();
    const prefix = '/browser-runtime/';
    const token = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
    const record = this.sessionsByToken.get(token);
    if (!record || record.closed) {
      socket.close(1008, 'Unknown Browser Session');
      return;
    }
    if (record.socket && record.socket.readyState === WebSocket.OPEN) {
      record.socket.close(1008, 'Superseded extension connection');
    }
    record.socket = socket;
    record.ready = false;

    socket.on('message', raw => {
      if (record.closed || record.socket !== socket) return;
      const message = parseMessage(raw);
      if (!message || message.browserSessionId !== record.browserSessionId) {
        socket.close(1008, 'Invalid Browser Runtime bridge message');
        return;
      }
      if (!record.ready) {
        if (message.type !== 'runtime_ready') {
          socket.close(1008, 'Browser Runtime bridge not ready');
          return;
        }
        record.ready = true;
        record.readyMessage = message;
        const waiters = [...record.readyWaiters];
        record.readyWaiters.clear();
        for (const waiter of waiters) waiter.resolve(message);
      }
      record.onMessage(message);
    });
    socket.on('close', () => {
      if (record.socket !== socket) return;
      record.socket = null;
      record.ready = false;
      record.readyMessage = null;
      if (!record.closed) record.onDisconnect();
    });
    socket.on('error', () => {});
  }

  async waitUntilReady(browserSessionId, timeoutMs = 15_000) {
    const record = this.sessionsById.get(browserSessionId);
    if (!record || record.closed) throw new Error('Browser bridge session unavailable');
    if (record.ready) return record.readyMessage || { type: 'runtime_ready', browserSessionId };
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        record.readyWaiters.delete(waiter);
        reject(new Error('Browser extension bridge timed out'));
      }, Math.max(1, timeoutMs));
      waiter.timer.unref?.();
      const settle = fn => value => {
        clearTimeout(waiter.timer);
        record.readyWaiters.delete(waiter);
        fn(value);
      };
      waiter.resolve = settle(resolve);
      waiter.reject = settle(reject);
      record.readyWaiters.add(waiter);
      if (record.ready) waiter.resolve(record.readyMessage || { type: 'runtime_ready', browserSessionId });
    });
  }

  send(browserSessionId, message) {
    const record = this.sessionsById.get(browserSessionId);
    if (!record?.ready || record.socket?.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify({ ...message, browserSessionId });
    if (Buffer.byteLength(payload, 'utf8') > MAX_BRIDGE_MESSAGE_BYTES) return false;
    record.socket.send(payload);
    return true;
  }

  unregisterSession(browserSessionId, reason = 'Browser Session closed') {
    const record = this.sessionsById.get(browserSessionId);
    if (!record) return false;
    record.closed = true;
    this.sessionsById.delete(browserSessionId);
    this.sessionsByToken.delete(record.token);
    const waiters = [...record.readyWaiters];
    record.readyWaiters.clear();
    for (const waiter of waiters) waiter.reject(new Error(reason));
    try { record.socket?.close(1000, reason.slice(0, 120)); } catch {}
    record.socket = null;
    return true;
  }

  async close() {
    for (const browserSessionId of [...this.sessionsById.keys()]) {
      this.unregisterSession(browserSessionId, 'Browser Runtime shutdown');
    }
    const server = this.server;
    this.server = null;
    this.address = null;
    this.startPromise = null;
    if (!server) return;
    await new Promise(resolve => server.close(() => resolve()));
  }
}
