/**
 * send-message.js — Send a follow-up prompt to a sub-agent.
 *
 * Tool name: PromptAgent (canonical) / SendMessage (legacy alias for
 * historical jsonl replay — see registry alias map).
 */

import { defineTool } from './types.js';
import { agentBelongsToCaller, getAgentRegistry } from './agent.js';
import { enqueueSubAgentPrompt } from '../sub-agent/prompt-queue.js';
import { isTerminalAgentStatus, isPromptableAgentStatus, STATUS, describeAgentStatus } from '../sub-agent/status.js';

export default defineTool({
  name: 'PromptAgent',
  aliases: ['SendMessage'],
  description: {
    en: `Send a follow-up prompt to a sub-agent you previously spawned.

Use this to give the sub-agent more work, additional instructions, or relay
information. The prompt is queued for the agent to process on its next turn.

IMPORTANT — PromptAgent only QUEUES the message; it does NOT block. After it
returns, normally continue your own work and use the next-turn notification or
ListAgents to observe progress. Use WaitAgent only when the reply is required
now. Do not end the turn silently: continue useful work, tell the user what you
asked, wait deliberately, or close the agent.

PromptAgent is rejected if the sub-agent is in a terminal state
(completed/failed/closed/abandoned). Use SpawnAgent to start a fresh one.`,
    zh: `向之前创建的子 Agent 发送后续提示。

用于给子 Agent 更多工作、额外指令或传递信息。提示会排队等待子 Agent 在其下一个 turn 处理。

重要——PromptAgent 仅将消息排队，不阻塞。返回后通常应继续自己的工作，并通过下一 turn 的
notification 或 ListAgents 查看进度；只有当前确实需要回复时才调用 WaitAgent。不要静默结束
turn：继续有用工作、向用户说明所发指令、明确等待或关闭 Agent。

如果子 Agent 处于终止状态（completed/failed/closed/abandoned），PromptAgent 会被拒绝。
用 SpawnAgent 启动新的。`
  },
  parameters: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: {
          en: 'The sub-agent ID (returned by Agent tool)',
          zh: '子 Agent ID（由 Agent 工具返回）',
        },
      },
      message: {
        type: 'string',
        description: {
          en: 'The message to send to the agent',
          zh: '要发送给 Agent 的消息',
        },
      },
    },
    required: ['agent_id', 'message'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  // Queueing a prompt can resume an existing writable child after this
  // orchestration call returns, so parent filesystem snapshots are stale-risk.
  mayMutateWorkspaceAfterReturn: () => true,
  async execute(input, ctx) {
    // NB: next_steps is the FIRST envelope field — the registry's
    // model-context tail truncation would eat it if it lived at the end.
    const ERROR_NEXT_STEPS =
      'That call failed — see `error`. Either correct the arguments and ' +
      'retry, or tell the user what went wrong. Do NOT end your turn ' +
      'silently after an error envelope.';

    const { agent_id, message } = input;
    if (!agent_id) return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: 'agent_id is required' });
    if (!message) return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: 'message is required' });

    const agents = getAgentRegistry();
    const agent = agents.get(agent_id);

    if (!agent) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: `Agent not found: ${agent_id}` });
    }
    if (!agentBelongsToCaller(agent, ctx)) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: `Agent not found: ${agent_id}` });
    }

    if (isTerminalAgentStatus(agent.status)) {
      // Build a specific error message per status. Telling the model
      // "agent is closed" vs "agent failed: <error>" vs "agent was
      // abandoned (idle too long)" gives it a clear next action.
      const desc = describeAgentStatus(agent.status);
      const detail = agent.status === STATUS.FAILED && agent.error
        ? `: ${agent.error}`
        : '';
      return JSON.stringify({
        next_steps: ERROR_NEXT_STEPS,
        error: `Agent "${agent.name}" is ${desc}${detail}. Spawn a new agent if you need more work.`,
        agentId: agent_id,
        status: agent.status,
      });
    }

    if (!isPromptableAgentStatus(agent.status)) {
      // Defensive — covers any future status that isn't terminal but
      // also isn't ready for prompts.
      return JSON.stringify({
        next_steps: ERROR_NEXT_STEPS,
        error: `Agent "${agent.name}" is in status "${agent.status}", which does not accept new prompts.`,
        agentId: agent_id,
      });
    }

    // Queue as a pending prompt the driver will pull. This wakes the
    // driver out of its idle wait and starts a new turn.
    enqueueSubAgentPrompt(agent, message, {
      projectSessionIds: ctx?.parentEngineDeps?.projectSessionIds,
      projectLabel: ctx?.parentEngineDeps?.projectLabel,
      projectInstruction: ctx?.parentEngineDeps?.projectInstruction,
    });
    agent.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });
    if (agent.status === STATUS.IDLE || agent.status === STATUS.CREATED) {
      agent.status = STATUS.RUNNING;
    }

    return JSON.stringify({
      next_steps:
        'Message is queued — the sub-agent has NOT replied yet. Continue useful ' +
        'work and rely on the next-turn notification, or use ListAgents when you ' +
        'need progress. Call WaitAgent only if the reply is required now. Do NOT ' +
        'end silently without telling the user what you asked.',
      success: true,
      agentId: agent_id,
      name: agent.name,
      messageCount: agent.messages.length,
      pending: agent.pendingPrompts.length,
      message: `Message sent to agent "${agent.name}". Continue useful work; use ListAgents or notifications for progress.`,
    });
  },
});
