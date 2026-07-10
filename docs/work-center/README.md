# Work Center

Work Center 是 Yeaft 的 Agent 级持久工作管理能力。它把需要跨 turn、跨 Session、角色接力或后台恢复的目标保存为 `WorkItem`，再由 Watcher 认领当前 `Action`，复用现有 Yeaft Engine 执行。

## 边界

- WorkItem 由 Agent 拥有，保存在 Agent 本地 `<yeaftDir>/work-center/`。
- Session 只作为来源和关联入口，不拥有 WorkItem 生命周期。
- 现有 `agent/yeaft/tasks/` 继续表示 Session 后台作业；WorkItem 不复用这套存储或状态。
- V1 只支持一个 WorkItem 同时一个 current Action，不实现任意 DAG、多 Action 并行或流程设计器。
- Watcher 只负责认领、租约和触发；状态推进只由 Workflow Controller 完成。
- Runner 是现有 Yeaft Engine 的薄适配层，不实现第二套模型循环。

## 文档

1. [架构与数据流](./architecture.md)
2. [数据和状态合同](./domain-contract.md)
3. [Wire API](./wire-api.md)
4. [交付阶段与验证](./delivery-plan.md)

## V1 用户路径

1. 用户从 Work Center 创建工作项，或从 Session 把一个长期任务转为工作项。
2. Triage Action 补全目标、验收条件和执行上下文。
3. Watcher 原子认领 ready Action，按 `requiredRole` 解析 VP 模板并启动 Run。
4. Run 通过结构化终态提交 `completed`、`waiting`、`retryable` 或 `failed`。
5. Controller 生成下一 Action，直到 deliver 完成并把 WorkItem 标为 done。
6. 全局 Work Center 展示所选 Agent 的工作项；Session 以后可按 origin/link 投影相关工作项。
