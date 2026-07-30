# Work Center 会话式执行模型设计

> 状态：领域与交互方案已按 2026-07-30 最新决议重写，等待独立设计复审；尚未进入实现。
>
> 适用范围：Work Center、WorkItem、Conversation、ContentPane、Action、Run、用户干预、持久化、恢复和迁移。

## 1. 结论先行

Work Center 不是工作流引擎，也不需要独立 Action 详情页。目标产品由两层组成：

```text
Work Center → WorkItem
```

- **Work Center** 展示全部长期任务。
- **WorkItem** 是实际工作页面，固定为两栏：左侧 Conversation，右侧 ContentPane。
- **Conversation** 是唯一人机交互入口，包含 WorkItem 对话、Action 状态卡、问题、批准和唯一 composer。
- **ContentPane** 是通用只读查看区，默认显示 Action list，可在同一栏钻取 Action、Run、文件、diff、日志和附件。
- **Action** 是一个分配给某个 VP 的持久执行线程，可以接收后续消息、暂停和继续。
- **Run** 是 Action 的一次实际执行。每次启动产生一个新 Run；Run 结束后不可改写。
- composer 默认发送给 Coordinator；用户显式选择后，也可以把消息直接发送给某个 Action。
- Coordinator 也可以通过同一持久投递协议把消息发给 Executor Action。
- 发给 running Action 的消息进入 durable inbox，在安全边界加入下一次模型调用。
- 发给 idle、paused、waiting、failed、completed 或安全 stopped Action 的消息会原子触发新 Run。
- Pause、Start、Stop 是可审计控制命令，不伪造成用户消息。
- 没有 DAG、依赖图、stage、workflow template 或预建后继 Action。

一句话概括：

> 用户始终在 WorkItem Conversation 里说话，右侧只负责查看；Action 是可持续交流的执行线程，Run 才是一次可恢复、可审计的执行。

---

## 2. 冻结的设计决议

### 2.1 没有独立 Action 页面

目标信息架构不再包含：

```text
Work Center → WorkItem → Action page
```

Action 详情是 WorkItem 右侧 ContentPane 的一种内容。点击 Action list 或 Conversation 中的 Action 卡片，只改变右侧内容，不离开 WorkItem，不卸载 Conversation，也不移动 composer。

### 2.2 WorkItem 只有一个输入框

- composer 永远位于左侧 Conversation 底部。
- ContentPane 不创建第二个 textarea、第二套附件状态或第二条发送链路。
- 默认目标是 Coordinator。
- 只有用户显式选择“发送给此 Action”后，composer 才显示 Action target chip。
- 查看 Action、文件或日志不会自动改变发送目标。
- 问题回复、批准、拒绝、暂停后补充和主动消息都复用同一个 composer。

### 2.3 Action 是线程，Run 是执行

旧定义：

```text
Action = 一次 Engine.query()
```

目标定义：

```text
Action = owner VP + 冻结执行范围 + append-only message thread + 0..N Runs
Run    = Action 的一次实际 Engine activation
```

Action 可以多次运行；每次运行都有独立 `runId`、lease、checkpoint、输入高水位、结果和副作用记录。历史 Run 不会因后续消息或继续执行而改写。

### 2.4 消息可以直接投递 Action

用户和 Coordinator 都可以向开放的 Action 追加消息：

- running：排队到下一个安全边界；
- idle / paused / waiting / failed / completed：消息同时请求启动；
- stopped：只有没有 unresolved unknown effect 时才可启动；
- superseded / closed：拒绝投递；
- WorkItem done / cancelled：先重新打开 WorkItem，不能隐式恢复。

直接 Action 消息只补充当前执行线程，不能扩大工具权限、改变 workspace、owner、批准范围或 WorkItem 合同。需要改变这些权威内容时必须发给 Coordinator。

### 2.5 控制命令不是假消息

- `Pause` 写 `pause` control entry。
- `Start` 写 `start` control entry。
- `Stop` 写 `stop` control entry。
- 控制 entry 在 UI 中显示为状态事件。
- Engine 可以获得确定性的 continuation instruction，但持久层不能伪造“用户说了继续”。

### 2.6 明确禁止依赖图

目标模型不存在：

- Action DAG；
- `dependsOn`、`dependsOnActionIds`、`dependsOnStageIds`；
- stage、phase、workflow template；
- graph sink、final gate、graph editor；
- `nextAction`、`blockedOnAction`；
- 固定的开发、测试、Review、发布流程；
- 通过 Action list 顺序暗示执行依赖。

如果一项工作确实需要另一项工作的结果，Coordinator 等结果存在后再创建或通知相应 Action。数据库不保存调度边。

---

## 3. 产品目标与非目标

### 3.1 目标

1. 用户在一个页面内完成对话、查看执行、干预 Action 和阅读文件。
2. 用户能明确知道消息发给 Coordinator 还是某个 Action。
3. running Action 能在不破坏 provider/tool 协议的边界接收新消息。
4. 暂停、继续、停止和消息投递在重连或 Agent 重启后仍可解释。
5. 每次 Run 和每个外部副作用都有不可变来源。
6. 多个无依赖 Action 可以并行运行。
7. Coordinator 保持 WorkItem 合同和 shared knowledge 的权威。
8. Work Center 数据不污染项目目录。
9. Session 只能作为显式授权的资料来源。

### 3.2 非目标

1. 不实现通用工作流编排器。
2. 不提供 Action 图、阶段模板或 graph progress。
3. 不把 ContentPane 做成第二套 IDE 或聊天页面。
4. 不承诺 Pause 能回滚已经开始的副作用。
5. 不把 Stop 描述成可靠撤销。
6. 不让直接 Action 消息绕过权限、批准或 workspace 边界。
7. 不保证未知副作用可以自动重放。
8. 不通过相同 `workDir` 自动搜索全部 Session。
9. 不把绝对路径当作长期 workspace 身份。

---

## 4. 领域对象

### 4.1 Work Center

Agent 级长期任务容器，负责：

- 列出和筛选 WorkItem；
- 展示 Active、Needs attention、Closed；
- 创建 WorkItem；
- 选择 Agent；
- 打开设置；
- 展示 Agent 和 watcher 状态。

Work Center 不持有全局 current Action，也不展示 Action 图。

### 4.2 WorkItem

一个持久任务，包含：

- 目标和验收条件；
- workspace 绑定；
- canonical Conversation；
- Coordinator mailbox 和 turns；
- 扁平 Action 集合；
- HumanRequest；
- Operation；
- 附件和证据；
- shared memory 和 VP private memory；
- Session source grants；
- 最终结论。

### 4.3 Conversation

Conversation 是 WorkItem 的 append-only 可见时间线。它混排：

- 用户 → Coordinator 消息；
- 用户 → Action 消息，带明确目标标签；
- Coordinator 回复；
- Coordinator → Action 的可见交接；
- Executor 面向用户或 Coordinator 的消息；
- Action / Run 状态卡；
- HumanRequest；
- 批准和拒绝；
- workspace、恢复和副作用警告；
- 最终结论。

工具明细和大日志不铺在 Conversation 中，只显示摘要和可打开的 ContentRef。

### 4.4 ContentPane

WorkItem 右侧的通用查看区。它有自己的本地查看栈，但不拥有独立对话状态。

支持内容类型：

- `action-list`；
- `action`；
- `run`；
- `workspace-file`；
- `artifact-file`；
- `diff`；
- `tool-log`；
- `attachment`；
- `human-request`；
- `work-item-overview`。

### 4.5 Action

Action 是一个持久执行线程：

- 一个 owner VP；
- 一个冻结 objective；
- 一个冻结 permission envelope；
- 一个冻结 workspace identity；
- 一条 append-only Action thread；
- 一个严格有序的 inbox/control stream；
- 零到多个 Run；
- 零到多个 HumanRequest 和 Operation。

Action 的 objective 和权限不能通过定向消息修改。重大范围变化由 Coordinator supersede 旧 Action 并创建新 Action。

### 4.6 Run

Run 是一次实际执行 activation：

- 一个 `runId`；
- 一个单调 `ordinal`；
- 一个 lease epoch；
- 一个起始 checkpoint；
- 一组已消费的 Action entry；
- 一段 append-only engine/tool transcript；
- 一个终态结果；
- 一组 Operation 和 evidence。

Run 在运行期间只能追加记录；进入终态后不可修改。

### 4.7 ActionEntry

Action 的所有外部输入和控制命令共用一个单调序列：

```text
message → pause → message → start → stop
   41       42       43       44      45
```

严格顺序用于解决消息、暂停和继续之间的竞态。

### 4.8 CoordinatorTurn

Coordinator 对 WorkItem mailbox 中的一批事件进行一次串行决策。Coordinator 可以：

- 回复 WorkItem；
- 更新 WorkItem 合同；
- 创建、关闭或 supersede Action；
- 给 Action 发消息；
- 打开 HumanRequest；
- 接受 shared knowledge；
- 完成 WorkItem。

### 4.9 HumanRequest

需要用户明确介入的对象：

- `question`；
- `approval`；
- `confirmation`。

它可以属于 Coordinator 或某个 Action，并有独立 `requestId`、revision 和状态。

### 4.10 Operation

可能产生副作用的工具操作记录。它描述操作目标、幂等键、重放策略、实际状态和恢复探针。

---

## 5. 对象关系：扁平 Action，不是图

```text
Work Center
└── WorkItem
    ├── ConversationEntry[]
    ├── CoordinatorTurn[]
    ├── Action[]
    │   ├── ActionEntry[]
    │   ├── Run[]
    │   ├── HumanRequest[]
    │   └── Operation[]
    ├── WorkItem HumanRequest[]
    ├── memory/shared
    └── memory/vp/<vpId>
```

Action 之间可以有只读来源引用，例如：

- `sourceActionIds`；
- `supersedesActionId`；
- `relatedActionIds`。

这些字段只用于审计、跳转和说明上下文，不控制调度、ready 状态或完成度。

---

## 6. 信息架构与导航

### 6.1 顶层路径

```text
Work Center → WorkItem
```

WorkItem 内的右侧内容使用 ContentRef：

```text
WorkItem
  content: action-list
       → action:act_123
       → run:run_456
       → artifact-file:file_789
       ← back
       ← back
```

### 6.2 ContentPane 查看栈

- 打开 Action：`action-list → action`。
- 从 Action 打开 Run：`action → run`。
- 从 Run 打开文件：`run → artifact-file`。
- pane header 的返回按钮只回退一层，不离开 WorkItem。
- “全部 Actions”直接重置到 `action-list`。
- Conversation 滚动位置和 composer 草稿不受 pane 导航影响。
- 浏览器刷新可从 URL 恢复当前 ContentRef。
- 浏览器后退优先回退 ContentPane 栈，再离开 WorkItem。
- ContentRef 必须验证所属 Agent、WorkItem、workspace 和权限。

### 6.3 查看不改变发送目标

以下动作只改变 ContentPane：

- 点击 Action 卡；
- 点击 Action list；
- 打开 Run；
- 打开文件、diff、日志或附件。

只有以下显式动作改变 composer target：

- `发送消息给此 Action`；
- `回复此问题`；
- `批准` / `拒绝`；
- `停止并补充要求`；
- composer 自己的 target selector。

---

## 7. 页面布局

### 7.1 Work Center

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Work Center   [● Local Agent ▾]                         [设置] [刷新] [+ 新建] │
│                                                                              │
│ [搜索 WorkItem……………………] [全部 VP ▾] [全部状态 ▾] [最近 7 天 ▾]  ● Watcher │
├───────────────────────┬───────────────────────┬──────────────────────────────┤
│ Active             5  │ Needs attention    2  │ Closed                    18 │
│                       │                       │                              │
│ ┌───────────────────┐ │ ┌───────────────────┐ │ ┌────────────────────────┐ │
│ │ ● 2 running       │ │ │ ● Approval        │ │ │ ✓ Done                 │ │
│ │ 修复支付回调      │ │ │ 升级数据库        │ │ │ 重构 Session 导航      │ │
│ │ 防止重复入账……    │ │ │ 需要生产备份批准  │ │ │ 已通过验收             │ │
│ │ Linus, Tester     │ │ │ [需要你处理]      │ │ │ 8 Actions · 2 files    │ │
│ │ 6 Actions         │ │ │ Martin · 1 request│ │ │ 昨天                   │ │
│ └───────────────────┘ │ └───────────────────┘ │ └────────────────────────┘ │
└───────────────────────┴───────────────────────┴──────────────────────────────┘
```

卡片不显示节点、依赖、stage 或 workflow progress。

移动端：

- Active / Needs attention / Closed 变成三个文字 tab；
- 一次显示一个 lane；
- 搜索独立一行；
- 筛选进入 sheet；
- 不做横向拖动 Kanban。

### 7.2 WorkItem 桌面双栏

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Work items / 修复支付回调                          ● Active    [···] [停止任务]│
│ /projects/payments · 更新于 14:32                                             │
├───────────────────────────────────────┬──────────────────────────────────────┤
│ Conversation                          │ Content                              │
│                                       │ Actions                         [概览]│
│ [目标与验收 ▾]                        │                                      │
│                                       │ 需要你处理  1                        │
│ You → Coordinator                     │ ┌──────────────────────────────────┐ │
│ 修复支付回调偶发重复入账               │ │ Martin · Waiting                 │ │
│                                       │ │ 确认 API 兼容策略                │ │
│ Yeaft · Coordinator                   │ └──────────────────────────────────┘ │
│ 我让 Linus 排查，让 Tester 检查回归。 │                                      │
│                                       │ Running  2                           │
│ ┌ Action ───────────────────────────┐ │ ┌──────────────────────────────────┐ │
│ │ ● Linus · Running                │ │ │ ● Linus · 排查重复入账          │ │
│ │ 排查幂等逻辑                     │ │ │ 3m · 1 queued message           │ │
│ │ 新消息会在下一安全边界送达       │ │ └──────────────────────────────────┘ │
│ │ [查看] [发消息]                  │ │ ┌──────────────────────────────────┐ │
│ └───────────────────────────────────┘ │ │ ● Tester · 检查回归             │ │
│                                       │ └──────────────────────────────────┘ │
│ You → Action: Linus                   │                                      │
│ 先检查 webhook 重放，不要改 API。     │ Paused / Recent                      │
│                                       │ [其他 Action……]                      │
│ Linus · delivered                     │                                      │
│ 已排队，将在当前工具调用结束后处理。   │                                      │
│                                       │                                      │
├───────────────────────────────────────┤                                      │
│ To: [Coordinator ▾]                   │                                      │
│ [附件] 输入消息…………………… [发送] │                                      │
└───────────────────────────────────────┴──────────────────────────────────────┘
```

### 7.3 Action detail 在右侧钻取

```text
┌──────────────────────────────────────┬───────────────────────────────────────┐
│ Conversation                         │ < Actions                             │
│                                      │                                       │
│ 保持原滚动位置和 composer            │ ● Running  排查幂等逻辑               │
│                                      │ Linus · Run 3 · 3m                    │
│                                      │                                       │
│                                      │ [Pause] [Stop] [发送消息给此 Action]  │
│                                      │                                       │
│                                      │ Objective                             │
│                                      │ 找到重复入账根因并给出证据            │
│                                      │                                       │
│                                      │ Pending inbox                         │
│                                      │ 1 条消息，等待安全边界                │
│                                      │                                       │
│                                      │ Latest output                         │
│                                      │ 正在检查 webhook 重放路径……           │
│                                      │                                       │
│                                      │ Runs                                  │
│                                      │ Run 3 · Running                       │
│                                      │ Run 2 · Completed · [查看]            │
│                                      │                                       │
│                                      │ Evidence                              │
│                                      │ [src/webhook.js] [diff] [test log]    │
└──────────────────────────────────────┴───────────────────────────────────────┘
```

Action detail 是只读投影；`Pause/Start/Stop` 是显式控制命令，`发送消息给此 Action` 只设置左侧 composer target。

### 7.4 文件查看

```text
┌──────────────────────────────────────┬───────────────────────────────────────┐
│ Conversation                         │ < Action: 排查幂等逻辑                 │
│                                      │ src/webhook.js         [LIVE] [复制路径]│
│                                      │                                       │
│                                      │  38  export async function handle...  │
│                                      │  39    const key = event.id           │
│                                      │  40    ...                            │
│                                      │                                       │
│                                      │ Opened from Run 3 evidence             │
└──────────────────────────────────────┴───────────────────────────────────────┘
```

文件必须明确标识：

- `LIVE`：当前 workspace 文件，内容可能继续变化；
- `SNAPSHOT`：某个 Run 固化的 artifact，带 hash；
- `DIFF`：明确 base/head 或 before/after；
- `LOG`：明确 run/tool/operation 来源。

不能用当前文件冒充历史 Run 的证据。

### 7.5 中等宽度和移动端

当宽度不足以同时保证 Conversation 和代码内容可读时，切换为两个顶层 tab：

```text
[Conversation] [Content · Action]
```

- 默认打开 Conversation；
- 点击 Action 卡或文件自动打开 Content；
- Content 的内部 back stack 保留；
- 切回 Conversation 后 composer 恢复原 target 和草稿；
- composer 只在 Conversation 显示；
- pending HumanRequest 仍在 Conversation 可见；
- 键盘弹出不能遮挡最后一条消息；
- 大型代码和日志只在 Content 内滚动，不造成整页横向溢出。

---

## 8. Conversation 与唯一 composer

### 8.1 默认目标

默认始终是：

```text
To: Coordinator
```

普通消息进入 WorkItem Conversation 和 Coordinator mailbox。

### 8.2 Action target

用户显式选择后：

```text
To: Action · Linus · 排查幂等逻辑   [×]
```

消息直接进入该 Action 的 ordered inbox。它不会同时触发一个竞争的 CoordinatorTurn。Coordinator 可以在 Conversation 中看到该消息和状态事件，但不会自动重复处理。

### 8.3 Request target

```text
Reply to: Martin · 确认 API 兼容策略   [×]
```

reply 必须同时绑定 `requestId + actionId/coordinatorTurnId + revision`。成功提交时原子消费 request。

### 8.4 Approval target

```text
Approve: push branch `fix/payment-idempotency`   [×]
```

按钮文案为 `批准` / `拒绝`，不是普通 `发送`。自然语言中的“可以”不会自动成为 approval。

### 8.5 草稿和过期目标

- 每个 WorkItem 保存自己的 draft。
- target 是 draft 的一部分。
- target 失效时不丢正文和附件。
- stale target 不会自动降级成 Coordinator 消息。
- UI 提供“改发 Coordinator”或重新选择 Action。
- WorkItem done/cancelled 时发送端拒绝，并提示先重新打开。

### 8.6 可见投递状态

定向 Action 消息显示：

- `queued`：已持久化，等待 Action 消费；
- `scheduled`：消息已触发新 Run；
- `delivered`：已加入某次 model turn；
- `blocked`：被 workspace、approval 或 unknown effect 阻止；
- `rejected`：Action 已 superseded/closed 或 WorkItem 已关闭。

UI 不把“WebSocket 已发送”误写成“Executor 已读”。

---

## 9. Action 权威与消息边界

### 9.1 冻结内容

Action 创建时冻结：

- owner VP；
- objective；
- expected result；
- permission envelope；
- workspace identity；
- source refs；
- tool policy；
- model policy snapshot。

### 9.2 可追加内容

- 用户消息；
- Coordinator 消息；
- Executor 回复；
- start/pause/stop controls；
- Run records；
- HumanRequest；
- Operation；
- evidence。

### 9.3 直接消息不能做什么

直接 Action 消息不能：

- 扩大文件或 shell root；
- 切换 workspace；
- 更换 owner；
- 修改 WorkItem 目标或验收条件；
- 给予新的高风险批准；
- 把 Executor 结论提升为 shared knowledge；
- 创建权威后继流程。

如果消息语义超出 Action objective，Executor 应向 Coordinator 报告；权限层仍按冻结 envelope 拒绝越界工具调用。

### 9.4 Coordinator 向 Executor 发消息

Coordinator 决策可以原子提交：

```js
postActionMessages: [{
  actionId,
  text,
  attachments: [],
  sourceRefs: [],
  wakePolicy: 'start_if_idle',
}]
```

它与用户定向消息走同一 ActionEntry、排序、启动门禁和安全边界，不存在特殊旁路。

---

## 10. Action 与 Run 状态

### 10.1 Action admission status

```text
open → superseded
open → closed
```

- `open`：可接收消息和控制命令。
- `superseded`：目标已被其他 Action 取代，永久拒绝新输入。
- `closed`：Coordinator 明确关闭，永久拒绝新输入。

WorkItem `done/cancelled` 是额外 admission gate；它不会篡改历史 Action，但阻止新投递和 Run。

### 10.2 Runtime display status

Action 的显示状态来自 active Run、最新终态和 pending commands：

```text
idle
queued
running
pausing
paused
waiting
completed
failed
stopping
stopped
blocked
```

`completed/failed/paused/stopped` 描述最近一次 Run 或当前执行状态，不是 Action 的永久终态。只要 Action 仍 `open` 且启动门禁通过，就可产生新 Run。

### 10.3 Run lifecycle

```text
queued → running → completed
                 → waiting
                 → paused
                 → failed
                 → interrupted
                 → stopped
                 → cancelled
```

Run 一旦进入终态不可修改。继续执行创建新 `runId`，而不是把旧 Run 改回 running。

### 10.4 Start gate

创建新 Run 前必须同时满足：

- WorkItem 是 active / needs_attention 且允许执行；
- Action admission 是 open；
- 没有 active Run；
- workspace identity 验证通过；
- tool/model policy 仍有效；
- required approval 存在且未过期；
- 没有 unresolved `effect=unknown`；
- owner VP 可用；
- Action lease 可原子获取；
- 资源锁允许执行。

失败时消息仍保留，但状态是 `blocked`，并显示具体原因。

---

## 11. ActionEntry 有序流

### 11.1 数据形态

```js
{
  id,
  workItemId,
  actionId,
  sequence,
  kind: 'message' | 'control',
  source: {
    type: 'user' | 'coordinator' | 'system',
    id,
  },
  message: null | {
    text,
    attachments: [],
    messageId,
    wakePolicy: 'start_if_idle' | 'do_not_start',
  },
  control: null | {
    command: 'start' | 'pause' | 'stop',
    reason,
  },
  expectedActionRevision,
  status: 'pending' | 'scheduled' | 'consumed' | 'blocked' | 'rejected',
  consumedByRunId: null,
  consumedByTurnId: null,
  createdAt,
}
```

`sequence` 在同一个 Action 内由数据库事务分配，严格单调。

### 11.2 顺序语义

所有命令按 sequence 处理：

- message 后 pause：消息保留，但 pause 生效前不得开始新的 model turn；
- pause 后 message：message 的默认 wake 语义请求继续；
- stop 后 message：先完成 stop fence，再根据副作用状态决定是否允许新 Run；
- message 后 stop：消息保留，但 stop 优先结束 active Run，之后不会自动执行，除非有更晚的 start/message；
- 多个 message：按 sequence 一次性或分批加入后续 turn，不按文本去重；
- 重复 client request：依靠幂等键只写一次。

### 11.3 高水位

每个 Run/turn 持久化：

- `claimedThroughSequence`；
- `consumedThroughSequence`；
- 实际 message entry IDs；
- 实际 control entry IDs。

重启后不能仅靠内存判断哪些消息已进入模型。

---

## 12. 安全边界与消息注入

### 12.1 安全边界定义

普通 message 和 Pause 只能在以下持久边界生效：

1. provider response 已完整持久化；
2. 该 response 发出的当前 tool-call batch 已全部得到 terminal tool result；
3. 对应 Operation 状态已持久化；
4. engine transcript 可以构造合法的下一次 provider request；
5. 尚未发出下一次 provider request。

这不是 Engine 内存中的临时 `if`，而是 Run journal 中可恢复的 checkpoint。

### 12.2 消息到达 running Action

- 当前 provider request 不取消；
- 已开始的 tool-call batch 不插入新消息；
- UI 显示“等待安全边界”；
- 到达边界后原子 claim inbox entries；
- 新消息作为下一次 model input 的独立、有来源内容块；
- 持久化 `consumedByRunId/turnId` 后才调用 provider；
- provider 调用失败时恢复规则能知道消息已被哪次请求消费。

### 12.3 多工具调用

如果一个 assistant response 已经产生多个 tool call：

- batch 开始前可以先检查 pause/message；
- batch 一旦开始，普通 Pause 不拆开 batch；
- 所有 started call 必须有 terminal tool result；
- 未开始的 call 只有在协议允许写明确 cancelled tool result 时才可取消；
- 第一版采用更保守规则：一个 response 的 tool-call batch 完整结束后再注入消息。

### 12.4 后台任务

后台 shell/tool 返回 durable task envelope 后即形成 tool result，但后台副作用仍由 Operation/Task 记录跟踪。Pause 不会自动杀死已启动的后台进程；UI 必须显示仍在运行的外部任务，并提供单独取消能力。

---

## 13. Pause、Start 与 Stop

### 13.1 Pause

Pause 是 cooperative safe-boundary pause：

1. 写 `pause` ActionEntry；
2. active Run 显示 `pausing`；
3. 不启动新的 provider request 或 tool batch；
4. 等当前不可拆分工作完成；
5. 持久化 checkpoint、Operation 状态和未消费 inbox；
6. 当前 Run 终态为 `paused`；
7. Action 显示 `paused`。

Pause 不承诺：

- 回滚文件；
- 撤销 push/部署/数据库写；
- 立刻停止同步 shell；
- 杀死后台任务；
- 把 unknown effect 变成未执行。

### 13.2 Start

Start 按钮写 `start` control entry：

- idle/paused/waiting/failed/completed/safe-stopped：通过 start gate 后创建新 Run；
- queued/running：幂等 no-op；
- pausing：按 sequence 记录，pause checkpoint 完成后再创建新 Run；
- superseded/closed：拒绝；
- unresolved unknown effect：blocked。

如果没有新的 message，Engine 得到确定性 continuation instruction：

> Continue this Action from its persisted thread and latest safe checkpoint. Re-evaluate pending work and do not assume unknown side effects succeeded.

它是 system control context，不伪装成用户历史消息。

### 13.3 定向消息等价于 wake

发送给 open Action 的普通 message 默认带：

```text
wakePolicy = start_if_idle
```

因此：

- running：加入下一安全边界，不新建并发 Run；
- 非 running：通过门禁后创建新 Run；
- blocked：消息保留，不执行；
- rejected：明确返回原因。

如果某些系统消息只想补档而不启动，Coordinator 可用 `do_not_start`；用户 UI 默认不暴露这个复杂选项。

### 13.4 Stop

Stop 是 best-effort hard stop：

1. 写 `stop` entry；
2. 推进 lease epoch，使迟到结果失效；
3. 中止尚可取消的 provider request；
4. 请求取消可控工具或任务；
5. 已执行或无法确认的副作用写 `known/unknown`；
6. active Run 终态为 `stopped/interrupted`；
7. unknown effect 存在时 Action 显示 blocked。

Stop 不是撤销。用户如果只是想补充方向，应发消息或 Pause，不应默认 Stop。

---

## 14. HumanRequest

```js
{
  id,
  workItemId,
  actionId: null,
  coordinatorTurnId: null,
  kind: 'question' | 'approval' | 'confirmation',
  prompt,
  details,
  operationId: null,
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'expired' | 'cancelled',
  revision,
  openedAt,
  resolvedAt: null,
  resolutionMessageId: null,
}
```

### 14.1 Action 问题

回答 Action question 时：

- composer target 绑定 `requestId + actionId`；
- 一个事务消费 request、写 Conversation message 和 Action message entry；
- message 默认触发 Action；
- 旧 Run 保持 waiting 终态；
- 新 Run 从历史和回答继续。

### 14.2 Coordinator 问题

回答 Coordinator question 时进入 Coordinator mailbox，不投递 Action。

### 14.3 Approval

Approval 必须描述：

- 操作；
- 目标；
- 风险；
- 是否可逆；
- 有效范围；
- 有效期；
- 请求它的 Action 和 Operation。

批准不能跨 Action、Run、Operation 或目标复用。

---

## 15. Coordinator 模型

### 15.1 Mailbox

每个 WorkItem 有一个 durable Coordinator mailbox，来源包括：

- 用户 → Coordinator 消息；
- Action Run 终态；
- Executor 升级的问题或发现；
- HumanRequest 结果；
- workspace 状态变化；
- 恢复事件。

用户 → Action 的消息不自动成为一个竞争的 Coordinator input，但 Conversation 和 Action 状态对 Coordinator 可见。

### 15.2 冻结快照

每次 CoordinatorTurn 启动时冻结：

```js
{
  workItemRevision,
  conversationRevision,
  actionSetRevision,
  actionEntryRevision,
  runRevision,
  requestRevision,
  memoryRevision,
  inputEventIds: [],
}
```

模型返回后，事务提交前重新比较。任何相关 revision 变化，旧决定都不能提交。

### 15.3 可提交命令

```js
{
  reply,
  contractPatch: null | {
    title,
    goal,
    acceptanceCriteria,
  },
  createActions: [{
    ownerVpId,
    objective,
    expectedResult,
    permissions,
    sourceRefs: [],
  }],
  postActionMessages: [{
    actionId,
    text,
    attachments: [],
    sourceRefs: [],
    wakePolicy: 'start_if_idle',
  }],
  controlActions: [{
    actionId,
    command: 'start' | 'pause' | 'stop' | 'close' | 'supersede',
    reason,
  }],
  openRequests: [],
  acceptedSharedKnowledge: [],
  complete: null | {
    summary,
    acceptanceResults: [],
    evidenceRefs: [],
    residualRisks: [],
  },
}
```

没有 dependency、stage、graph、next action pointer 或 workflow template。

### 15.4 权威边界

Executor 可以返回结果、证据、风险、问题和建议，但不能直接：

- 修改 WorkItem 合同；
- 写 shared knowledge；
- 宣布 WorkItem done；
- 扩大权限；
- 创建权威后继 Action。

---

## 16. 建议数据模型

实现使用 SQLite 规范化表和 append-only 日志，不持续覆写大 JSON 数组。

### 16.1 WorkspaceBinding

```js
{
  id: workspaceId,
  workDir,
  resolvedWorkDir,
  folderIdentity,
  repositoryIdentity: null | {
    gitDirIdentity,
    initialRemoteFingerprint,
  },
  status: 'active' | 'missing' | 'mismatch' | 'rebind_required',
  createdAt,
  verifiedAt,
}
```

### 16.2 WorkItem

```js
{
  id,
  workspaceId,
  revision,
  conversationRevision,
  actionSetRevision,
  actionEntryRevision,
  runRevision,
  requestRevision,
  title,
  goal,
  acceptanceCriteria: [],
  status: 'draft' | 'active' | 'needs_attention' | 'done' | 'cancelled',
  reuseMemory,
  origin,
  finalResult: null,
  createdAt,
  updatedAt,
  closedAt: null,
}
```

没有单一 `currentActionId/currentRunId`。

### 16.3 ConversationEntry

```js
{
  id,
  workItemId,
  sequence,
  kind: 'message' | 'action_state' | 'request' | 'approval' | 'warning' | 'result',
  actor,
  target,
  body,
  contentRefs: [],
  sourceRefs: [],
  createdAt,
}
```

### 16.4 WorkItemMessage

```js
{
  id,
  clientMessageId,
  workItemId,
  author: 'user' | 'coordinator' | 'executor',
  target: {
    type: 'coordinator' | 'action' | 'request',
    actionId: null,
    requestId: null,
  },
  kind: 'context' | 'reply' | 'decision',
  text,
  attachments: [],
  expected,
  applicationStatus: 'pending' | 'applied' | 'blocked' | 'stale' | 'rejected',
  createdAt,
}
```

### 16.5 Action

```js
{
  id,
  workItemId,
  ownerVpId,
  admissionStatus: 'open' | 'superseded' | 'closed',
  revision,
  objective,
  expectedResult,
  permissions,
  workspaceId,
  sourceRefs: [],
  latestRunId: null,
  nextEntrySequence,
  consumedThroughSequence,
  supersedesActionId: null,
  createdByCoordinatorTurnId,
  createdAt,
  closedAt: null,
}
```

### 16.6 ActionEntry

单独 append-only 表，以 `(actionId, sequence)` 唯一排序。message 和 control 共享序列。

### 16.7 Run

```js
{
  id,
  actionId,
  ordinal,
  leaseOwner,
  leaseEpoch,
  status,
  startReason: 'created' | 'message' | 'start' | 'recovery',
  checkpointRef: null,
  claimedThroughSequence,
  consumedThroughSequence,
  engineTurnCount,
  sideEffectState: 'none' | 'known' | 'unknown',
  resultRef: null,
  createdAt,
  startedAt: null,
  endedAt: null,
}
```

### 16.8 RunResult

```js
{
  id,
  actionId,
  runId,
  outcome: 'completed' | 'waiting' | 'paused' | 'failed' | 'interrupted' | 'stopped',
  response,
  summary,
  evidenceRefs: [],
  findings: [],
  suggestedNextSteps: [],
  checkpointRef: null,
  sideEffectState: 'none' | 'known' | 'unknown',
  createdAt,
}
```

### 16.9 ContentRef

```js
{
  kind: 'action' | 'run' | 'workspace-file' | 'artifact-file' | 'diff' | 'tool-log' | 'attachment',
  workItemId,
  actionId: null,
  runId: null,
  resourceId,
  path: null,
  revision: null,
  hash: null,
}
```

### 16.10 Event

创建、投递、claim、Run 开始、安全边界、控制、工具副作用、终态、批准、supersede、恢复和完成都写 append-only Event。

---

## 17. 关键事务与并发 fence

### 17.1 发给 Coordinator

一个事务：

1. 校验 `clientMessageId`；
2. 验证 WorkItem 可写；
3. 写 WorkItemMessage；
4. 写 ConversationEntry；
5. 推进 revisions；
6. 写 Event；
7. 写 Coordinator mailbox。

提交后才触发模型。

### 17.2 发给 Action

一个事务：

1. 校验 `clientMessageId`；
2. 验证 WorkItem 状态；
3. 验证 Action admission 和 expected revision；
4. 写 WorkItemMessage；
5. 分配 Action sequence；
6. 写 message ActionEntry；
7. 写 ConversationEntry；
8. 若无 active Run，原子设置 wake/schedule intent；
9. 推进 revisions；
10. 写 Event。

事务外不能先显示“已开始”。Runner/scheduler 成功 claim 后才显示 scheduled/running。

### 17.3 Start/Pause/Stop

一个事务：

1. 验证 WorkItem、Action 和 expected revision；
2. 分配 Action sequence；
3. 写 control ActionEntry；
4. 推进 lease/control fence；
5. 更新 runtime projection；
6. 写 Conversation 状态事件；
7. 写 Event。

### 17.4 Run claim

原子验证：

- Action open；
- WorkItem 可执行；
- 无 active Run；
- start gate 通过；
- wake/start entry 仍未消费；
- owner/lease/resource 可获取。

随后创建新 Run 并记录其 entry high watermark。

### 17.5 Safe-boundary delivery

一个事务：

1. 校验 `actionId + runId + leaseEpoch`；
2. 锁定未消费 entries；
3. 按 sequence 归约 message/control；
4. 处理 pause/stop/start 的顺序结果；
5. 将可投递消息绑定到下一个 engine turn；
6. 写 checkpoint 和 consumed high watermark；
7. 更新 entry 状态；
8. 写 Event。

提交成功后才构造 provider request。

### 17.6 Run 终态

一个事务：

1. 校验完整 run identity 和 lease；
2. 关闭 lease；
3. 写 RunResult；
4. 写 evidence 和 Operation 终态；
5. 更新 Run 和 Action projection；
6. 写 Conversation Action card；
7. 写 Event；
8. 投递 Coordinator mailbox 终态事件。

Run 结果不能直接把 WorkItem 改为 done。

### 17.7 Completion 竞态

完成事务必须 fence：

- WorkItem revision；
- Conversation revision；
- Action set revision；
- Action entry revision；
- Run revision；
- Request revision；
- Operation revision。

如果 Action message 先提交，complete 因 revision 变化失败；如果 complete 先提交，后续 message 以 `work_item_closed` 拒绝并保留客户端 draft。不能出现消息已经接受但 WorkItem 同时 done。

---

## 18. Engine 集成

### 18.1 Action thread 构造

每次新 Run 或下一 engine turn 的上下文包括：

- 冻结 Action objective 和 permissions；
- WorkItem 当前权威合同摘要；
- Action thread 历史；
- 最近安全 checkpoint；
- 本次 claim 的 message entries；
- 已确认 Operation 状态；
- unknown effect 警告；
- 当前 Run identity。

### 18.2 消息角色

- 用户定向消息保留 `author=user` 和 Action target；
- Coordinator 定向消息保留 `author=coordinator`；
- Start continuation 是 system control context；
- 恢复探针是 system recovery context；
- 不能把 coordinator/system 文本伪装成用户输入。

### 18.3 Executor 输出

Executor 可以发出：

- 面向用户的可见消息；
- 面向 Coordinator 的发现或升级；
- progress summary；
- HumanRequest proposal；
- final RunResult；
- content/evidence refs。

过程性 tool output 只进入 Run detail，不污染 WorkItem Conversation。

### 18.4 Context budget

Action thread 可以跨多个 Run 增长，因此：

- 原始 entries 和 Run transcript 永久可回查；
- prompt 使用可重建 summary/compact；
- 最新用户/Coordinator消息不能被 summary 覆盖；
- Action objective、permissions、pending request 和 unknown effects 永远驻留；
- content artifact 通过引用加载，不整包重复注入。

---

## 19. Worktree 与资源隔离

- VP 自己决定何时调用 `EnterWorktree`；
- Dispatcher 不预建 worktree；
- `EnterWorktree` 隐式绑定 `workspaceId + workItemId + actionId + runId + ownerVpId + baseCommit`；
- worktree 只是 execution root，不改变 workspace/memory scope；
- Action 后续 Run 可以复用已登记且验证通过的 worktree；
- shared root 同时最多一个写 lease；
- Git worktree 内写入可以并行；
- 非 Git 项目写入默认串行；
- remote、数据库、端口、缓存、部署等资源另有锁和 approval；
- 多个分支需要合并时，由 Coordinator 在信息齐备后创建或通知一个普通 Action，Kernel 不认识 integration stage。

Child/sub-agent：

- 继承 parent Action/Run 身份和权限；
- 不能直接写 shared memory；
- 不能创建权威后继 Action；
- parent Run 结束后迟到结果只进入审计；
- 外部副作用仍归 parent Run Operation。

---

## 20. 存储与 Workspace 身份

Work Center 运行数据位于用户级目录：

```text
~/.yeaft/work-center/
├── state.db
├── memory/vp/<vpId>/
└── workspaces/<workspaceId>/
    ├── memory/vp/<vpId>/
    ├── work-items/<workItemId>/
    │   ├── attachments/
    │   ├── actions/<actionId>/
    │   │   ├── runs/<runId>/
    │   │   └── artifacts/
    │   ├── logs/
    │   └── memory/
    │       ├── shared/
    │       └── vp/<vpId>/
    ├── worktrees/
    ├── integrations/
    └── tmp/
```

项目目录只放用户要求的项目资产。Work Center DB、Conversation、Action/Run 日志、memory、附件副本和 recovery 状态不能写进项目。

项目内不写 workspace marker。Agent 在 user-level DB 维护 `workspaceId` 和目录/仓库身份。每次 Run 及 ContentPane live file 读取前验证：

- 原路径存在；
- symlink 未改指；
- resolved directory 匹配；
- 同一路径未换项目；
- Git identity 没有异常替换。

不匹配时不启动 Engine/tool，也不把 live file 展示成可信内容；WorkItem 进入 needs_attention 并要求显式 rebind。

---

## 21. Memory 与 Session 来源

### 21.1 Memory 范围

```text
Work Center VP memory
Workspace VP memory
WorkItem shared memory
WorkItem VP private memory
Action thread / Run transcript
```

加载优先级：

```text
当前 Action thread 和 pending entries
→ WorkItem shared
→ 当前 VP WorkItem private
→ 当前 VP Workspace memory
→ 当前 VP Work Center memory
```

### 21.2 写入权威

- Executor 新发现先进入 VP private；
- Coordinator 接受后才能写 WorkItem shared；
- 可复用经验才提升到 Workspace/Work Center VP memory；
- segment append-only，带 workItem/action/run/message 来源和 outcome；
- 失败和 unknown effect 不能被 summary 提升为已确认事实；
- sub-agent 不能直接写 durable memory。

### 21.3 Session source grants

Session 和 Work Center memory 不合并。只搜索显式授权的 Session snapshot/range：

```js
{
  sessionId,
  snapshotMessageIds: [],
  throughMessageId,
  authorizedAt,
  authorizedBy,
}
```

相同 `workDir` 不构成授权。Session 内容是资料，不是当前指令或 shared knowledge。

---

## 22. 副作用与恢复

### 22.1 Operation

```js
{
  id,
  workItemId,
  actionId,
  runId,
  kind,
  target,
  idempotencyKey,
  replayPolicy: 'safe' | 'probe_first' | 'never_automatic',
  status: 'planned' | 'started' | 'confirmed' | 'failed' | 'unknown',
  resultRef: null,
  recoveryProbe: null,
  startedAt,
  finishedAt: null,
}
```

### 22.2 崩溃窗口

- 工具前写 planned/started；
- 工具后写 confirmed/failed；
- 中间崩溃则 unknown；
- unknown 阻止自动 Start 和 message wake；
- 恢复先探测，再确认复用、补做或请求用户；
- 不能因为用户又发了一条消息就盲目重放。

### 22.3 Runner 重启

恢复时：

1. 读取 active Run lease；
2. 判断 provider/tool 是否仍可控；
3. 核对最后 safe checkpoint；
4. 核对 ActionEntry high watermarks；
5. 将 orphaned in-flight Operation 标记 unknown；
6. 不复用旧 runId 静默重跑；
7. 可安全继续时创建 recovery Run 或要求用户 Start；
8. 迟到旧 Run 结果被 lease fence 拒绝。

准确产品承诺是：状态、消息、证据和已知副作用不会丢；不承诺所有外部操作都能自动继续。

---

## 23. WorkItem 完成与重新打开

### 23.1 完成门禁

Coordinator 可提出 complete，但确定性代码必须确认：

- 没有 queued/running/pausing/stopping Run；
- 没有未消费 Action message/control；
- 没有 pending HumanRequest；
- 没有 unknown Operation；
- 没有未处理 Coordinator mailbox event；
- 所有 revisions 匹配；
- 每条验收条件有结果；
- 最终摘要、证据和残余风险完整。

不要求固定 deliver Action、Review stage 或 graph sink。

### 23.2 完成后的 Action

WorkItem done 后：

- composer 变只读；
- Action 历史仍可查看；
- Start/Pause/Stop 和“发送给 Action”禁用；
- Action admission 历史不被批量改写；
- 新消息必须先显式重新打开 WorkItem。

### 23.3 重新打开

重新打开事务：

- 保存 control ConversationEntry；
- WorkItem 回到 active；
- 原 finalResult 保留；
- Coordinator 接收 reopen 事件；
- 仍 open 的旧 Action可再次定向；
- superseded/closed Action 不能复活；
- Coordinator 可创建新 Action。

---

## 24. Wire API 目标合同

统一 envelope：

```js
{
  type: 'work_center_request',
  agentId,
  requestId,
  op,
  payload,
}
```

### 24.1 读取

- `list_work_items`
- `get_work_item`
- `list_work_item_conversation`
- `list_work_item_actions`
- `get_action`
- `list_action_entries`
- `list_action_runs`
- `get_action_run`
- `get_human_request`
- `get_content_resource`
- `read_workspace_file`
- `read_artifact_file`
- `preview_attachment`
- `get_work_center_settings`

### 24.2 写入

- `create_work_item`
- `post_work_item_message`
- `control_action`
- `stop_work_item`
- `reopen_work_item`
- `delete_work_item`
- `update_work_center_settings`
- `rebind_workspace`

`post_work_item_message`：

```js
{
  clientMessageId,
  workItemId,
  target: {
    type: 'coordinator' | 'action' | 'request',
    actionId: null,
    requestId: null,
  },
  kind: 'context' | 'reply' | 'decision',
  text,
  attachments: [],
  expected,
}
```

`control_action`：

```js
{
  clientCommandId,
  workItemId,
  actionId,
  command: 'start' | 'pause' | 'stop',
  expectedActionRevision,
}
```

### 24.3 退出目标合同的旧操作

- 直接修改 Action instruction；
- Action generation 原地 reset/retry；
- 传入 dependencies/stages/workflow graph；
- 独立 Action 页 composer；
- 浏览器直接改 owner、permissions 或 workspace。

旧 `action_input` 只能迁移为 `post_work_item_message(target=action)`，且必须经过新 admission、ordering 和 start gate；不能保留旧 generation mutation 语义。

### 24.4 事件

`work_center_event` 是可丢失 invalidation 通知，不是事实源：

- 带 WorkItem/action/run/content revisions；
- 浏览器按 revision fence 刷新；
- 重连后重新 list/get；
- 广播只含 redacted summary；
- 原始 tool output 和敏感路径不广播。

---

## 25. 安全与隐私

- 所有读取和写入绑定 Agent owner；
- Server 只鉴权和 relay，不复制 Agent 本地 DB；
- 浏览器传来的 owner、lease、status 和内部身份不可信；
- Provider key 不进入 Work Center settings 或日志；
- tool output、文件和日志做 redaction；
- ContentRef 必须验证 WorkItem 和资源归属；
- live file 只能从验证后的 workspace root 读取；
- artifact 按 Run 和 hash 读取；
- 附件只在所属 WorkItem/Action 可见；
- Session 来源遵守原 owner 和 grant；
- approval 不能跨目标复用；
- Action direct message 不扩大权限；
- workspace mismatch 在 Engine/tool/content live read 前失败。

---

## 26. 当前实现的替换与迁移

当前主线存在 workflow、stage、单一 current Action、Action generation、独立 Action composer 和自动 workspace orchestration。它们是迁移对象。

### 26.1 领域替换

| 当前实现 | 目标模型 |
| --- | --- |
| `workflowTemplate/workflowSnapshot` | 删除；Coordinator 动态决策 |
| `stageId/dependsOnStageIds` | 删除；Action 扁平集合 |
| `planRevision` / graph replan | `actionSetRevision` + Action entries |
| 单一 `currentActionId/currentRunId` | 多 Action，各自 active Run |
| Action generation/attempt 原地换代 | Action thread + immutable Run records |
| Action instruction 被 input 改写 | 冻结 objective + append-only messages |
| waiting/failed 后 reset 同一 Run | 新 Run |
| `workspaceMode` 自动编排 | VP 自主 EnterWorktree + resource lease |
| final graph gate | Coordinator complete + 硬门禁 |

### 26.2 UI 替换

| 当前实现 | 目标交互 |
| --- | --- |
| 独立 Action detail 页面 | WorkItem 右侧 ContentPane |
| Action 页面 composer | 删除；只保留 WorkItem composer |
| Action detail/footer input | target selector + 左侧 composer |
| Action flow / graph | 右侧扁平 Action list |
| Action generation conversation | Action thread + Run list |
| Action retry button | Start control，新 Run |
| 文件另跳 Workbench | ContentPane read-only file 内容 |

### 26.3 旧数据迁移

1. completed/failed/waiting Action 作为 Action thread 导入；
2. 每个 legacy run/attempt 导入独立 Run；
3. legacy user guidance/input 按原顺序导入 ActionEntry；
4. legacy stage/dependency 仅放 migration metadata，不进入目标表；
5. active Run 按副作用状态收敛为 interrupted/unknown；
6. 未消费 input 保留为 pending entry，但 unknown effect 时不得自动启动；
7. WorkItem 进入 needs_attention；
8. 创建 migration CoordinatorTurn 解释状态；
9. 旧 graph scheduler 停用；
10. 迁移可回滚、重复 reopen 幂等。

---

## 27. 前端组件边界

```text
WorkCenterPage
├── WorkCenterBoard
│   ├── WorkCenterToolbar
│   ├── WorkItemLane
│   └── WorkItemCard
└── WorkItemPage
    ├── WorkItemHeader
    ├── WorkItemConversationPane
    │   ├── WorkItemOverview
    │   ├── WorkItemTimeline
    │   │   ├── WorkItemMessage
    │   │   ├── ActionStatusCard
    │   │   └── HumanRequestCard
    │   └── WorkItemComposer
    └── WorkItemContentPane
        ├── ContentPaneHeader
        ├── ActionListContent
        ├── ActionDetailContent
        ├── RunDetailContent
        ├── FileContent
        ├── DiffContent
        ├── ToolLogContent
        └── AttachmentContent
```

### 27.1 前端状态

每个 WorkItem 保存：

- Conversation cursor 和 scroll position；
- composer text/attachments/target；
- ContentPane stack；
- 当前 ContentRef；
- 各资源 cache/loading/error；
- detail request generation fence；
- Action/Run revision。

ContentPane 切换不能清除 composer；composer target 切换不能隐式改变 ContentRef。

### 27.2 复用

- 全局 `.btn-primary/.btn-secondary/.btn-ghost`；
- input wrapper 和附件 picker；
- Markdown renderer；
- `variables.css` token；
- 现有 execution/tool 展示组件；
- Work Center card 基础样式；
- 现有文件只读渲染能力。

### 27.3 拆除

- 独立 `ActionPage` route；
- `WorkCenterActionDetail` 内的 composer/footer；
- Action draft attachment 状态；
- Action instruction mutation；
- workflow/action-flow 右栏；
- dependency/stage UI；
- 点击 Action 自动改变发送目标的隐式行为。

---

## 28. 可访问性、主题与响应式

- 所有文案同步 `en.js` 和 `zh-CN.js`；
- 新颜色、间距、圆角只用 token；
- light/dark 真实浏览器检查；
- Conversation 使用 `role=log`，流式更新不抢焦点；
- target selector 有明确可访问名称；
- target chip 可键盘移除；
- Action 状态不只靠颜色；
- pausing、queued、blocked 有文字说明；
- ContentPane back button 有来源标题；
- Action list/detail 使用正确 list/region 语义；
- 代码行可横向滚动但页面不溢出；
- reduced motion 关闭 pulse；
- 375px、768px、桌面布局均可完成发送、定向、暂停、启动、查看和返回；
- mobile tab 切换不丢 composer draft/target。

---

## 29. 验收测试

### 29.1 消息投递

- 默认消息只进入 Coordinator mailbox；
- 查看 Action 不改变 composer target；
- 显式选择 Action 后消息进入正确 inbox；
- Coordinator → Action 走同一顺序协议；
- 相同 clientMessageId 只写一次；
- running Action 消息不进入 in-flight provider request；
- 消息在下一个持久安全边界恰好消费一次；
- completed/failed/paused Action 收到消息后创建新 Run；
- superseded/closed Action 拒绝且保留 draft；
- WorkItem done 与 message 竞态只有一个事务胜出。

### 29.2 控制竞态

- message → pause：消息保留，pause 前不启动新 turn；
- pause → message：按 sequence 请求恢复；
- pause → start：pause checkpoint 后产生新 Run；
- start 重放幂等；
- running 上 start no-op；
- stop 推进 lease，迟到 Run 结果被拒绝；
- stop 后 unknown effect 阻止 message auto-start；
- background task 在 Pause 后仍明确展示；
- Agent 重启后 ActionEntry high watermark 不倒退。

### 29.3 Run 与 Engine

- 每次 resume 创建新 runId；
- 旧 Run 终态不可改写；
- 多次 Action message 按数量和顺序进入模型；
- provider failure 不重复消费 message；
- tool-call batch 完整后才注入新消息；
- checkpoint、tool result 和 Operation 原子对应；
- Coordinator消息不伪装成 user；
- Start instruction 不写成用户历史；
- stale lease 不能写结果、memory 或 Action state。

### 29.4 ContentPane

真实 Vue + Pinia + WebSocket + Mock Agent：

- WorkItem 桌面只有两栏；
- 页面只有一个 textarea/composer；
- Action list → detail → Run → file 可逐层返回；
- ContentPane 导航不改变 Conversation scroll/draft/target；
- 点击“发送消息给此 Action”才设置 target；
- ContentPane 无第二 composer；
- LIVE/SNAPSHOT/DIFF/LOG 标签正确；
- stale file/detail response 不能覆盖当前内容；
- browser back 优先回退 pane 栈；
- mobile Conversation/Content tab 保留状态；
- light/dark 和 375/768/desktop 无溢出；
- 键盘可完成查看、返回、target、pause/start/stop。

### 29.5 Workspace、memory 与安全

- symlink retarget 在 Run/content live read 前失败；
- worktree 不改变 memory scope；
- shared root 写租约生效；
- 非 Git 并行写串行；
- direct Action message 不能扩大 tool roots；
- unknown Operation 阻止 Start；
- 未授权 Session 不可搜索；
- 同 workDir 不自动授权；
- VP private 不被其他 VP直接读取；
- shared 只能由 Coordinator 接受；
- Work Center 数据不写项目目录。

### 29.6 完成与迁移

- pending ActionEntry 阻止 WorkItem done；
- active/pausing/stopping Run 阻止 done；
- unknown Operation 阻止 done；
- reopen 后 open Action可重新定向；
- superseded/closed Action 不复活；
- 真实旧 schema fixture 导入 Action threads 和 Runs；
- active legacy Run 不盲目继续；
- migration 回滚原子；
- 重复 reopen 幂等；
- 目标数据库没有 dependency/stage 调度语义。

---

## 30. 实施顺序

设计经独立复审通过后再实现：

1. **规范化存储**：Conversation、ActionEntry、Action、Run、HumanRequest、Operation。
2. **Runner 协议**：safe checkpoint、entry high watermark、Run lease、消息注入。
3. **控制命令**：Pause/Start/Stop、unknown effect gate、恢复。
4. **Coordinator 合同**：create/control/message Action，不包含 graph。
5. **Wire**：单一 WorkItem message 入口、Action control、ContentRef 读取。
6. **Web 双栏**：Conversation + ContentPane、target selector、pane stack。
7. **Content 类型**：Action、Run、live/snapshot file、diff、log、attachment。
8. **Workspace/memory/source grants**：身份验证和权限边界。
9. **旧数据迁移**：workflow/generation → Action thread/Run。
10. **门禁**：focused、全量 Vitest、Playwright、build、docs、syntax、smoke、audit。
11. **交付**：固定 PR SHA，Martin 独立复审通过后 merge 和下一个 patch tag。

不能以兼容旧 workflow 为由继续扩大 graph、stage、Action mutation 或第二 composer。

---

## 31. 最终审批清单

### 产品布局

- [x] WorkItem 是 Conversation + ContentPane 两栏。
- [x] 没有独立 Action 页面。
- [x] 右侧默认 Action list，可钻取 Action、Run、文件、diff 和日志。
- [x] ContentPane 有内部 back stack。
- [x] 全页面只有一个 composer。
- [x] 查看内容不会自动改变发送目标。

### 交互

- [x] composer 默认目标 Coordinator。
- [x] 用户可以显式指定 Action。
- [x] Coordinator 可以直接给 Executor Action 发消息。
- [x] Action 问题和批准复用同一个 composer。
- [x] Action detail 只读；Start/Pause/Stop 是控制命令。

### 执行

- [x] Action 是持久线程，Run 是一次执行。
- [x] running Action 的新消息在安全边界进入下一模型调用。
- [x] 非 running open Action 的消息默认触发新 Run。
- [x] Start 不伪造用户消息。
- [x] Pause 不承诺撤销副作用。
- [x] Stop 后 unknown effect 阻止自动重启。
- [x] 没有 DAG、依赖图、stage 或 workflow template。

本文档通过独立设计复审后即成为实现基线；领域合同变化必须先更新设计并重新复审。
