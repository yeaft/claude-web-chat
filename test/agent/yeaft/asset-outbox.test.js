import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetOutbox } from '../../../agent/yeaft/asset-outbox.js';

const dirs = [];
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), 'yeaft-asset-outbox-'));
  dirs.push(value);
  return value;
}

describe('asset outbox', () => {
  it('persists before send and removes only after acknowledgement', async () => {
    const send = vi.fn(async () => 'sent');
    const dir = root();
    const outbox = createAssetOutbox({ root: dir, send });
    const deliveryId = outbox.enqueue({ sessionId: 'session-1', image: { previewData: { data: 'abc' } } });
    expect(outbox.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(outbox.list()[0].path, 'utf8'))).toMatchObject({ deliveryId, sessionId: 'session-1' });

    await outbox.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.acknowledge(deliveryId)).toBe(true);
    expect(outbox.list()).toHaveLength(0);
    outbox.close();
  });

  it('retries an unacknowledged delivery while the connection stays open', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => 'sent');
    const outbox = createAssetOutbox({ root: root(), send, retryDelayMs: 100 });
    outbox.enqueue({ sessionId: 'session-1' });
    await outbox.drain();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(2);
    outbox.close();
  });

  it('keeps the item across a disconnected send and retries after restart', async () => {
    const dir = root();
    const first = createAssetOutbox({ root: dir, send: vi.fn(async () => 'dropped') });
    first.enqueue({ sessionId: 'session-1', image: { previewData: { data: 'abc' } } });
    await first.drain();
    expect(first.list()).toHaveLength(1);

    const resend = vi.fn(async () => 'sent');
    const restarted = createAssetOutbox({ root: dir, send: resend });
    await restarted.drain();
    expect(resend).toHaveBeenCalledTimes(1);
    expect(restarted.list()).toHaveLength(1);
    first.close();
    restarted.close();
  });

  it('enforces bounded capacity and removes pending assets with a deleted Session', () => {
    const outbox = createAssetOutbox({ root: root(), send: vi.fn(), maxItems: 1, maxBytes: 1024 });
    outbox.enqueue({ sessionId: 'session-1', image: { previewData: { data: 'abc' } } });
    expect(() => outbox.enqueue({ sessionId: 'session-2' })).toThrow(/full/);
    expect(outbox.removeSession('session-1')).toBe(1);
    expect(outbox.list()).toHaveLength(0);
  });

  it('keeps retrying transient failures until an acknowledgement arrives', async () => {
    const send = vi.fn(async () => 'sent');
    const outbox = createAssetOutbox({ root: root(), send });
    const deliveryId = outbox.enqueue({ sessionId: 'session-1' });
    await outbox.drain();
    await outbox.drain();
    await outbox.drain();
    expect(send).toHaveBeenCalledTimes(3);
    expect(outbox.acknowledge(deliveryId)).toBe(true);
    expect(outbox.list()).toHaveLength(0);
    outbox.close();
  });
});
