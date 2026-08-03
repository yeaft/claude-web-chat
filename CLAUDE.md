# Yeaft Web Code Agent

本文档是本仓库的开发约束和架构边界。面向用户的安装、功能和部署说明放在 `README.md`、`README.zh-CN.md` 与 `docs/`；这里不复制产品手册，只记录修改代码时必须知道且能从当前实现验证的事实。

## 产品模型与术语

Yeaft Web Code Agent（简称 **Yeaft**）通过同一套 Web UI 提供三条执行路径：

- `claude-code`：Claude Code CLI 的 1:1 Chat provider。
- `copilot`：GitHub Copilot CLI 的 1:1 Chat provider。
- Yeaft 原生引擎：自有 query loop、工具、记忆、VP、Session、Project 和 Work Center。

Yeaft 原生引擎只有 **Session** 这一种对话编排单元。一个 Session 有 1..N 个 VP（Virtual Person）；1 个 VP 是普通 1:1 对话，增加 VP 才产生并行协作，不存在新的 “chat mode” 或 “group mode”。Work Center 是 Agent 级长任务编排系统，稳定对象是 **WorkItem -> Action -> Run**；它不是另一种 Session。

### 现行术语与兼容边界

新名字只能使用 `yeaft`、`session`、`sessionId`、`project`、`workItem`、`action`。以下旧名仍出现在 wire、磁盘 schema 或既有 JS 调用链中，只为兼容，不能据此发明新 API：

| 旧名 | 现行语义 | 处理方式 |
| --- | --- | --- |
| `unify` / `unified` | Yeaft 引擎 | 仅保留现有 `unify_*` wire alias；新代码禁止使用 |
| `group` / `groupId` | Session / `sessionId` | 保留现有 wire alias、磁盘迁移和局部旧签名；新代码用 Session 术语 |
| `group/<id>` | 旧 memory scope | Reader / migration 兼容；稳态新写入使用 `sessions/<id>` scope |
| `claude_output` | Chat provider 事件协议名 | 不是 Claude vendor 专属；不要随 provider 重命名 |

不要做“清理旧术语”的半链路重命名。协议、前端、server、agent、测试、迁移和磁盘 schema 没有一起改变时，旧名必须原样保留并写明 legacy alias。

## 运行时拓扑

```text
Browser (Vue/Pinia)
  <-> WebSocket / HTTP
Server (Express + ws + SQLite)
  <-> owner-scoped WebSocket relay
Agent instance (local runtime + workbench + CLI providers + Yeaft engine)
  <-> provider API / local CLI / filesystem / shell
```

- `server/` 负责鉴权、用户/Agent 连接、Session catalog、Project 归属、附件和消息中继；它不是 Yeaft 推理执行器。
- `agent/` 运行在用户机器上，拥有工作目录、文件、终端、Git、CLI provider 和所有 agent-local Yeaft 数据。
- 一个用户可以连接多个 Agent instance。同名 `sessionId` 可能由不同 Agent 拥有，因此跨 Agent 的身份必须是 `(agentId, sessionId)`；前端查询 Session 用 `sessionById(sessionId, agentId)`，不能裸查 `sessions[sessionId]`。
- Server 端 Project 是用户级权威归属，成员记录包含 `agentId + sessionId`；同步到 Agent 后，Project 共享召回只覆盖该 Project 中**同一个 Agent**上的 sibling Sessions。

## 仓库结构

```text
agent/
  providers/        Claude Code / Copilot ChatProvider 驱动
  connection/       Agent WebSocket、消息路由、buffer、心跳与升级
  service/          多 Agent instance 的配置和系统服务管理
  workbench/        文件、终端、Git 等工作台后端
  yeaft/            Yeaft 原生引擎
server/
  handlers/         Web / Agent 消息处理与转发
  db/               SQLite 连接及 Project、Session、UI metadata 等存储
web/
  components/       Vue 组件（`.js` 字符串模板，不使用 SFC）
  stores/           Pinia stores：`auth.js`、`chat.js`、`sessions.js`、`vp.js`
  styles/           CSS 与 design tokens
  i18n/             `en.js`、`zh-CN.js`
  build.js          esbuild 生产打包
scripts/            测试预算、语法检查、release guard 等脚本
test/               Vitest 核心测试与 focused 测试源
e2e/                Playwright 配置、fixtures 和 E2E 测试
docs/               VitePress 用户文档
```

## Yeaft 原生引擎

### 主要入口

- `agent/yeaft/session.js`：`loadSession()`，组装 config、LLM router、tools、memory、Dream、task manager、VP loader、skills 和 MCP。
- `agent/yeaft/engine.js`：单个 VP / Action 的 query lifecycle；负责 provider stream、tool loop、retry、compact、folding、持久化和 terminal event。
- `agent/yeaft/web-bridge.js`：Web Session 运行时；把 Web 请求接到 coordinator / VP Engine，并把 engine events 投影为 `yeaft_output`。
- `agent/yeaft/cli.js`、`cli-session-runner.js`、`stdio-protocol.js`：本地 `yeaft` CLI；非交互自动化使用严格 JSONL `stream-json`，stdout 不能混入普通日志。
- `agent/yeaft/sessions/`：Session CRUD、manifest、roster、coordinator、pre-flow、Project doc 和 per-session config。
- `agent/yeaft/conversation/`：热历史、可见历史投影、搜索和分页。
- `agent/yeaft/work-center/`：WorkItem / Action durable model、scheduler、runner、workspace、attachments、projection 和 bridge。

### Query lifecycle 的硬边界

实现细节以 `engine.js` 为准，但以下语义必须保持：

1. Query 前组合 VP soul、project instruction、`CLAUDE.md` / `AGENTS.md`、runtime platform、memory recall、skills、pending async notification 和历史上下文。
2. Adapter stream 产出 text / thinking / tool calls / usage；普通工具结果回到同一 query loop，长工具弧经过 folding / reflection。
3. Provider 重试只在安全边界发生。已经出现部分输出的失败要按 continuation 语义续写，不能向用户重放可见文本；context overflow 先 compact，可恢复错误耗尽后才使用 fallback model。
4. Provider silence watchdog 只覆盖 provider 阶段；工具、AskUser 和异步任务有各自 timeout / ownership，不能把总耗时误当 provider 卡死。
5. `Engine.query()` 是 terminal boundary。正常结束、abort、handoff 和不可恢复异常最终都必须产生 `turn_end { terminal: true }`；内部 loop 的 `turn_end` 不能被 UI 当作 VP 结束。
6. Raw tool output / provider trace 可写持久化诊断；进入模型上下文和 UI 的只是有预算、可折叠、可投影的副本。不要把 UI 截断等同于磁盘只保存截断内容。

### LLM provider 层

Yeaft 原生模型配置位于当前 Agent instance 的 `<yeaftDir>/config.json`，由 `agent/yeaft/config.js`、`config-api.js` 和 `llm/` 读取。典型 provider：

```json
{
  "name": "gateway",
  "baseUrl": "https://example.test/v1",
  "apiKey": "...",
  "protocol": "openai-responses",
  "models": [
    "gpt-5",
    { "id": "claude-sonnet-4.5", "protocol": "anthropic" }
  ]
}
```

- 只支持 `anthropic` 与 `openai-responses`；Chat Completions 旧协议已经移除。
- `apiKey` 是静态凭证；`credentialProvider` 是请求时动态凭证，目前内置 GitHub Copilot。
- Protocol 解析顺序是 model override -> provider override -> model-id inference -> `openai-responses` 默认；同一 provider 可以按 model 使用两种协议。
- Provider model 对象可覆盖 `contextWindow`、`maxOutput`、`effortOptions`；这里的输出上限字段是 `maxOutput`，顶层 runtime config 的 `maxOutputTokens` 是另一字段。模型能力和 token limit 由显式配置、`models.dev` cache 与 `models.js` 共同解析，禁止在 UI 或 prompt 新写死窗口大小。
- Session override 只写 `<yeaftDir>/sessions/<sessionId>/config.json` 的允许字段（当前是 `model`、`modelEffort`），不能污染 Agent 默认模型。
- 只有新增 1:1 CLI 后端时才改 `agent/providers/` 的 `ChatProvider`；新增 Yeaft API provider 应改 `agent/yeaft/llm/`。

### Session、Project 与持久化所有权

`yeaftDir` 是 Agent instance 的数据根：

- default instance：`~/.yeaft`
- named instance：`~/.yeaft/instances/<instanceId>`
- `YEAFT_DIR` 或 service config 可以显式覆盖

关键稳态数据：

```text
<yeaftDir>/
  config.json
  sessions-manifest.json
  sessions/<sessionId>/
    session.json
    config.json
    conversation/index.json
    conversation/segments/*.jsonl
  memory/<scope>/memory.md
  memory/<scope>/summary.md
  tasks/
  work-center/work-center.db
  work-center/settings.json
  work-center/attachments/
  projects.json                 # Agent-local legacy/fallback Project cache
```

- `sessions-manifest.json` 是该 Agent instance 的 Session 发现索引。Session transcript 的权威热格式是 per-session JSONL segment + `index.json`；旧 `.md` message、`groups/` 和混合 `conversation/` 路径只做读取 / 迁移 fallback。
- `workDir` 是项目执行上下文，也是 project-tier skills / MCP / instructions 的根；它**不拥有** Session metadata、transcript、memory、task 或 Work Center 数据。
- `<workDir>/.yeaft/sessions` 与 `group-workdirs.json` 只用于旧数据 bootstrap / migration。新代码不能重新把它们变成稳态数据源。
- Web 创建/修改的 Project 归属由 Server SQLite 的 `yeaft_projects` / `yeaft_project_sessions` 维护；Agent 的 `projects.json` 是兼容 fallback，不得反向覆盖 server-authoritative membership。
- 当前 Session 的 Project instruction 由 server 同步；Project sibling memory 以只读摘要注入，保留来源 Session 身份，不共享可写 transcript。

### Project instructions、Skills 与 MCP

- 每个 Session 的 `workDir` 可提供 `CLAUDE.md` 或 `AGENTS.md`；`sessions/project-doc.js` 负责选择、大小限制和读取，`projectDocMaxBytes: 0` 可禁用。
- Project instruction 与项目文档不是同一层：前者是 Server Project metadata，后者是工作目录文件；二者都不能被历史对话覆盖。
- Skills 有 bundled、user 和 project tiers；项目层会读取兼容目录（`.claude/skills`、`.agents/skills`）及 Yeaft 原生 `.yeaft/skills`，以 `skills.js` 的真实 precedence 为准。
- MCP 合并 global / external user / project 配置。不要把 Session 数据放进 project MCP/skills 目录。

### Memory、Dream 与 compact

Memory 的 source of truth 是每个 scope 的 `memory.md` + `summary.md`；SQLite FTS 只是可重建索引。协作 Session 的当前写入使用 `user`、`sessions/<sessionId>`、`sessions/<sessionId>/user`、`sessions/<sessionId>/vp/<vpId>` 和 Dream 生成的 `sessions/<sessionId>/topic/...`。实现仍支持 1:1 Yeaft / CLI chat 的 `chat/<chatId>` 与 `chat/<chatId>/vp/<vpId>` 写入和召回，它们不是 legacy scope。单数 `session/...`、`group/...` 及顶层 `feature/...` 才属于旧数据读取 / 迁移兼容，不得作为新功能的 scope 设计。

- `memory/preflow.js` 从允许的 scopes 做 FTS recall；`ams.js` / `ams-registry.js` 管理当前 Session 的 Active Memory Set。
- Dream 在 `agent/yeaft/dream/` 中异步把对话 diff 合并到 scope，原子更新 `memory.md` / `summary.md`，再同步 FTS。旧 `group/...` scopes 仍可被 migration / reader 看见，不能无迁移直接删除。
- Compact 在 `agent/yeaft/compact/` 与 `history-compact.js` 中压缩模型历史；它解决 context window，不等于长期语义记忆。
- VP、Session、Project sibling、WorkItem context 的读取边界不同。新增 recall / history search 必须显式带 owner / Session / Project 范围，不能做跨 Agent 或全局 transcript 扫描。

### 工具、后台任务与子 Agent

- `agent/yeaft/tools/index.js#createFullRegistry()` 是内置工具入口；`ToolRegistry` 已移除旧 chat/work mode filtering。协作工具可按 single-VP / multi-VP policy 隐藏，但不要重新引入 mode 分叉。
- VP 不能靠在普通文本里写 `@vp` 触发另一个 VP；显式 VP -> VP handoff 必须调用 `route_forward`。用户输入的 mention 由 Session coordinator 解析。
- `Bash background=true` 进入 Session-scoped `TaskManager`。持久 shell task 默认是 `status_only`；只有 `model_reentry` 结果任务才自动回到模型。进程重启后无法确认仍可控的 task 标为 `orphaned`。
- `SpawnAgent` 创建有独立 output log、liveness、budget 和 terminal state 的子 Agent。Terminal notification 是 parent re-entry control context，不是用户原始消息，不能直接写成长记忆。
- 工具的 timeout 要按副作用语义处理：无法确认停止的外部写操作不能盲目重跑。
- `managed-cli.js` 可在用户目录安装 / 复用 `rg`、`fd`、`dust`，工具必须保留 Node fallback；禁止依赖 `sudo` 或系统包管理器才能工作。

### Work Center

Work Center 是 Agent instance 级持久任务系统，入口在 `agent/yeaft/work-center/`，前端在 `WorkCenterPage.js` / `WorkCenterActionDetail.js`，wire 经 server 的 `agent-work-center.js`、`client-work-center.js` 中继。

- 一个 WorkItem 保存 goal、acceptance criteria、workDir / canonical workspace key、workflow snapshot、conversation 和 attachments；完成 Action 的 terminal Run result / evidence 有数据库 immutability fence。Action 是可调度工作单元，Run 是一次执行尝试。
- Triage 生成任务特定的 Action graph；依赖表达真实结果消费，不是固定 phase 顺序。Scheduler 可并行无依赖 Action，但相同 workspace 的冲突写入必须串行。
- Planner 只能把保证不修改文件、Git 状态、服务或外部系统的 Action 标为 `read`；当前主要靠 triage 契约和 review 约束，Runner 不会按 `workspaceMode` 过滤写工具，因此 `read` 不是 sandbox 或 runtime enforcement boundary。`isolated-write` 使用隔离 Git worktree；出现 isolated writes 时必须有唯一 `integrate` Action 汇总，冲突时停止而不是猜。
- Action completion 不是“模型停止输出”。Runner 要求结构化 outcome、evidence 和逐条 acceptance checks；review / deliver 是最终闸门。
- WorkItem conversation 和 Action transcript 存在 `work-center.db`，不写入普通 Session transcript。创建时可保存一份有界 Session context，明确作为不可信背景而非当前事实。
- `reuseMemory` 控制三类候选来源：scope-bounded Agent memory、相同 canonical workspace 的已完成 WorkItems，以及 persisted workspace 解析到同一 canonical path 的普通 Session 可见 transcript 摘要。它们都是有界、不可信的参考上下文，不能跨 workspace 读取原始 transcript 或 tool output。注入行为取决于 execution schema：schema v1 会附加 Runner 计算的 memory / workspace-Session blocks；schema v2 只渲染 immutable Mainline 与 fixed suffix，当前不会附加这两个预计算 block。不要把开启该开关理解为每类来源都必然进入 prompt。

## Web、Server 与 wire

### 前端

- Vue 3 + Pinia；源码既有 Options API，也有 Composition API，但组件均是 `.js` + 字符串 `template`，不使用 `.vue` SFC。
- 开发时 `web/index.html` 加载本地 vendor 文件和 `app.js`；生产执行 `npm run build`，由 `web/build.js` / esbuild 生成 `web/dist`。没有 CDN 运行时依赖，也不能再声称“无构建步骤”。
- `chat.js` 管连接、conversation、Yeaft event projection、Workbench 和 Work Center UI 状态；`sessions.js` 管 Agent-scoped Session inventory；`vp.js` 管 VP library；`auth.js` 管身份。不要把新的 Session / VP ownership 继续塞回 `chat.js`。
- Claude/Copilot Chat 与 Yeaft Session 复用 `MessageList` / `AssistantTurn` / `ToolLine` 渲染，但 conversation identity 和历史协议仍然不同。
- 所有用户文案通过 `$t()`，同时更新 `web/i18n/en.js` 与 `web/i18n/zh-CN.js`。

### Server 与数据流

Server 有 Web client 与 Agent 两类 WebSocket。所有转发都必须检查 user ownership / Agent access，并保留 `agentId`、`sessionId`、request correlation 与可见性边界。

```text
Chat provider:
web send_message -> server -> agent ChatProvider -> claude_output -> server -> web

Yeaft Session:
web yeaft_session_send -> server -> agent message-router
  -> handleYeaftSessionSend -> coordinator / selected VPs -> Engine.query
  -> yeaft_output -> server -> web -> standard message projection

Work Center:
web work-center request -> server owner check -> agent WorkCenterService
  -> durable event/projection -> server -> requesting/broadcast web clients
```

- `yeaft_session_send` 的 wire payload 使用 `sessionId`。`sendYeaftSessionMessage({ groupId, ... })` 是现有 store 内部 legacy 签名；不要把 `groupId` 扩散到新 wire。
- `unify_*`、`yeaft_session_chat` 等旧 message types 仍可能 fan-in 到现行 handler，只能在完整兼容扫描后移除。
- History 首屏可直接从轻量 ConversationStore replay，不应被 MCP / skills / memory 全量启动阻塞。可见历史必须先投影掉 internal、reflection 和敏感 tool payload。
- Agent reconnect、Session snapshot 和历史 chunk 可能乱序；前端必须用 Agent-scoped identity、request id 和 conversation generation fencing，不能让 stale frame 覆盖当前 Session。

## 开发与验证

### 语言与运行环境

- Node.js `>=22.5.0`；CI 和发布 workflow 使用 Node 24。项目依赖稳定的 `node:sqlite`，不要用 Node 20 验证。
- Agent / Server 是 ES modules；前端源码是浏览器 ES modules；`web/build.js` 本身是 CommonJS build script。
- 不使用 TypeScript；新公共边界用 JSDoc 记录输入、输出和 ownership。
- Commit 使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`perf:`、`revert:`。
- 项目文档使用中文；面向用户的 README / i18n 按现有双语结构同步。

### 测试入口

不要用裸 `npx vitest run` 代替项目门禁：默认核心套件由 manifest 和预算控制。

```bash
npm test                                      # test budget + 核心 Vitest manifest
npm run test:focus -- path/to/file.test.js    # 运行尚未进入核心 manifest 的 focused test
npm run test:e2e                              # Playwright E2E
npm run check:server-agent-syntax             # Agent / Server node --check
npm run release:guard                         # 语法检查 + Server startup smoke
npm run build                                 # 生产前端 bundle
npm run docs:build                            # VitePress 文档
```

- `vitest.config.js` 只运行 `scripts/test-suite-manifest.mjs` 中的核心文件；`vitest.focus.config.js` 才允许任意 `test/**/*`。
- 核心测试预算当前是 `< 500` cases。新增回归进入默认套件前必须替换 / 合并现有 case，不能偷偷抬预算。
- 改代码至少跑 focused test + `npm test`；改 Agent / Server 再跑 syntax / release guard；改前端再跑 build；改真实浏览器路径时跑对应 E2E。
- 所有提交前执行 `git diff --check`。测试通过必须记录实际命令和结果，不能根据代码阅读声称“已验证”。

## 命名与兼容规则

### 禁止版本后缀文件名

新功能不能创建 `*-v2.js`、`*-new.js`、`*-old.js`、`*-tmp.js`、`*-copy.js`。新实现应替换旧实现，由 Git 保存历史。唯一例外是文件名本身描述一次性 schema migration（例如 `vX-to-vY`）。

### 新旧代码判断

- 新文件、新函数、新变量、新 wire type：只用现行术语。
- 既有 legacy identifier：默认不动；若要改，必须扫描并一次性更新 agent / server / web / tests / migration / persisted schema。
- 存储 reader 可以双读旧 schema；writer 应写现行 schema。不要为了“干净”删除 bootstrap、alias 或 migration。
- 新的持久字段必须明确 owner、root、原子性、升级路径和旧 reader 行为；没有 migration 设计就不要改磁盘 shape。

## UI 规则

整体风格是现代极简：内容优先、留白驱动、无装饰性噪音。先复用组件和 token，再新增样式。

### Design tokens

- 颜色、背景、边框、状态、阴影、圆角和常用间距优先引用 `web/styles/variables.css`；禁止在组件里随意新增 hex / rgb / rgba。
- 新 token 必须同时定义 light `:root` 与 `[data-theme="dark"]`。
- 常用 token 包括 `--bg-main`、`--bg-sidebar`、`--bg-input`、`--text-primary`、`--text-secondary`、`--text-muted`、`--border-color`、`--accent`、`--accent-blue`、`--error`、`--success`、`--sidebar-hover`、`--session-active`。

### 复用现有模式

- 按钮优先 `.btn-primary`、`.btn-secondary`、`.btn-ghost`。
- Modal 应复用对应的现有 overlay 和 card shell：legacy 通用路径是 `.modal-overlay` + `.modal`，Settings / Work Center 等使用各自已有的容器类。`.modal-card` 不是全局基础类；不要把它当统一容器，也不要为每个弹窗复制一套 overlay。
- 侧栏 tab 使用 `session-tab-bar` / `session-tab`。
- 输入、textarea、select 沿用全局 focus / border / radius，不写局部漂移版本。
- 配置类弹窗保持固定外壳，header / footer 不滚，中间 body 使用 `flex: 1; overflow-y: auto`；参考 Settings 和 Work Center Settings 的现有实现。
- 图标先用项目已有图标 / Symbols Nerd Font；图标含义不能只靠 hover tooltip 才能理解。

### UI 验证清单

- light / dark 都实测；至少检查 320px 极窄屏、常规桌面和长内容滚动。
- 检查键盘 focus、disabled、loading、error、empty、stale / reconnect 状态。
- 新文案双语齐全；无水平分割线和重复卡片外壳滥用。
- 对 diff 搜索新增硬编码颜色；确需视觉常量时先新增成双主题 token。
- 若第一次见到页面的用户不能在 30 秒内完成主任务，应先简化交互，不要用说明书补救。

## Worktree、Review 与发布

每个 feature / fix / docs 改动都走独立 worktree 和 PR，不能从开发 worktree 直接 push `main`。

1. `git fetch origin main --tags`，从最新 `origin/main` 创建语义化 worktree / branch。
2. 只修改任务范围；不要回退主 checkout 或其他人的未提交改动。
3. 执行匹配改动面的 focused tests、`npm test`、静态门禁和 `git diff --check`。
4. Conventional commit，push worktree branch，使用 `source ~/.zshrc` 后的 `gh` 凭证创建 PR。
5. Linus 完成实现后，把 PR number、精确 head SHA、验证结果和风险通过 `route_forward` 交给 Martin。
6. Martin 必须对**精确 head**和 GitHub merge snapshot 独立 review；检查 head / base / mergeability、完整 diff、相关回归与门禁，并 route 回明确的 APPROVE 或 blocker。Head 漂移后旧结论失效。
7. 有 blocker 就由 Linus 修复、push 新 SHA，再走复审。只有 Martin 明确“可以 merge”后才能合并。
8. 合并使用 head-match（API `sha` 或等价保护），禁止 `HEAD:main`、`branch:main` 或给 feature branch 打 tag。
9. 合并后重新 fetch 远端，以 `origin/main` 为权威创建下一个单一递增 `v1.0.X`；确认 PR merge commit、`origin/main`、本地 tag 和远端 tag 指向一致。
10. `v*` 触发 `.github/workflows/dev-release.yml`：test / release guard / build 后发布 npm Agent 和 `:dev` Docker image。`release-*` 是显式生产发布，构建 version / latest Docker image并创建 GitHub Release；除非用户明确要求，不打 production tag。
11. 发布闭环后删除 worktree；不要自己删除或覆盖他人的本地分支和文件。

CI 的 `pull_request` 自动触发当前是关闭的，不能把“GitHub 没有 checks”当作已验证。PR 作者账号无法正式 approve 自己的 PR 时，Martin 应把独立结论作为 PR comment 和 route handoff 留下审计记录。

## 运维与安全

- 未经用户明确授权，不重启、kill、升级或替换正在运行的 Agent / Server；代码修复与生产部署分开。
- 不运行 `npm install -g`、`npm pack` 或手工覆盖来升级在线 Agent；发布走 tag workflow。
- 不改 `~/.yeaft/config.json`、instance `yeaftDir`、Work Center DB、Session 数据或其他运行时文件，除非任务明确要求且有备份 / 验证方案。
- Debug trace、raw tool output、attachments、project docs 和 transcript 都可能包含敏感内容。新增展示、导出、搜索或跨 Session recall 时必须执行 user / Agent / Session / Project ownership 检查，并只投影必要字段。
- 不用 `git reset --hard`、`git clean -f` 回避脏工作区；不回退不是自己做的修改。
