import { describe, expect, it, vi } from 'vitest';

const createWorkItemFromProducer = vi.fn();
vi.mock('../../../../agent/yeaft/work-center/bridge.js', () => ({ createWorkItemFromProducer }));

const { default: createWorkItem } = await import('../../../../agent/yeaft/tools/create-work-item.js');
const { createFullRegistry } = await import('../../../../agent/yeaft/tools/index.js');

describe('CreateWorkItem tool', () => {
  it('is available to normal Session execution', () => {
    expect(createFullRegistry().getAllTools().map(tool => tool.name)).toContain('CreateWorkItem');
  });

  it('stamps the trusted Session context instead of accepting an origin input', async () => {
    createWorkItemFromProducer.mockResolvedValue({ id: 'wi-1', status: 'ready', title: 'Persistent fix' });
    await createWorkItem.execute({
      title: 'Persistent fix', goal: 'Finish later', acceptanceCriteria: ['Reviewed'], start: true,
      origin: { sessionId: 'spoofed' },
    }, {
      sessionId: 'session-real', currentVpId: 'linus', cwd: '/tmp', inboundEnvelope: { msgId: 'msg-1' },
    });
    expect(createWorkItemFromProducer).toHaveBeenCalledWith(expect.objectContaining({
      origin: { sessionId: 'session-real', messageId: 'msg-1', createdBy: 'linus' },
      linkedSessionIds: ['session-real'],
    }));
    const payload = createWorkItemFromProducer.mock.calls.at(-1)[0];
    expect(payload).not.toHaveProperty('workflowTemplate');
    expect(payload).not.toHaveProperty('stageOverrides');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('effort');
  });

  it('rejects execution outside a Session', async () => {
    await expect(createWorkItem.execute({ title: 'x', goal: 'y' }, {}))
      .rejects.toThrow(/active Session/);
  });
});
