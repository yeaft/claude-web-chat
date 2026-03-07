import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Structural verification tests for the server module refactoring (PR #79).
 * Ensures that:
 * 1. All sub-modules exist and export the expected functions
 * 2. Re-export entry points (database.js, auth.js) expose all expected symbols
 * 3. Handler sub-modules export their dispatcher functions
 * 4. Route sub-modules export their registration functions
 */

const SERVER_DIR = join(process.cwd(), 'server');

// =====================================================================
// Sub-module file existence
// =====================================================================
describe('server module structure — file existence', () => {
  const expectedFiles = [
    // Handler sub-modules (from ws-agent.js)
    'handlers/agent-conversation.js',
    'handlers/agent-crew.js',
    'handlers/agent-file-terminal.js',
    'handlers/agent-output.js',
    'handlers/agent-sync.js',
    // Handler sub-modules (from ws-client.js)
    'handlers/client-conversation.js',
    'handlers/client-crew.js',
    'handlers/client-misc.js',
    'handlers/client-workbench.js',
    // DB sub-modules (from database.js)
    'db/connection.js',
    'db/invitation-db.js',
    'db/message-db.js',
    'db/session-db.js',
    'db/user-db.js',
    // Route sub-modules (from api.js)
    'routes/auth-routes.js',
    'routes/invitation-routes.js',
    'routes/session-routes.js',
    'routes/upload-routes.js',
    'routes/user-routes.js',
    // Auth sub-modules (from auth.js)
    'auth/login.js',
    'auth/register.js',
    'auth/session-store.js',
    'auth/token.js',
    'auth/totp-auth.js',
    'auth/utils.js',
  ];

  for (const file of expectedFiles) {
    it(`should have sub-module: ${file}`, async () => {
      const stat = await fs.stat(join(SERVER_DIR, file));
      expect(stat.isFile()).toBe(true);
    });
  }
});

// =====================================================================
// Re-export entry points preserve original API
// =====================================================================
describe('database.js re-export completeness', () => {
  it('should re-export userDb', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'database.js'), 'utf-8');
    expect(content).toContain("export { userDb }");
  });

  it('should re-export invitationDb', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'database.js'), 'utf-8');
    expect(content).toContain("export { invitationDb }");
  });

  it('should re-export sessionDb', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'database.js'), 'utf-8');
    expect(content).toContain("export { sessionDb }");
  });

  it('should re-export messageDb', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'database.js'), 'utf-8');
    expect(content).toContain("export { messageDb }");
  });

  it('should re-export closeDb', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'database.js'), 'utf-8');
    expect(content).toContain("export { closeDb }");
  });
});

describe('auth.js re-export completeness', () => {
  const expectedExports = [
    'loginStep1', 'loginStep2',
    'verifyTotpStep', 'completeTotpSetup',
    'verifyToken', 'logout',
    'verifyAgent', 'register',
    'hashPassword', 'generateSkipAuthSession',
  ];

  for (const name of expectedExports) {
    it(`should re-export ${name}`, async () => {
      const content = await fs.readFile(join(SERVER_DIR, 'auth.js'), 'utf-8');
      expect(content).toContain(name);
    });
  }
});

// =====================================================================
// Handler sub-modules export dispatcher functions
// =====================================================================
describe('agent handler exports', () => {
  const handlers = [
    { file: 'handlers/agent-conversation.js', fn: 'handleAgentConversation' },
    { file: 'handlers/agent-crew.js', fn: 'handleAgentCrew' },
    { file: 'handlers/agent-file-terminal.js', fn: 'handleAgentFileTerminal' },
    { file: 'handlers/agent-output.js', fn: 'handleAgentOutput' },
    { file: 'handlers/agent-sync.js', fn: 'handleAgentSync' },
  ];

  for (const { file, fn } of handlers) {
    it(`${file} should export ${fn}`, async () => {
      const content = await fs.readFile(join(SERVER_DIR, file), 'utf-8');
      expect(content).toMatch(new RegExp(`export (async )?function ${fn}`));
    });
  }
});

describe('client handler exports', () => {
  const handlers = [
    { file: 'handlers/client-conversation.js', fn: 'handleClientConversation' },
    { file: 'handlers/client-crew.js', fn: 'handleClientCrew' },
    { file: 'handlers/client-misc.js', fn: 'handleClientMisc' },
    { file: 'handlers/client-workbench.js', fn: 'handleClientWorkbench' },
  ];

  for (const { file, fn } of handlers) {
    it(`${file} should export ${fn}`, async () => {
      const content = await fs.readFile(join(SERVER_DIR, file), 'utf-8');
      expect(content).toMatch(new RegExp(`export (async )?function ${fn}`));
    });
  }
});

// =====================================================================
// Route sub-modules export registration functions
// =====================================================================
describe('route module exports', () => {
  const routes = [
    { file: 'routes/auth-routes.js', fn: 'registerAuthRoutes' },
    { file: 'routes/invitation-routes.js', fn: 'registerInvitationRoutes' },
    { file: 'routes/session-routes.js', fn: 'registerSessionRoutes' },
    { file: 'routes/upload-routes.js', fn: 'registerUploadRoutes' },
    { file: 'routes/user-routes.js', fn: 'registerUserRoutes' },
  ];

  for (const { file, fn } of routes) {
    it(`${file} should export ${fn}`, async () => {
      const content = await fs.readFile(join(SERVER_DIR, file), 'utf-8');
      expect(content).toContain(`export function ${fn}`);
    });
  }
});

// =====================================================================
// ws-agent.js and ws-client.js dispatch to sub-modules
// =====================================================================
describe('ws-agent.js dispatches to handler sub-modules', () => {
  it('should import and call all 5 agent handlers', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'ws-agent.js'), 'utf-8');
    expect(content).toContain("import { handleAgentConversation }");
    expect(content).toContain("import { handleAgentOutput }");
    expect(content).toContain("import { handleAgentCrew }");
    expect(content).toContain("import { handleAgentFileTerminal }");
    expect(content).toContain("import { handleAgentSync }");
  });
});

describe('ws-client.js dispatches to handler sub-modules', () => {
  it('should import and call all 4 client handlers', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'ws-client.js'), 'utf-8');
    expect(content).toContain("import { handleClientConversation }");
    expect(content).toContain("import { handleClientWorkbench }");
    expect(content).toContain("import { handleClientCrew }");
    expect(content).toContain("import { handleClientMisc }");
  });
});

describe('api.js delegates to route sub-modules', () => {
  it('should import and call all 5 route registrators', async () => {
    const content = await fs.readFile(join(SERVER_DIR, 'api.js'), 'utf-8');
    expect(content).toContain("import { registerAuthRoutes }");
    expect(content).toContain("import { registerInvitationRoutes }");
    expect(content).toContain("import { registerUserRoutes }");
    expect(content).toContain("import { registerSessionRoutes }");
    expect(content).toContain("import { registerUploadRoutes }");
  });
});
