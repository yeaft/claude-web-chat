/**
 * Server-side Group Chat Manager
 *
 * 管理 Group Chat 频道的生命周期：
 * - 创建/删除频道
 * - Agent 加入/退出
 * - 链式接力讨论编排
 * - 共识检测与结论输出
 * - 广播消息给所有观察者
 */

import { randomUUID } from 'crypto';
import { agents, webClients } from './context.js';
import { sendToWebClient, sendToAgent, forwardToAgent } from './ws-utils.js';
import { CONFIG } from './config.js';

/** @type {Map<string, GroupChatSession>} */
export const groupChatSessions = new Map();

// =====================================================================
// Broadcast Helpers
// =====================================================================

/**
 * 广播消息给所有已认证的 web clients（Group Chat 是广播频道，所有人可见）
 */
async function broadcastToAll(msg) {
  for (const [, client] of webClients) {
    if (client.authenticated) {
      await sendToWebClient(client, msg);
    }
  }
}

/**
 * 广播消息给频道创建者的所有 client 连接
 */
async function broadcastToCreator(session, msg) {
  for (const [, client] of webClients) {
    if (client.authenticated && (CONFIG.skipAuth || client.userId === session.creatorId)) {
      await sendToWebClient(client, msg);
    }
  }
}

// =====================================================================
// Session Lifecycle
// =====================================================================

/**
 * 创建 Group Chat 频道
 * 由 ws-client.js 调用
 */
export function createGroupChat(clientId, userId, msg) {
  const { topic } = msg;
  const sessionId = `gc_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const session = {
    id: sessionId,
    topic,
    creatorId: userId,
    status: 'waiting',  // waiting | discussing | consensus | stopped
    participants: new Map(),  // agentId -> { agentId, agentName, joinedAt, status }
    messages: [],         // { id, agentId, agentName, content, round, timestamp }
    conclusion: null,
    round: 0,
    maxRounds: 10,
    speakOrder: [],       // agent 发言顺序
    currentSpeakerIndex: -1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  groupChatSessions.set(sessionId, session);

  // 广播给所有 clients
  broadcastToAll({
    type: 'group_chat_created',
    sessionId,
    topic,
    creatorId: userId,
    status: 'waiting',
    createdAt: session.createdAt
  });

  console.log(`[GroupChat] Session created: ${sessionId}, topic: "${topic}"`);

  return session;
}

/**
 * Agent 加入频道
 */
export async function handleAgentJoin(clientId, userId, msg) {
  const { sessionId, agentId } = msg;
  const session = groupChatSessions.get(sessionId);

  if (!session) {
    const client = webClients.get(clientId);
    if (client) await sendToWebClient(client, { type: 'error', message: 'Group chat session not found' });
    return;
  }

  if (session.participants.has(agentId)) {
    const client = webClients.get(clientId);
    if (client) await sendToWebClient(client, { type: 'error', message: 'Agent already in this group chat' });
    return;
  }

  const agent = agents.get(agentId);
  if (!agent) {
    const client = webClients.get(clientId);
    if (client) await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
    return;
  }

  const agentName = agent.name || agentId;

  // 记录参与者
  session.participants.set(agentId, {
    agentId,
    agentName,
    joinedAt: Date.now(),
    status: 'idle'
  });

  session.speakOrder.push(agentId);
  session.updatedAt = Date.now();

  // 通知 agent 加入（agent 端会创建 query 实例）
  const participantNames = Array.from(session.participants.values()).map(p => p.agentName);
  await sendToAgent(agent, {
    type: 'join_group_chat',
    sessionId,
    topic: session.topic,
    existingMessages: session.messages,
    participantNames
  });

  // 广播给所有 clients
  broadcastToAll({
    type: 'group_chat_member_joined',
    sessionId,
    agentId,
    agentName,
    participantCount: session.participants.size,
    participants: Array.from(session.participants.values()).map(p => ({
      agentId: p.agentId,
      agentName: p.agentName,
      status: p.status
    }))
  });

  console.log(`[GroupChat] Agent ${agentName} joined session ${sessionId} (${session.participants.size} participants)`);

  // 检查是否可以开始讨论（≥2 个 agent）
  if (session.status === 'waiting' && session.participants.size >= 2) {
    startDiscussion(session);
  }
}

/**
 * Agent 退出频道
 */
export async function handleAgentLeave(clientId, userId, msg) {
  const { sessionId, agentId } = msg;
  const session = groupChatSessions.get(sessionId);

  if (!session) return;

  if (!session.participants.has(agentId)) return;

  const agentName = session.participants.get(agentId).agentName;

  // 通知 agent 离开
  const agent = agents.get(agentId);
  if (agent) {
    await sendToAgent(agent, {
      type: 'leave_group_chat',
      sessionId
    });
  }

  session.participants.delete(agentId);
  session.speakOrder = session.speakOrder.filter(id => id !== agentId);
  session.updatedAt = Date.now();

  // 广播
  broadcastToAll({
    type: 'group_chat_member_left',
    sessionId,
    agentId,
    agentName,
    participantCount: session.participants.size,
    participants: Array.from(session.participants.values()).map(p => ({
      agentId: p.agentId,
      agentName: p.agentName,
      status: p.status
    }))
  });

  console.log(`[GroupChat] Agent ${agentName} left session ${sessionId} (${session.participants.size} remaining)`);

  // 如果讨论中且参与者不足，暂停
  if (session.status === 'discussing' && session.participants.size < 2) {
    session.status = 'waiting';
    broadcastToAll({
      type: 'group_chat_status',
      sessionId,
      status: 'waiting',
      reason: 'Not enough participants'
    });
  }
}

/**
 * 停止频道
 */
export async function stopGroupChatSession(clientId, userId, msg) {
  const { sessionId } = msg;
  const session = groupChatSessions.get(sessionId);

  if (!session) return;

  session.status = 'stopped';
  session.updatedAt = Date.now();

  // 通知所有参与 agent 停止
  for (const [agentId] of session.participants) {
    const agent = agents.get(agentId);
    if (agent) {
      await sendToAgent(agent, {
        type: 'stop_group_chat',
        sessionId
      });
    }
  }

  // 广播
  broadcastToAll({
    type: 'group_chat_status',
    sessionId,
    status: 'stopped'
  });

  console.log(`[GroupChat] Session ${sessionId} stopped`);
}

/**
 * 删除频道
 */
export function deleteGroupChat(sessionId) {
  groupChatSessions.delete(sessionId);
  console.log(`[GroupChat] Session ${sessionId} deleted`);
}

/**
 * 列出所有频道
 */
export function listGroupChats(clientId) {
  const list = Array.from(groupChatSessions.values()).map(s => ({
    id: s.id,
    topic: s.topic,
    status: s.status,
    participantCount: s.participants.size,
    participants: Array.from(s.participants.values()).map(p => ({
      agentId: p.agentId,
      agentName: p.agentName,
      status: p.status
    })),
    messageCount: s.messages.length,
    round: s.round,
    conclusion: s.conclusion,
    createdAt: s.createdAt
  }));

  const client = webClients.get(clientId);
  if (client) {
    sendToWebClient(client, {
      type: 'group_chat_list',
      sessions: list
    });
  }
}

// =====================================================================
// Discussion Orchestration
// =====================================================================

/**
 * 开始讨论（自动触发，≥2 个 agent 后）
 */
function startDiscussion(session) {
  session.status = 'discussing';
  session.round = 1;
  session.currentSpeakerIndex = 0;
  session.updatedAt = Date.now();

  broadcastToAll({
    type: 'group_chat_status',
    sessionId: session.id,
    status: 'discussing',
    round: 1,
    totalParticipants: session.participants.size
  });

  console.log(`[GroupChat] Discussion started for session ${session.id}, round 1`);

  // 让第一个 agent 发言
  requestNextSpeaker(session);
}

/**
 * 请求下一个 agent 发言
 */
async function requestNextSpeaker(session) {
  if (session.status !== 'discussing') return;

  const agentId = session.speakOrder[session.currentSpeakerIndex];
  if (!agentId) return;

  const agent = agents.get(agentId);
  if (!agent) {
    // Agent 掉线，跳过
    advanceSpeaker(session);
    return;
  }

  const participant = session.participants.get(agentId);
  if (participant) participant.status = 'speaking';

  // 广播谁在发言
  broadcastToAll({
    type: 'group_chat_status',
    sessionId: session.id,
    status: 'discussing',
    round: session.round,
    currentSpeaker: participant?.agentName || agentId,
    currentSpeakerAgentId: agentId
  });

  // 判断是否是本轮最后一个发言者（用于共识检查）
  const isLastInRound = session.currentSpeakerIndex === session.speakOrder.length - 1;
  const isConsensusCheck = isLastInRound && session.round >= 2;

  // 发送发言请求给 agent
  await sendToAgent(agent, {
    type: 'group_chat_speak',
    sessionId: session.id,
    round: session.round,
    discussionHistory: session.messages,
    isConsensusCheck
  });
}

/**
 * 处理 agent 发言完成
 * 由 ws-agent.js 调用（agent 发回 group_chat_speak_done）
 */
export async function handleSpeakDone(agentId, msg) {
  const { sessionId, content, consensus, usage } = msg;
  const session = groupChatSessions.get(sessionId);

  if (!session) return;

  const participant = session.participants.get(agentId);
  const agentName = participant?.agentName || msg.agentName || agentId;

  if (participant) participant.status = 'done';

  // 记录消息
  const message = {
    id: randomUUID(),
    agentId,
    agentName,
    content,
    round: session.round,
    timestamp: Date.now()
  };
  session.messages.push(message);
  session.updatedAt = Date.now();

  // 广播发言完成
  broadcastToAll({
    type: 'group_chat_message',
    sessionId,
    message,
    usage
  });

  // 检查共识
  if (consensus && consensus.reached) {
    session.status = 'consensus';
    session.conclusion = consensus.conclusion;

    broadcastToAll({
      type: 'group_chat_consensus',
      sessionId,
      conclusion: consensus.conclusion,
      round: session.round,
      totalMessages: session.messages.length
    });

    broadcastToAll({
      type: 'group_chat_status',
      sessionId,
      status: 'consensus',
      round: session.round
    });

    console.log(`[GroupChat] Consensus reached in session ${sessionId} at round ${session.round}`);
    return;
  }

  // 没有共识，继续讨论
  advanceSpeaker(session);
}

/**
 * 处理 agent 的流式输出
 */
export async function handleGroupChatOutput(agentId, msg) {
  const { sessionId } = msg;
  const session = groupChatSessions.get(sessionId);
  if (!session) return;

  // 直接广播流式输出给所有 clients
  broadcastToAll({
    type: 'group_chat_output',
    sessionId,
    agentId,
    agentName: msg.agentName,
    outputType: msg.outputType,
    content: msg.content,
    streaming: msg.streaming
  });
}

/**
 * 推进到下一个发言者
 */
function advanceSpeaker(session) {
  session.currentSpeakerIndex++;

  // 本轮所有人都发言完毕
  if (session.currentSpeakerIndex >= session.speakOrder.length) {
    // 检查是否达到最大轮数
    if (session.round >= session.maxRounds) {
      forceConclusion(session);
      return;
    }

    // 开始新一轮
    session.round++;
    session.currentSpeakerIndex = 0;

    // 重置所有参与者状态
    for (const [, p] of session.participants) {
      p.status = 'idle';
    }

    broadcastToAll({
      type: 'group_chat_status',
      sessionId: session.id,
      status: 'discussing',
      round: session.round
    });

    console.log(`[GroupChat] Starting round ${session.round} for session ${session.id}`);
  }

  // 请求下一个发言
  requestNextSpeaker(session);
}

/**
 * 达到最大轮数，强制要求最后一个发言者总结
 */
async function forceConclusion(session) {
  const lastAgentId = session.speakOrder[session.speakOrder.length - 1];
  const agent = agents.get(lastAgentId);

  if (agent) {
    await sendToAgent(agent, {
      type: 'group_chat_speak',
      sessionId: session.id,
      round: session.round,
      discussionHistory: session.messages,
      isConsensusCheck: true,
      forceConclusion: true
    });
  } else {
    // 如果最后一个 agent 不在线，直接停止
    session.status = 'stopped';
    session.conclusion = '讨论因达到最大轮数而结束，未能自动生成结论。';

    broadcastToAll({
      type: 'group_chat_status',
      sessionId: session.id,
      status: 'stopped',
      reason: 'Max rounds reached'
    });
  }
}

// =====================================================================
// Agent Disconnect Handling
// =====================================================================

/**
 * 当 agent 断开连接时，从所有 group chat sessions 中移除
 */
export function handleAgentDisconnect(agentId) {
  for (const [sessionId, session] of groupChatSessions) {
    if (session.participants.has(agentId)) {
      const agentName = session.participants.get(agentId).agentName;
      session.participants.delete(agentId);
      session.speakOrder = session.speakOrder.filter(id => id !== agentId);

      broadcastToAll({
        type: 'group_chat_member_left',
        sessionId,
        agentId,
        agentName,
        participantCount: session.participants.size,
        reason: 'disconnected'
      });

      if (session.status === 'discussing' && session.participants.size < 2) {
        session.status = 'waiting';
        broadcastToAll({
          type: 'group_chat_status',
          sessionId,
          status: 'waiting',
          reason: 'Participant disconnected'
        });
      }
    }
  }
}
