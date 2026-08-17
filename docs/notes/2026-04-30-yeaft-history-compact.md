# Yeaft 群聊 in-memory 历史 compact（已退役）

> **Retired 2026-08-17**：本历史记录描述的 LLM conversation-summary 路径已删除。当前行为见 `docs/notes/2026-08-17-yeaft-disk-llm-summary-retired.md`。

旧实现曾经为了解决群聊内存 history 无限增长，调用 fast model 生成 `_compactSummary`，替换当前 query 的历史数组，并在磁盘侧维护另一份 conversation summary。该设计已经证明职责重复、会产生额外延迟和成本，因此不再作为运行时契约。

当前替代方案是 `agent/yeaft/history-window.js`：

- 只在 provider request 前构造有界消息副本；
- 只做确定性的 turn/token/tool 裁剪；
- 不调用 LLM；
- 不写 `compact.md` 或任何 compact summary；
- 不改写权威 transcript；
- context overflow 仍然存在时直接产生 terminal error。

旧实现的详细设计、测试和历史结果保留在 Git 历史中，不再作为当前代码或配置说明。
