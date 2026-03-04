/**
 * Group Chat - Multi-Agent Broadcast Discussion Channel
 *
 * 广播讨论频道：多个物理 agent 加入同一频道，围绕人类设定的主题
 * 进行链式接力讨论，自动检测共识并输出结论。
 *
 * 与 Crew 模式的本质区别：
 * - Crew: 单 agent 上运行多个 AI 角色
 * - Group Chat: 多个物理 agent 各自运行一个讨论者实例
 *
 * 人类角色：仅观看，可控制自己 agent 的加入/退出
 */

import { query, Stream } from './sdk/index.js';
import ctx from './context.js';

/** @type {Map<string, GroupChatParticipant>} */
const groupChatParticipants = new Map();
// key: sessionId, value: { sessionId, topic, queryInstance, inputStream, abortController, accumulatedText }

// 导出供 connection.js 使用
export { groupChatParticipants };

// =====================================================================
// Helpers
// =====================================================================

function sendToServer(msg) {
  if (ctx.sendToServer) ctx.sendToServer(msg);
}

// =====================================================================
// Join / Leave
// =====================================================================

/**
 * Agent 加入一个 group chat 频道
 * Server 发来 join_group_chat 消息
 */
export async function joinGroupChat(msg) {
  const { sessionId, topic, existingMessages, participantNames } = msg;

  if (groupChatParticipants.has(sessionId)) {
    console.warn(`[GroupChat] Already joined session: ${sessionId}`);
    return;
  }

  const agentName = ctx.CONFIG?.name || 'Unknown Agent';

  console.log(`[GroupChat] Joining session ${sessionId}, topic: "${topic}"`);

  // 创建 Claude query 实例用于讨论
  const inputStream = new Stream();
  const abortController = new AbortController();

  const systemPrompt = buildDiscussionSystemPrompt(topic, participantNames || []);

  const queryInstance = query({
    prompt: inputStream,
    options: {
      cwd: ctx.CONFIG?.workDir || process.cwd(),
      permissionMode: 'bypassPermissions',
      abort: abortController.signal,
      appendSystemPrompt: systemPrompt
    }
  });

  const participant = {
    sessionId,
    topic,
    queryInstance,
    inputStream,
    abortController,
    accumulatedText: '',
    speaking: false
  };

  groupChatParticipants.set(sessionId, participant);

  // 开始异步处理 query 输出
  processQueryOutput(sessionId, participant);

  // 通知 server 已加入
  sendToServer({
    type: 'group_chat_member_joined',
    sessionId,
    agentName
  });
}

/**
 * Agent 离开 group chat 频道
 */
export async function leaveGroupChat(msg) {
  const { sessionId } = msg;
  const participant = groupChatParticipants.get(sessionId);

  if (!participant) {
    console.warn(`[GroupChat] Not in session: ${sessionId}`);
    return;
  }

  const agentName = ctx.CONFIG?.name || 'Unknown Agent';

  // 中止 query
  try {
    participant.abortController.abort();
    participant.inputStream.close();
  } catch (e) {
    // ignore
  }

  groupChatParticipants.delete(sessionId);

  console.log(`[GroupChat] Left session ${sessionId}`);

  sendToServer({
    type: 'group_chat_member_left',
    sessionId,
    agentName
  });
}

// =====================================================================
// Speaking (Server asks this agent to speak)
// =====================================================================

/**
 * Server 要求此 agent 发言（链式接力中轮到此 agent）
 */
export async function handleSpeakRequest(msg) {
  const { sessionId, round, discussionHistory, isConsensusCheck } = msg;
  const participant = groupChatParticipants.get(sessionId);

  if (!participant) {
    console.warn(`[GroupChat] Not in session: ${sessionId}, cannot speak`);
    return;
  }

  participant.speaking = true;
  participant.accumulatedText = '';

  // 构建发言 prompt
  let prompt;
  if (isConsensusCheck) {
    prompt = buildConsensusCheckPrompt(participant.topic, discussionHistory, round);
  } else {
    prompt = buildSpeakPrompt(participant.topic, discussionHistory, round);
  }

  // 向 query inputStream 写入 prompt（使用 SDK Stream 的 enqueue 方法）
  const content = [{ type: 'text', text: prompt }];
  participant.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content }
  });
}

// =====================================================================
// Query Output Processing
// =====================================================================

async function processQueryOutput(sessionId, participant) {
  const agentName = ctx.CONFIG?.name || 'Unknown Agent';

  try {
    for await (const event of participant.queryInstance) {
      if (!groupChatParticipants.has(sessionId)) break;

      if (event.type === 'assistant') {
        // 提取文本内容
        const textBlocks = event.message?.content?.filter(b => b.type === 'text') || [];
        for (const block of textBlocks) {
          if (block.text) {
            participant.accumulatedText += block.text;

            // 流式发送输出
            sendToServer({
              type: 'group_chat_output',
              sessionId,
              agentName,
              outputType: 'text',
              content: block.text,
              streaming: true
            });
          }
        }
      } else if (event.type === 'result') {
        // 一次发言完成
        const finalText = participant.accumulatedText;
        participant.speaking = false;

        // 检查是否包含共识判断
        const consensusResult = parseConsensusResult(finalText);

        sendToServer({
          type: 'group_chat_speak_done',
          sessionId,
          agentName,
          content: finalText,
          consensus: consensusResult,
          usage: {
            inputTokens: event.usage?.input_tokens || 0,
            outputTokens: event.usage?.output_tokens || 0,
            costUsd: event.usage?.cost_usd || 0
          }
        });

        participant.accumulatedText = '';
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(`[GroupChat] Query error for session ${sessionId}:`, e.message);

    sendToServer({
      type: 'group_chat_output',
      sessionId,
      agentName,
      outputType: 'error',
      content: `Error: ${e.message}`
    });
  }
}

// =====================================================================
// Prompt Building
// =====================================================================

function buildDiscussionSystemPrompt(topic, participantNames) {
  return `# 你正在参与一场多 Agent 广播讨论

## 讨论主题
${topic}

## 规则
1. 你是讨论中的一位参与者，请围绕主题发表你的观点
2. 你可以看到之前所有参与者的发言，请在此基础上补充、反驳或深化
3. 保持观点简洁有力，每次发言不超过 300 字
4. 使用中文讨论
5. 你的发言应该有独立思考，而不是简单附和

## 当前参与者
${participantNames.length > 0 ? participantNames.join(', ') : '等待参与者加入...'}`;
}

function buildSpeakPrompt(topic, discussionHistory, round) {
  let prompt = `## 第 ${round} 轮讨论\n\n`;

  if (discussionHistory && discussionHistory.length > 0) {
    prompt += `### 之前的讨论内容\n\n`;
    for (const entry of discussionHistory) {
      prompt += `**${entry.agentName}**: ${entry.content}\n\n`;
    }
    prompt += `---\n\n`;
  }

  prompt += `请围绕主题"${topic}"发表你的观点。`;

  if (discussionHistory && discussionHistory.length > 0) {
    prompt += `请在上述讨论基础上，补充新的见解、提出不同角度、或对之前的观点进行评价。`;
  } else {
    prompt += `你是第一位发言者，请先给出你对这个主题的核心观点。`;
  }

  prompt += `\n\n注意：只输出你的讨论发言内容，不要输出任何元数据或格式标记。保持简洁，不超过 300 字。`;

  return prompt;
}

function buildConsensusCheckPrompt(topic, discussionHistory, round) {
  let prompt = `## 共识检查（第 ${round} 轮结束）\n\n`;
  prompt += `### 讨论主题\n${topic}\n\n`;
  prompt += `### 全部讨论记录\n\n`;

  for (const entry of discussionHistory) {
    prompt += `**${entry.agentName}** (第 ${entry.round} 轮): ${entry.content}\n\n`;
  }

  prompt += `---\n\n`;
  prompt += `请分析以上所有讨论内容，判断参与者是否已经达成基本共识。

请按以下格式回复：

---CONSENSUS---
reached: true 或 false
conclusion: 如果达成共识，写出共识结论（200字以内）。如果未达成，简述主要分歧点。
---END_CONSENSUS---

判断标准：
- 如果大多数参与者的核心观点趋于一致或互补，视为达成共识
- 如果存在根本性分歧且没有收敛趋势，视为未达成共识
- 如果只是在细节上有分歧但大方向一致，仍视为达成共识`;

  return prompt;
}

// =====================================================================
// Consensus Parsing
// =====================================================================

function parseConsensusResult(text) {
  const match = text.match(/---CONSENSUS---\s*\n([\s\S]*?)---END_CONSENSUS---/);
  if (!match) return null;

  const block = match[1];
  const reachedMatch = block.match(/reached:\s*(true|false)/i);
  const conclusionMatch = block.match(/conclusion:\s*([\s\S]*?)$/m);

  if (!reachedMatch) return null;

  return {
    reached: reachedMatch[1].toLowerCase() === 'true',
    conclusion: conclusionMatch ? conclusionMatch[1].trim() : ''
  };
}

// =====================================================================
// Cleanup
// =====================================================================

/**
 * 清理某个 session 的参与状态（由 server 发起停止时调用）
 */
export function stopGroupChat(msg) {
  const { sessionId } = msg;
  const participant = groupChatParticipants.get(sessionId);

  if (participant) {
    try {
      participant.abortController.abort();
      participant.inputStream.done();
    } catch (e) {
      // ignore
    }
    groupChatParticipants.delete(sessionId);
    console.log(`[GroupChat] Stopped and cleaned up session ${sessionId}`);
  }
}
