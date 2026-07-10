import { defineTool } from './types.js';

function cleanCriteria(value) {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : [];
}

export default defineTool({
  name: 'CreateWorkItem',
  description: {
    en: `Create a persistent Agent-level Work Center item from the current Session.

Use this when work must continue beyond the current turn, needs role handoffs, review, waiting, retry, or durable tracking. This creates the work contract; it does not execute it inline. The current Session is always stamped as the origin and cannot be overridden by model input.`,
    zh: `从当前 Session 创建一个持久化的 Agent 级工作项。

当工作需要跨 turn 继续、需要角色接力、评审、等待、重试或长期跟踪时使用。该工具只创建工作契约，不在当前 turn 内执行。来源 Session 由运行时强制写入，模型输入不能覆盖。`,
  },
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: { en: 'Short work item title', zh: '简短的工作项标题' },
      },
      goal: {
        type: 'string',
        description: { en: 'Stable outcome the work item must achieve', zh: '工作项必须达到的稳定目标' },
      },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: { en: 'Verifiable completion criteria', zh: '可验证的完成条件' },
      },
      workDir: {
        type: 'string',
        description: { en: 'Optional project directory for execution', zh: '执行时使用的可选项目目录' },
      },
      start: {
        type: 'boolean',
        description: { en: 'Start triage immediately (default true)', zh: '是否立即开始 triage（默认 true）' },
      },
    },
    required: ['title', 'goal'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx = {}) {
    const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';
    if (!sessionId) throw new Error('CreateWorkItem requires an active Session');
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const goal = typeof input?.goal === 'string' ? input.goal.trim() : '';
    if (!title || !goal) throw new Error('title and goal are required');

    // Dynamic import avoids tools/index -> create-work-item -> bridge -> runner
    // -> tools/index becoming a static initialization cycle.
    const { createWorkItemFromProducer } = await import('../work-center/bridge.js');
    const detail = await createWorkItemFromProducer({
      title,
      goal,
      acceptanceCriteria: cleanCriteria(input.acceptanceCriteria),
      workDir: typeof input.workDir === 'string' ? input.workDir.trim() : (ctx.cwd || ''),
      // The Agent-local Work Center settings choose the default workflow and
      // freeze its policy snapshot. Tool callers create the contract; they do
      // not get to smuggle a different dispatch policy into it.
      origin: {
        sessionId,
        messageId: ctx.inboundEnvelope?.msgId || null,
        createdBy: ctx.currentVpId || 'assistant',
      },
      linkedSessionIds: [sessionId],
      start: input.start !== false,
    });
    return JSON.stringify({
      workItemId: detail.id,
      status: detail.status,
      title: detail.title,
      message: `Created Work Center item ${detail.id}`,
    });
  },
});
