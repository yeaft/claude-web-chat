import WebSocket from 'ws';

export class WsClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this._messages = [];
    this._handlers = [];
  }

  async connect(params = {}) {
    const query = new URLSearchParams(params).toString();
    const wsUrl = `${this.serverUrl.replace('http', 'ws')}${query ? '?' + query : ''}`;
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WsClient connect timeout')), 5000);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        this._messages.push(msg);
        this._handlers.forEach(h => h(msg));
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  waitForMessage(type, timeoutMs = 5000) {
    const existing = this._messages.find(m => m.type === type);
    if (existing) {
      this._messages = this._messages.filter(m => m !== existing);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
      const handler = (msg) => {
        if (msg.type === type) {
          clearTimeout(timeout);
          this._handlers = this._handlers.filter(h => h !== handler);
          resolve(msg);
        }
      };
      this._handlers.push(handler);
    });
  }

  close() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}
