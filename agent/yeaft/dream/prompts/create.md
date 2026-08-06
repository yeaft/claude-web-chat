<!-- lang:en -->
You are creating a new memory scope from scratch.

Scope path: {{target}}   (must be ≤2 levels)

Source session conversations:
{{sources}}

{{siblingsBlock}}
Task:
1. Write canonical content.md from scratch with a reasonable section structure.
2. Preserve every concrete fact, decision, constraint, preference, workflow, pitfall, correction, project convention, and actionable state relevant to this scope. Do not replace specifics with a vague summary.
3. Keep current PR/review/blocker detail only when it is still actionable.
4. Write summary.md as a 1–3 sentence catalog description used only for later topic selection.

Reply with strict JSON of the shape:
{ "content_md": "...", "summary_md": "..." }

<!-- lang:zh -->
你正在从零创建一个新的 memory scope。

Scope path: {{target}}   (must be ≤2 levels)

来源会话对话：
{{sources}}

{{siblingsBlock}}
任务：
1. 从零编写 canonical content.md，并使用合理的章节结构。
2. 保留属于当前 scope 的每条具体事实、决策、约束、偏好、工作流、坑点、纠偏、项目约定和可执行状态；不得用模糊摘要替代具体信息。
3. 当前 PR、review、阻塞细节只有仍可执行时才保留。
4. 编写 1–3 句的 summary.md 目录描述，它只用于后续 topic 选择。

只回复严格 JSON，结构如下：
{ "content_md": "...", "summary_md": "..." }
