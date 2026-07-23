import { describe, expect, it, vi } from 'vitest';
import readTaskLog from '../../../agent/yeaft/tools/read-task-log.js';

describe('ReadTaskLog incremental reads', () => {
  it('defaults the first read to tail mode', async () => {
    const read = vi.fn(() => ({ text: 'tail', nextOffset: 10 }));
    const result = await readTaskLog.execute(
      { taskId: 'task-1' },
      { sessionId: 'session-1', taskManager: { readTaskLog: read } },
    );

    expect(JSON.parse(result)).toMatchObject({ nextOffset: 10 });
    expect(read).toHaveBeenCalledWith('session-1', 'task-1', {
      offset: undefined,
      maxBytes: undefined,
      tail: true,
    });
  });

  it('defaults an offset read to incremental mode', async () => {
    const read = vi.fn(() => ({ text: 'new', offset: 10, nextOffset: 13 }));
    await readTaskLog.execute(
      { taskId: 'task-1', offset: 10 },
      { sessionId: 'session-1', taskManager: { readTaskLog: read } },
    );

    expect(read).toHaveBeenCalledWith('session-1', 'task-1', {
      offset: 10,
      maxBytes: undefined,
      tail: false,
    });
  });

  it('respects an explicit tail override with an offset', async () => {
    const read = vi.fn(() => ({ text: 'tail' }));
    await readTaskLog.execute(
      { taskId: 'task-1', offset: 10, tail: true },
      { sessionId: 'session-1', taskManager: { readTaskLog: read } },
    );

    expect(read.mock.calls[0][2].tail).toBe(true);
  });
});
