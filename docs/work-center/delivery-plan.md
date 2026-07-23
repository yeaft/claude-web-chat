# Work Center 交付计划

## 阶段 1：领域核心

- SQLite schema 与迁移版本。
- WorkItem/Action/Run/Event Store。
- software-change 流程 Controller。
- claim、leaseEpoch、boot recovery。
- Store/Controller/Watcher 单元测试。

## 阶段 2：执行闭环

- Role → VP profile 解析。
- WorkItem 专用 ToolRegistry allowlist。
- 复用现有 Yeaft Engine 的 sessionless、read-only conversation run。
- 结构化 outcome 提交、abort 和事件归档。
- Runner 与恢复测试。

## 阶段 3：Wire 与 Server

- Agent message-router handlers。
- Server owner-checked relay。
- Agent 响应盖章与 owner client 广播。
- 请求/响应和越权测试。

## 阶段 4：Web UI

- `currentView: 'work-center'`。
- 侧栏顶部 Work Center 可展开 Agent 列表。
- Agent 工作项列表、详情、创建、开始、取消和重试。
- 加载、空、离线、错误和执行状态。
- 中英文 i18n、light/dark token 样式。

## 阶段 5：验证与发布

- 定向单元/集成/UI 测试。
- `npm run check:server-agent-syntax`。
- `npm run build`。
- `npx vitest run` 全量测试。
- Martin 独立 review。
- PR 合并到 main 后打下一个 `v1.0.X` tag。

## V1 完成定义

- Agent 重启后工作项仍可读取，过期 running 状态能准确恢复。
- 两个 Watcher 不能同时 claim 同一个 Action。
- Runner 的 turn 结束不会自动伪造 completed。
- waiting、failed、cancelled、retry 和 review 退回均有准确持久状态。
- Web 能从侧栏选择 Agent 并查看、创建和控制其 Work Center。
- WorkItem 不写入来源 Session transcript，也不混入 Session 后台作业列表。
