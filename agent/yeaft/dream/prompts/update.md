<!-- lang:en -->
You are updating an existing memory scope.

Scope: {{target}}
{{batchHeader}}
Current canonical content.md:
"""
{{contentMd}}
"""

Current catalog summary.md:
"""
{{summaryMd}}
"""

Recent session conversations:
{{sources}}

Task:
- Extract from these conversations what is relevant to THIS scope.
- Prefer reusable experience over chronology: workflows, preferences, pitfalls, corrections, project conventions, review/merge/tag lessons, and rules that should change future execution.
- Keep current PR/review/blocker detail only when it is still actionable.
- Rewrite content.md as the canonical current text (reorganize sections if needed).
- Preserve every still-valid concrete fact, decision, constraint, preference, workflow, pitfall, correction, and actionable state from the existing content or new conversations. Do not shorten by dropping unique valid information.
- Drop only stale, contradicted, duplicated, or scope-irrelevant entries.
- Rewrite summary.md as a 1–3 sentence catalog description for topic selection. It is not the authoritative memory and must not be used to compensate for omissions from content.md.
- The same conversations are being processed for OTHER scopes too.
  Only handle what is relevant here. Ignore the rest.

Hard rules:
- Never read or reference any other scope's files.
- Never modify VP system prompt, session charter, or user preferences.
- If something contradicts a charter, annotate with
  "⚠️ contradicts charter — verify which is current" and continue.

Reply with strict JSON of the shape:
{ "content_md": "...", "summary_md": "..." }

<!-- lang:zh -->
你正在更新一个已有的 memory scope。

Scope: {{target}}
{{batchHeader}}
当前 canonical content.md：
"""
{{contentMd}}
"""

当前目录 summary.md：
"""
{{summaryMd}}
"""

最近的会话对话：
{{sources}}

任务：
- 从这些对话中提取与当前作用域相关的内容。
- 优先保留可复用经验，而不是流水账：工作流、偏好、坑点、纠偏、项目约定、review/merge/tag 教训，以及会改变后续执行方式的规则。
- 当前 PR、review、阻塞细节只有仍可执行时才保留。
- 将 content.md 重写为 canonical 当前正文（必要时重组章节）。
- 对现有正文和新对话中的每条仍有效具体事实、决策、约束、偏好、工作流、坑点、纠偏和可执行状态都必须保留；不得为了缩短篇幅而丢掉独有的有效信息。
- 只删除过期、被推翻、重复或不属于当前 scope 的条目。
- 将 summary.md 重写为 1–3 句的目录描述，只用于 topic 选择；它不是权威记忆，也不能用来补偿 content.md 的信息缺失。
- 同一批对话也会被处理到其他作用域。
  这里只处理与当前作用域相关的内容，忽略其他内容。

硬规则：
- 不要读取或引用其他作用域的文件。
- 不要修改 VP 系统提示词、会话章程或用户偏好。
- 如果某条内容与章程冲突，标注
  "⚠️ 与章程冲突——确认哪一条是当前事实" 并继续。

只回复严格 JSON，结构如下：
{ "content_md": "...", "summary_md": "..." }
