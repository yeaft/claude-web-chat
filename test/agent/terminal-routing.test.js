import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../agent/context.js';
import { handleTerminalClose, handleTerminalCreate } from '../../agent/terminal.js';
import { sendWorkbenchResult } from '../../agent/workbench/request-routing.js';

class FakePty extends EventEmitter {
  onData(handler) { this.on('data', handler); }
  onExit(handler) { this.on('exit', handler); }
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
}

describe('Agent terminal request routing metadata', () => {
  let ptyProcess;

  beforeEach(() => {
    ptyProcess = new FakePty();
    ctx.nodePty = { spawn: vi.fn(() => ptyProcess) };
    ctx.conversations = new Map();
    ctx.terminals = new Map();
    ctx.CONFIG = { workDir: process.cwd() };
    ctx.sendToServer = vi.fn();
  });

  it('preserves Workbench request routing metadata on generic Agent results', () => {
    sendWorkbenchResult(ctx, {
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
    }, {
      type: 'git_status_result',
      conversationId: '_workbench:yeaft:agent-a:session-a',
    });
    expect(ctx.sendToServer).toHaveBeenCalledWith({
      type: 'git_status_result',
      conversationId: '_workbench:yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
    });
  });

  it('preserves request ownership for create, output, exit, and explicit close', async () => {
    const request = {
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      cols: 80,
      rows: 24,
      workDir: '/workspace/session-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    };

    await handleTerminalCreate(request);
    expect(ctx.nodePty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      cwd: '/workspace/session-a',
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      type: 'terminal_created',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    ptyProcess.emit('data', 'hello');
    ptyProcess.emit('exit', { exitCode: 0 });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_output',
      data: 'hello',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    await handleTerminalCreate(request);
    ctx.sendToServer.mockClear();
    handleTerminalClose({ conversationId: 'yeaft-123', terminalId: 'term-1' });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
  });
});
