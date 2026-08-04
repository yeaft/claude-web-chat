import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../agent/context.js';
import { handleTerminalClose, handleTerminalCreate } from '../../agent/terminal.js';

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

  it('preserves request ownership for create, output, exit, and explicit close', async () => {
    const request = {
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      cols: 80,
      rows: 24,
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    };

    await handleTerminalCreate(request);
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_created',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    ptyProcess.emit('data', 'hello');
    ptyProcess.emit('exit', { exitCode: 0 });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_output',
      data: 'hello',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    await handleTerminalCreate(request);
    ctx.sendToServer.mockClear();
    handleTerminalClose({ conversationId: 'yeaft-123', terminalId: 'term-1' });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
  });
});
