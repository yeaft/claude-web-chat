# Work Center

Work Center 是 Yeaft 的 Agent-level durable task system。当目标必须跨越一次交互 turn、需要角色隔离或审查、可能等待人工输入，或者需要在浏览器断开/Agent 重启后恢复时，应使用 Work Center。

![展示 WorkItem conversation 与 Action graph 的 Work Center](/images/zh-CN/work-center.png)

## 心智模型

```text
WorkItem
  ├── contract：goal、acceptance criteria、workDir、attachments、memory policy
  ├── Coordinator conversation
  └── Action graph
        └── Run attempts：VP/model/tool snapshot、messages、usage、evidence
```

- **WorkItem** 是持久目标，也是面向用户的 conversation owner。
- **Action** 是一个具体规划步骤，包含 objective、approach、expected result、dependencies、assignment policy、model policy 和 workspace policy。
- **Run** 是执行 Action 的一次有 fence 的尝试。它的 identity 会阻止迟到或陈旧输出修改更新后的 attempt。
- **Event** 是 append-only 审计证据。当前状态来自 canonical WorkItem/Action/Run row，而不是通过 replay UI event 推导。

Work Center 不是 Session。它可以从 Session 创建并保留 origin link，但数据和生命周期属于所选 Agent。

## 创建 WorkItem

可以从侧栏打开 Work Center，也可以从 Yeaft Session 的 composer 发起。

新 WorkItem 需要：

1. requirement 或 goal；
2. working directory；
3. 可选文件（已支持的图片、PDF 或文本类 attachment）；
4. 是否复用符合条件的历史 memory；
5. 是否立即开始执行。

从 Session 创建时，runtime 会强制写入来源 Session；model input 不能替换这个 identity。

## 规划与执行

新 WorkItem 默认使用 AI planning：

1. Triage Action 检查合同与 repository context。
2. Triage 提交一个具体 WorkItem type，以及 1..8 个 task-specific Action。
3. Controller 校验 ID、dependency、workspace mode、cycle 和 final acceptance gate。
4. Scheduler claim ready Action，并选择符合条件的 VP。
5. 每个 Run 复用现有 Yeaft engine 执行，且必须提交 structured outcome。
6. Completed evidence 解锁依赖 Action；只有 final gate 成功后 WorkItem 才进入 `done`。

Graph 必须只有一个 final acceptance gate：通常是 `deliver` Action；如果不需要交付操作，则可以是一个 terminal approved `review`。其他所有 Action 都必须是它的传递依赖。

## 并发与 workspace policy

Work Center 最多按 `maxConcurrentActions` 并发执行彼此独立的 ready Action（默认 3，可配置 1..12）。Dependency、workspace policy 和 repository state 仍会约束实际并发。

| Workspace mode | 含义 |
| --- | --- |
| `read` | Planner/reviewer 的合同，表示 Action 不修改 files、Git state、services 或 external systems；它不是通用 OS sandbox。 |
| `shared` | 在 canonical working directory 执行；需要时串行化共享写操作。 |
| `isolated-write` | 在独立 Git worktree 执行彼此独立的代码修改。 |
| `integrate` | 合并声明的 isolated-write dependency；发生冲突时停止并交由明确处理。 |

如果 AI planning 使用 `isolated-write`，graph 必须包含且只包含一个 integrate Action，并直接依赖每个 isolated-write Action；下游工作使用 integration result。

## VP 与 model assignment

Action 可以使用：

- `auto`：根据 Action capability 选择 VP；
- `pool`：从明确候选中选择；
- `fixed`：使用一个固定 VP。

Review 可以要求与 implement/test 角色隔离。如果没有符合条件的 VP 或配置 model，WorkItem 会进入 attention，不会静默 fallback 到无关 VP 或 model。

Model policy 可以继承 runtime、选择 primary/fast，或者指定已配置 model。Effort 按 Action 解析，并冻结进 Run snapshot。

## Coordinator 与 Action conversation

WorkItem 主对话默认面向 **Coordinator**，用于：

- 查询当前状态或要求解释；
- 指导一个或多个未完成 Action；
- 修改 goal / acceptance criteria 并请求 replan；
- 恢复 Coordinator 可见的问题。

Coordinator 没有 file、shell 或 external side-effect tool。它的 structured decision 只能解释、指导 Action，或 replan 未完成工作。

当当前 Action 需要修正 context 或回答时，可以在 composer 明确选择它。Waiting/failed Action recovery 受 Action ID、revision、generation 和当前 Run state fence 保护。Action detail 展示连续 conversation，Execution tab 则按需加载保留的 request/loop/tool evidence。

## Outcome 与 recovery

Run 以以下状态之一结束：

- `completed`：包含具体 evidence 与要求的 acceptance check；
- `waiting`：包含人工问题/reason；
- `retryable`：允许且安全时再尝试；
- `failed`：自动继续不安全或 attempt 已耗尽。

Stop/cancel 会关闭 active execution fence；迟到 tool/model output 不能推进 WorkItem。Agent 重启时，陈旧 running Run 会变成 interrupted。安全 Action 可以在 attempt policy 内重新 ready；外部副作用不确定时必须进入 attention，不能盲目 retry。

## Memory reuse

`reuseMemory=true` 时，Work Center 可以计算三类有边界的候选来源：

- 当前 Agent memory index 的 scope-bounded full-text recall；
- 相同 canonical workspace key 下 completed WorkItem 的 structured summary/evidence；
- persisted workspace 解析到同一 canonical path 的普通 Session user-visible transcript excerpt。

Browser-created 和 legacy item 读取 Agent user scope。Trusted Session producer 还可以授权 source Session 与 current VP scope。Workspace transcript recall 只在 owner 本地运行，会验证 canonical path、排除当前 source Session，并且不读取 raw tool output。

这些只是候选来源，不代表每类都会进入每个 prompt。Execution schema v1 会在非空时附加 Runner 计算的 memory 与 workspace-Session block；schema v2 渲染 immutable Mainline context 与 fixed suffix，当前不会附加这两个预计算 block。所有 recall 都有 token budget，只是 reference context，不能覆盖 WorkItem contract、Action instruction、tool policy 或 completion protocol。`reuseMemory=false` 会关闭三条候选路径。

## Attachment 与 evidence

Attachment 随 WorkItem 持久化，并作为不受信任的 reference data。Runtime 会在注入或下载前检查 type、size、path stability 和 owner boundary。

Execution evidence 可以包含 summary、acceptance check、file/test reference、request usage、loop timing，以及保留的 tool input/output。Browser 按需加载详细 execution record；大型记录可能被限制或 summary。

## Work Center 不承诺什么

- 它不是无限制的 autonomous deployment service。
- `read` workspace policy 不是 kernel-level sandbox。
- 一个 Action completed 不足以让 WorkItem done；final acceptance gate 必须通过。
- `turn_end` 不是 Action completion；executor 必须提交 structured outcome contract。
- Work Center memory 永远不能获得高于当前合同与 safety rule 的权限。
- Session 与 WorkItem 不共享一份 transcript，也不是同一个 memory owner。

## 相关页面

- [Yeaft Session 与 Project](./yeaft-session.md)
- [原生 engine 架构](../tech/yeaft-engine.md)
- [Provider 与 model 配置](../yeaft-config.md)
- [内部 Work Center domain contract](../../../work-center/domain-contract.md)
