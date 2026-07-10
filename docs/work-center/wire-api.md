# Work Center Wire API

Server 只做 owner 鉴权和 Agent/Web relay。所有请求必须带 `agentId`；所有 Agent 响应由 Server 盖上可信 `agentId` 后再发给 Web。

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
- `retry`：人工把 needs_attention/waiting 创建为新 ready Action。
- `set_watcher`：启停当前 Agent 的 Watcher。

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
- WorkItem 的本地路径和原始 Run 日志默认不经过 Server 广播；响应只返回结构化摘要和明确 evidence。
- 离线 Agent 不支持写操作；Web 显示离线状态，不做本地乐观完成。
