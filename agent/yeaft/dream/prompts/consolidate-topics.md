<!-- lang:en -->
Identify duplicate semantic topics in this catalog.

Topics:
{{topics}}

Rules:
- Merge only topics about the same durable subject whose facts belong in one canonical content document.
- Different spelling, casing, language, PR number, release, review round, or transient status does not make a distinct topic.
- Do not merge merely related subjects when either would lose its independent meaning.
- Prefer a stable, general existing path as canonical; never invent a new path here.
- Omit uncertain groups.

Reply with strict JSON:
{ "groups": [{ "canonical": "<existing path>", "merge": ["<existing path>"] }] }

<!-- lang:zh -->
识别目录中语义重复的 topics。

Topics：
{{topics}}

规则：
- 只有主题是同一持久对象、全部事实适合放入同一份 canonical content 时才合并。
- 拼写、大小写、语言、PR 编号、release、review 轮次或短期状态不同，不构成独立 topic。
- 仅仅相关但仍有独立含义的主题不要合并。
- canonical 必须选已有且稳定、通用的路径；这里不得创建新路径。
- 不确定的组不要输出。

只回复严格 JSON：
{ "groups": [{ "canonical": "<已有路径>", "merge": ["<已有路径>"] }] }
