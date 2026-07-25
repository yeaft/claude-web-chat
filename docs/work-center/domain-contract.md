# Work Center 数据与状态合同

## WorkItem

```js
{
  id,
  revision, // optimistic concurrency version for contract changes
  planRevision,
  ledgerRevision,
  coordinatorRevision, // monotonic WorkItem conversation fence
  title,
  goal,
  acceptanceCriteria: [],
  workflowTemplate: 'ai-planned',
  workflowSnapshot: { id, name, planningMode, workItemType, globalInstructions, modelPolicy, actionInstructions, stages: [] },
  messages: [{ id, turnId, role: 'user|assistant', status: 'thinking|completed|failed', text, decision }],
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
  type: 'lowercase-slug', // built-in policy types or a validated AI-planned domain type
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

## 默认 AI 规划

新 WorkItem 只从目标、验收标准和工作目录创建一个 triage Action。Triage 必须返回受 schema 约束的 `workItemType` 与 1..8 个后续 Action；Controller 校验后在同一个终态事务中冻结计划并创建第一个 Action。Action type 是经过 slug 归一化的可扩展领域类型；内置的 research/design/diagnose/implement/migrate/test/review/document/operate/deliver/write 等类型有专用执行基线，其他类型保留原始领域语义并使用 custom 基线。计划不能指定 VP、模型或 effort。

Action 只绑定任务类型、能力和执行隔离约束，实际 VP 在 Run claim 后从当前 Agent VP 池动态选择。AI 规划 WorkItem 的模型和 effort 在每次 Run 开始时读取当前 Work Center policy，并固化到 Run snapshot；旧的显式 workflow WorkItem 继续使用创建时冻结的 policy。Provider 凭证仍由 Agent LLM 设置管理，不写入 Work Center。

Agent 级 `globalInstructions` 类似 Session 公告，但只作用于 Work Center。创建 WorkItem 时它会冻结进 workflow snapshot，并以低于 WorkItem 合同及系统/工具安全规则的优先级注入 triage 和每个后续 Action；修改设置不会追溯改变正在执行或历史 WorkItem。

Work Center memory 有两条受 `reuseMemory` 控制的路径：同 canonical workspace key 下已完成 WorkItem 的结构化 summary/evidence，以及当前 Agent SQLite FTS 的 scope-bounded 召回。FTS 查询由 WorkItem 合同和当前 Action instruction 构造；浏览器和旧数据只读取 Agent 全局 `user` scope，只有 Agent 内部 Session producer 创建的 WorkItem 才可额外读取经过可信来源 Session + 当前 VP 限定的 scope。FTS 注入预算上限 4000 tokens，不启用无关键词的最近内容 fallback。召回结果是可能过期的参考资料，不能覆盖合同、全局指令、Action prompt、工具策略或完成协议。

## WorkItem Coordinator

用户默认与 WorkItem 级 Coordinator 对话，而不是直接把自然语言塞给某个执行 Action。Coordinator 使用独立的 model/effort policy，不拥有文件、Shell 或外部副作用工具，只能返回三类结构化决策：解释当前状态、给一个或多个未完成 Action 下发指令、或者修改合同并重规划完整的未完成 Action 图。schema 18 以前的 `messages` 是已注入执行器的全局指令，迁移后标记为 `legacy_instruction`，只作为历史上下文展示，不能伪装成已经由 Coordinator 回复过的 user turn。

Coordinator turn 在模型调用前同步持久化用户消息和 `thinking` 占位，并冻结 `revision + planRevision + ledgerRevision + coordinatorRevision`。模型返回后，合同、图、Action generation、Run supersede、审计事件和回复在同一个 `BEGIN IMMEDIATE` 事务中提交；任一 fence 已变化就拒绝旧决策。已完成 Action 和 canonical evidence 永不被重写。Action 页面只承担执行记录与 waiting/failed 恢复，不能修改整个 WorkItem 目标。

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
13. Work Center 可复用同一 canonical workspace key 下已完成 WorkItem 的结构化 Run summary/evidence，并从当前 Agent memory index 做 scope-bounded FTS 召回；不复用原始工具输出，`reuseMemory=false` 时两条路径都完全关闭。
14. canonical workspace key 同时是执行目录的权威值；Runner 不得在执行时重新信任可变的原始 `workDir`。旧数据迁移只 backfill 当前可解析的目录，无法解析的显式目录在修正前不得执行或参与记忆复用。
15. 用户补充提示分为两个 scope。Action 级输入使用 `actionId + revision + generation` 做事务 fence，只用于 waiting/failed Action 的直接恢复；WorkItem 级消息进入 Coordinator，并使用 `revision + planRevision + ledgerRevision + coordinatorRevision` 做事务 fence。Coordinator 的 contract/graph/Action 决策和回复必须原子提交，旧决策不能覆盖新执行状态。
16. failed Action 的显式重试必须固定目标 Action identity，图流程原地 reset 该 Action 及受影响下游，并保留无关 sibling Run、stage、依赖、workspace、分配/模型策略和历史 context。
17. AI 规划 WorkItem 在 triage 完成时固化任务类型和 Action 流，但每次 Run 使用当时的 Work Center model/effort policy；旧显式 workflow WorkItem 仍使用创建时固化的 policy snapshot。
18. Settings 使用 revision compare-and-swap；并发旧版本保存必须拒绝并要求重新加载。
19. 中间 test Action 只验证自身的 task-specific expected result，可以把未到达的全局标准标记为 deferred；只有 deliver 和没有下游工作的 approved review 才要求全部 WorkItem 验收条件 passed。

## 恢复策略

- Agent 每次启动生成 `ownerBootId`。
- `running` Run 如果 bootId 不同或 `expiresAt` 过期，则标记 `interrupted`。
- 无已知副作用的 Action 且未超过 `maxAttempts`：重新置为 ready。
- deliver 或存在不确定副作用：WorkItem 进入 `needs_attention`，不得自动重试。
