# History Window 与 Dream：transcript / Memory 边界

> **Status**：当前设计基线（2026-08-17）
> **决策**：Yeaft 不再生成或持久化 LLM conversation summary。

## 当前边界

| 层 | 权威数据 | 运行时职责 | 是否调用 LLM | 是否改写 transcript |
| --- | --- | --- | --- | --- |
| Agent transcript | ConversationStore JSONL segments + index | 保存完整 user/assistant/tool 历史；重启读取最近 turns；旧记录通过分页/搜索获取 | 否 | 只在正常消息 durability / tool reflection 边界按既有规则写入 |
| Provider history window | 当前 query 的消息副本 | `agent/yeaft/history-window.js` 按 turn/token 边界裁剪旧消息、工具噪音和过大的 tool result；保证 tool pair 安全 | 否 | 否 |
| Memory / Dream | 每个 scope 的 `memory.md` + `summary.md`，SQLite FTS 为可重建索引 | Dream 后台维护长期事实、偏好、决策；AMS 在 prompt 的 Memory outlet 注入 | 是，按 Dream 自己的 pipeline | 不写 conversation summary |
| Browser history | 当前可见窗口和分页缓存 | 展示最近连续窗口，向上分页加载旧 transcript | 否 | 否 |

## 已退役的磁盘摘要

以下路径和行为已删除：

- turn 结束后自动调用 LLM 生成累计 conversation summary；
- `compact.md`、`conversation/compact/*.md` 的新读写；
- `<conversation_summary>` prompt 注入；
- `LLMContextError` 触发隐藏摘要调用和重试；
- post-turn `Compactor`、`history-compact` LLM summarizer、compact WS 事件。

已有的旧 summary 文件不会被运行时读取。后续如需清理，应使用独立的、非 LLM、可回滚的迁移；本改动不触碰用户运行时数据。

## Context overflow 语义

Context overflow **不是**另一个 compact 入口。

每个 provider request 之前，`history-window.js` 已经对消息副本做确定性裁剪。若 provider 仍返回 context overflow：

1. 不调用 summary LLM；
2. 不写 summary 文件；
3. 不移动或删除历史消息；
4. 直接向调用方报告 terminal error。

这保证“删除磁盘摘要”是真删除，而不是把同一件事换成另一个隐藏摘要调用。

## 长期信息恢复

重启后的模型上下文由以下部分组成：

```text
最近的持久化 transcript turns
+ 当前 query 的 Memory/Dream recall
+ Project / Session / VP instruction
+ 当前请求的 deterministic history window
```

更早的对话不是被摘要替代：用户可以用历史分页或搜索取回原文；需要跨轮长期保留的语义事实应由 Memory/Dream 管理。
