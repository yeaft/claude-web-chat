# Work Center 数据与状态合同

## WorkItem

```js
{
  id,
  revision,
  title,
  goal,
  acceptanceCriteria: [],
  workflowTemplate: 'software-change',
  status: 'draft|ready|running|waiting|needs_attention|done|cancelled',
  currentActionId,
  currentRunId,
  workDir,
  origin: { sessionId, messageId, createdBy },
  linkedSessionIds: [],
  createdAt,
  updatedAt
}
```

## Action

```js
{
  id,
  workItemId,
  sequence,
  type: 'triage|implement|review|deliver',
  requiredRole,
  instruction,
  status: 'ready|running|waiting|completed|failed|superseded|cancelled',
  attempt,
  maxAttempts,
  currentRunId,
  leaseEpoch,
  createdAt,
  updatedAt
}
```

## Run

```js
{
  id,
  actionId,
  ownerBootId,
  leaseEpoch,
  startedAt,
  expiresAt,
  endedAt,
  status: 'running|completed|waiting|retryable|failed|interrupted|cancelled',
  roleSnapshot,
  vpSnapshot,
  modelSnapshot,
  summary,
  evidence: [],
  waitingReason,
  error
}
```

## Event

Event 是 append-only 的人类可读审计记录。每次创建、认领、开始、完成、等待、重试、取消和恢复都写 Event。UI 不从事件反推当前状态；当前状态以 WorkItem/Action/Run 行为准。

## software-change 模板

```text
triage (omni)
  → implement (linus)
  → review (martin)
  → deliver (linus)
  → done
```

角色字段是 VP id/模板引用，不是常驻进程。执行时读取 VP profile 快照，后续修改 VP 不会改变历史 Run。

## 状态不变量

1. 一个 WorkItem 最多一个非终态 current Action。
2. 一个 Action 最多一个有效 running Run。
3. claim 成功必须同时递增 `leaseEpoch`；旧 Run 的提交因 epoch 不匹配被拒绝。
4. `turn_end` 不等于 Action completed；Runner 必须提交结构化 outcome。
5. `waiting` 会结束当前 Run，不保留假 running。
6. WorkItem 只有最后一个必需 Action completed 后才能进入 done。
7. 取消后任何旧 Run 不能再推进状态。
8. 修改目标或验收条件会递增 WorkItem revision，并使未完成 Action superseded，重新进入 triage。

## 恢复策略

- Agent 每次启动生成 `ownerBootId`。
- `running` Run 如果 bootId 不同或 `expiresAt` 过期，则标记 `interrupted`。
- 无已知副作用的 Action 且未超过 `maxAttempts`：重新置为 ready。
- deliver 或存在不确定副作用：WorkItem 进入 `needs_attention`，不得自动重试。
