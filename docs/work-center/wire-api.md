# Work Center Wire API

Server 只做 owner 鉴权和 Agent/Web relay。所有请求必须带 `agentId`；所有 Agent 响应由 Server 盖上可信 `agentId` 后再发给 Web。支持该协议的 Agent 必须宣告 `work_center` capability；Server 不得把请求转发给未宣告该能力的旧 Agent。

## Web → Agent

统一请求消息：

```js
{
  type: 'work_center_request',
  agentId,
  requestId,
  op,
  payload
}
```

V1 操作：

- `list`：按状态、搜索词分页列出工作项。
- `get`：读取 WorkItem + Actions + Runs + Events。
- `create`：创建 draft/ready 工作项。
- `update`：修改 title、goal、acceptance criteria、workDir。
- `start`：把 draft/waiting 工作项推进到 ready。
- `cancel`：取消非终态工作项并 abort 当前 Run。
- `work_item_message`：向整个 WorkItem 追加消息；请求携带 WorkItem `revision`。成功后同一事务递增 revision，把消息排入所有 running Action，并让 ready/future Action 从 Mainline 的 WorkItem 消息上下文继承。若任一 running Action 已关闭输入窗口，整笔请求失败且不递增 revision，客户端必须保留草稿并刷新重试。
- `action_input`：向指定 Action 追加输入；请求必须携带正整数 `generation` 及 `actionId + revision`。ready Action 在同一事务中生成新的 canonical generation/spec identity，并以稳定 `inputId` 累积所有当前-spec input；schema-v2 Runner 从 canonical context 按顺序投影，Event 只补附件与审计元数据。running Action 通常不修改 Action spec，只把输入绑定到当前 `runId + generation + specHash`，并在下一个安全 Loop 消费；若 Run 中断或 Runner `prepare()` 因 workspace fallback 原子换代 execution identity，下一次 ready claim 或 fallback transaction 会把完整 identity 匹配的 input 晋升到 canonical context 并 settle pending row，使当前 Run 和后续 retry 都只投影一次。waiting/failed Action 恢复时只保留本次新输入。reset/replan/replacement 会删除旧 canonical input并 supersede 旧 identity 的未消费输入，禁止按 `actionId` 隐式跨代投递或放宽 Event generation fence。
- `retry_action`：显式重试指定 failed Action；请求携带 `actionId + revision + generation`，不要求用户先输入消息，也不得中止无关 sibling Run。
- `guide`：兼容管理型 Action guidance；请求必须携带用户看到的 `actionId` 和 WorkItem `revision`，匹配后才原子终止旧执行并重启同类型 Action。成功后 WorkItem `revision` 在同一事务中递增，因此相同请求不可重放；图流程原地 reset 目标 Action 及受影响下游，不得走线性 Action 替换。
- `retry`：兼容旧的 WorkItem 级恢复操作。
- `set_watcher`：启停当前 Agent 的 Watcher。
- `get_settings`：读取当前 Agent 的 Work Center workflow / VP assignment / model policy 设置及可用 VP、模型目录。
- `update_settings`：校验并原子写入当前 Agent 的 Work Center 设置；只影响之后创建的 WorkItem。
- `preview`：使用与 Runner 相同的选择器解析 workflow、stage override、实际 VP 和模型；不创建 WorkItem。

## Agent → Web

请求响应：

```js
{
  type: 'work_center_response',
  agentId,
  requestId,
  op,
  ok,
  data,
  error
}
```

状态广播：

```js
{
  type: 'work_center_event',
  agentId,
  event,
  workItem
}
```

`work_center_event` 是可丢失投影通知；浏览器重连后必须重新 `list/get`，不能把广播当作事实源。

## 安全边界

- Web 提供的 `agentId` 只用于选路，Server 必须调用现有 `checkAgentAccess`。
- Server 把浏览器 requestId 替换为 opaque requestId，并在内存中保存 `requestId → client + agentId`；响应只回到原客户端。
- Agent 输出中的 `agentId`、用户身份字段和浏览器 requestId 都不可信；Server 使用连接对应的 Agent 和自己的请求映射。
- 无请求上下文的事件只按 Server 记录的 Agent owner 投影。
- `work_center_event` 只广播 redacted summary DTO：id/title/goal/status/current Action/source Session/timestamps。不得携带 workDir、Run evidence、错误、模型快照或工具输出。
- `get` 是用户显式选择详情后的鉴权读取，可返回结构化 Run summary/evidence/waitingReason/error，但 evidence 不包含原始工具输出。
- WorkItem 的本地路径和完整执行日志只保存在 Agent 本地，不经过 Server 广播。
- Provider API key 和动态凭证不属于 Work Center 设置；Work Center 只保存 Agent LLM 设置中已有的完整 model ref。
- 新建 WorkItem 不接受浏览器提供的 workflow/stage/VP/model override；triage 冻结动态任务类型和 Action 流。AI 规划 WorkItem 每个 Run 读取当前 Work Center model/effort policy，并固化实际 VP、Provider、模型、effort 和选择原因；旧显式 workflow WorkItem 保留冻结 policy。
- 离线 Agent 不支持写操作；Web 显示离线状态，不做本地乐观完成。
