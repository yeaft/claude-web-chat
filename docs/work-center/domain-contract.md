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
  workflowSnapshot: { id, name, stages: [] },
  status: 'draft|ready|running|waiting|needs_attention|done|cancelled',
  currentActionId,
  currentRunId,
  workDir,
  reuseMemory,
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
  type: 'triage|implement|test|review|deliver|research|write|custom',
  stageId,
  assignmentPolicy: { mode: 'auto|pool|fixed', capability, candidateVpIds, fixedVpId, separateFromStageTypes },
  modelPolicy: { mode: 'inherit|primary|fast|specific', model, effort },
  requiredRole, // legacy fixed-VP compatibility only
  instruction,
  context: [{ type, stageId, vpId, role, summary, evidence, reviewDecision }],
  contractRevision,
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
  toolPolicySnapshot,
  summary,
  evidence: [],
  waitingReason,
  error,
  reviewDecision,
  contractPatch
}
```

## Event

Event 是 append-only 的人类可读审计记录。每次创建、认领、开始、完成、等待、重试、取消和恢复都写 Event。UI 不从事件反推当前状态；当前状态以 WorkItem/Action/Run 行为准。

## 默认 software-change 模板

```text
triage (capability: triage)
  → implement (capability: implement)
  → review (capability: review; 与 implement VP 隔离)
  → deliver (capability: deliver)
  → done
```

阶段绑定的是工作类型、能力和隔离约束，不是固定 VP 名字。每阶段可配置 `auto`、候选 `pool` 或 `fixed`，并配置继承 VP、Agent primary/fast 或具体模型。执行时固化实际 VP 和模型快照，后续修改设置或 VP 不会改变历史 Run。Provider 凭证仍由 Agent LLM 设置管理，不写入 Work Center。

## 状态不变量

1. 一个 WorkItem 最多一个非终态 current Action。
2. 一个 Action 最多一个有效 running Run。
3. claim 成功必须同时递增 `leaseEpoch`；旧 Run 的提交因 epoch 不匹配被拒绝。
4. `turn_end` 不等于 Action completed；Runner 必须提交结构化 outcome。
5. `waiting` 会结束当前 Run，不保留假 running。
6. WorkItem 只有最后一个必需 Action completed 后才能进入 done。
7. 取消后任何旧 Run 不能再推进状态。
8. 修改目标或验收条件会在一个 SQLite 事务中终止当前 Run、递增 WorkItem revision、使未完成 Action superseded，并重新进入 triage。
9. Run 终态、Action 终态、WorkItem 状态、下一 Action 和 Event 必须在一个事务提交；中途失败全部回滚。
10. completed review 必须带 `approved|changes_requested`；缺失或非法值进入 `needs_attention`。
11. Triage 可提交受限 `contractPatch`；下一 Action 的 context 必须包含有效前序 summary/evidence/decision。
12. VP 或模型策略无法解析时停止执行并进入 `needs_attention`，不得自动回退到 omni 或其他模型。
13. Work Center 只复用同一 Agent、创建时 canonical workspace key 相同且已完成 WorkItem 的结构化 Run summary/evidence；不复用原始工具输出，`reuseMemory=false` 时完全关闭。
14. canonical workspace key 同时是执行目录的权威值；Runner 不得在执行时重新信任可变的原始 `workDir`。旧数据迁移只 backfill 当前可解析的目录，无法解析的显式目录在修正前不得执行或参与记忆复用。
15. 用户补充提示作用于当前 Action：请求用 `actionId + revision` 做事务 fence；匹配后旧 Run 原子终止、旧 Action superseded，新 Action 保留类型、分配/模型策略和历史 context 后重新执行。
16. WorkItem 创建时固化 Workflow policy snapshot；Work Center Settings 更新只影响之后创建的 WorkItem。
17. Settings 使用 revision compare-and-swap；并发旧版本保存必须拒绝并要求重新加载。

## 恢复策略

- Agent 每次启动生成 `ownerBootId`。
- `running` Run 如果 bootId 不同或 `expiresAt` 过期，则标记 `interrupted`。
- 无已知副作用的 Action 且未超过 `maxAttempts`：重新置为 ready。
- deliver 或存在不确定副作用：WorkItem 进入 `needs_attention`，不得自动重试。
