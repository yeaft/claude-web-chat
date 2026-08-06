<!-- lang:en -->
Merge duplicate topic contents into one canonical topic.

Canonical path: {{canonical}}

Existing topic contents:
{{topicContents}}

Requirements:
- Preserve every unique, still-valid concrete fact, decision, constraint, preference, workflow, pitfall, correction, and actionable state.
- Resolve direct contradictions in favor of the newest explicit correction when evident; otherwise preserve both with an uncertainty note.
- Remove duplication, stale superseded execution state, and scope-path boilerplate.
- content_md is authoritative and may be as long as required for information completeness.
- summary_md is only a 1–3 sentence catalog description.

Reply with strict JSON:
{ "content_md": "...", "summary_md": "..." }

<!-- lang:zh -->
把重复 topic 的内容合并到一个 canonical topic。

Canonical 路径：{{canonical}}

现有 topic 内容：
{{topicContents}}

要求：
- 保留每一条独有且仍有效的具体事实、决策、约束、偏好、工作流、坑点、纠偏和可执行状态。
- 如果能明确判断，以最新的显式纠偏解决直接冲突；否则保留双方并标注不确定性。
- 删除重复、已被推翻的短期执行状态和 scope 路径套话。
- content_md 是权威正文，可按信息完整性需要保留长度。
- summary_md 只是 1–3 句的目录描述。

只回复严格 JSON：
{ "content_md": "...", "summary_md": "..." }
