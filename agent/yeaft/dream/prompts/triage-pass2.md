<!-- lang:en -->
Bind a free-form topic description to an exact path under topic/.
Rules:
  - At most TWO path segments. Reject any third level.
  - Segments may contain letters, digits, dashes, underscores, dots, CJK.
  - Existing paths are canonical. Return "match" whenever any existing topic can contain the new information, even if wording, language, casing, a PR number, or a one-off execution state differs.
  - Return "new" only for a stable subject that is materially distinct from every existing topic. Never create a topic merely for one PR, review run, commit, release, status, or spelling variant.

Description: {{description}}

Existing topics:
{{existingTopics}}

Reply with strict JSON, exactly one of:
  { "decision": "match", "path": "<existing path>" }
  { "decision": "new",   "path": "<new ≤2-segment path>" }
  { "decision": "none" }

<!-- lang:zh -->
把一个自由描述的 topic 绑定到 topic/ 下的精确路径。
规则：
  - 最多 TWO 个路径段。拒绝任何第三级路径。
  - 路径段可包含字母、数字、短横线、下划线、点、CJK 字符。
  - 已有路径是 canonical。只要任一已有 topic 能容纳新信息，即使措辞、语言、大小写、PR 编号或一次性执行状态不同，也必须返回 "match"。
  - 只有主题稳定且与所有已有 topic 实质不同才返回 "new"。不得只因单个 PR、review 轮次、commit、release、状态或拼写变体创建 topic。

描述：{{description}}

已有 topics：
{{existingTopics}}

只回复严格 JSON，且必须是以下三种之一：
  { "decision": "match", "path": "<existing path>" }
  { "decision": "new",   "path": "<new ≤2-segment path>" }
  { "decision": "none" }
