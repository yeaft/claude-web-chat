import { test as base } from '@playwright/test';
import { spawn } from 'child_process';
import { MockAgent } from './mock-agent.js';

const PROJECT_ROOT = process.env.E2E_PROJECT_ROOT || process.cwd();

class TestServer {
  constructor(port) {
    this.port = port;
    this.process = null;
    this.url = `http://localhost:${port}`;
    this.env = {
      ...process.env,
      PORT: String(port),
      SKIP_AUTH: 'true',
      SANDBOX_ENABLED: 'false',
      BROWSER_RUNTIME_ENABLED: 'true',
      NODE_ENV: 'test',
      TEST_DB_DIR: `/tmp/e2e-test-${port}`
    };
  }

  async start() {
    this.process = spawn('node', ['server/index.js'], {
      cwd: PROJECT_ROOT,
      env: this.env,
      stdio: 'pipe'
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 20000);
      this.process.stdout.on('data', (data) => {
        if (data.toString().includes('Server running on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.includes('EADDRINUSE')) {
          clearTimeout(timeout);
          reject(new Error(`Port ${this.port} already in use`));
        }
      });
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.process.on('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited before startup (code=${code}, signal=${signal || 'none'})`));
      });
    });
  }

  async kill() {
    if (this.process) {
      this.process.kill('SIGKILL');
      await new Promise(resolve => this.process.on('exit', resolve));
      this.process = null;
    }
  }

  async restart() {
    await this.kill();
    await this.start();
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise(resolve => this.process.on('exit', resolve));
      this.process = null;
    }
  }
}

export const test = base.extend({
  testServer: [async ({}, use) => {
    const port = 3400 + Math.floor(Math.random() * 100);
    const server = new TestServer(port);
    await server.start();
    await use(server);
    await server.stop();
  }, { scope: 'worker' }],

  serverUrl: async ({ testServer }, use) => {
    await use(testServer.url);
  },

  mockAgent: [async ({ serverUrl }, use) => {
    const agent = new MockAgent(serverUrl);
    await agent.connect();
    await use(agent);
    await agent.disconnect();
  }, { scope: 'test' }],

  chatPage: async ({ page, serverUrl, mockAgent }, use) => {
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });
    await page.waitForSelector('.brand-label', { timeout: 5000 });
    await page.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      const compatible = (store?.agents || []).filter(agent => agent.online === true
        && Array.isArray(agent.capabilities)
        && agent.capabilities.includes('work_center'));
      return compatible.length === 1
        && compatible[0].id === agentId
        && compatible[0].status === 'ready';
    }, mockAgent.agentId, { timeout: 10000 });
    await use(page);
  }
});
