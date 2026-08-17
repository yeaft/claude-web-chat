# Yeaft 磁盘级 LLM 对话摘要退役

**日期**：2026-08-17

Yeaft 原生引擎不再在 turn 结束后调用 LLM，把 conversation transcript 折成 `compact.md` 或 scoped compact summary。

## 现在的职责划分

- **Transcript**：ConversationStore JSONL 是完整历史的权威来源。
- **History window**：`agent/yeaft/history-window.js` 只在每次 provider request 前对消息副本做确定性 turn/token/tool 裁剪；不调用 LLM、不写盘、不改 transcript。
- **Memory/Dream**：长期事实、偏好和决策由 Memory/Dream 管理，通过 AMS Memory outlet 注入 prompt。
- **Browser**：只展示当前可见窗口，旧 transcript 通过分页和搜索读取。

## 明确删除的行为

- post-turn `Compactor` / `history-compact` LLM summarizer；
- `Engine.#maybeConsolidate()` 的 conversation-summary 路径；
- `compact.md` 和 `conversation/compact/*.md` 的读写和 prompt 注入；
- context overflow 时的隐藏摘要调用和重试；
- Yeaft compact WS 事件。

## Context overflow

Provider 仍然可能因 system prompt、工具定义或单个 turn 过大返回 context overflow。此时运行时不再偷偷调用摘要模型，不改写历史，直接产生 terminal error。用户可通过提高模型上下文、缩小工具输出或重新提交请求解决；长期语义应由 Memory/Dream 保存。

旧 summary 文件只读不读，不在本次改动中主动删除用户运行时数据。后续清理必须另做可回滚、非 LLM 的迁移。
