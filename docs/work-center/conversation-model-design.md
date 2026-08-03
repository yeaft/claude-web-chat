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
- stopped：只有没有 effect unresolved 或 execution unsafe 的 blocking Operation 时才可启动；
- superseded / closed：拒绝投递；
- WorkItem cancelling / done / cancelled：拒绝投递；cancelled/done 必须先显式重新打开，cancelling 必须等待停止收敛。

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

### 4.7 EngineTurn

EngineTurn 是 Run 内的一次逻辑 provider round，也是 ActionEntry 与 provider dispatch 之间的持久 single source of truth：

- 一个稳定 `turnId`；
- 一个不可变 request body/hash；
- 一组已绑定的 ActionEntry IDs；
- 一个单调 dispatch attempt；
- 一条 provider dispatch 状态机；
- 零或一个已持久化 response；
- 后续 tool-call batch 和 checkpoint 来源。

ActionEntry 到 EngineTurn 的绑定在本地数据库中恰好一次；provider invocation 本身只有在 provider 支持稳定幂等键或可查询 request identity 时才能声称恰好一次。没有该能力时，dispatch 在崩溃窗口中的真实语义是 `at-least-once/unknown`，不能把“已绑定”冒充“provider 一定没有或已经执行”。

### 4.8 ActionEntry

Action 的所有外部输入和控制命令共用一个单调序列：

```text
message → pause → message → start → stop
   41       42       43       44      45
```

严格顺序用于解决消息、暂停和继续之间的竞态。

### 4.9 CoordinatorTurn

Coordinator 对 WorkItem mailbox 中的一批事件进行一次串行决策。Coordinator 可以：

- 回复 WorkItem；
- 更新 WorkItem 合同；
- 创建、关闭或 supersede Action；
- 给 Action 发消息；
- 打开 HumanRequest；
- 接受 shared knowledge；
- 完成 WorkItem。

### 4.10 HumanRequest

需要用户明确介入的对象：

- `question`；
- `approval`；
- `confirmation`。

它可以属于 Coordinator 或某个 Action，并有独立 `requestId`、revision 和状态。

### 4.11 Operation

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
    │   │   └── EngineTurn[]
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
- WorkItem cancelling/done/cancelled 时业务发送端拒绝。`done/cancelled + safetyStatus=safe` 提示先重新打开；`done/cancelled + reconciling/unsafe` 显示 safety warning 和结构化 recovery controls，不提示先 reopen；cancelling 提示等待停止或继续 recovery-only 处理。

### 8.6 可见投递状态

定向 Action 消息显示：

- `queued`：已持久化，等待 Action 消费；
- `scheduled`：消息已触发新 Run；
- `delivered`：已加入某次 model turn；
- `blocked`：被 workspace、approval、unresolved effect、unsafe execution 或未释放资源阻止；
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

WorkItem `cancelling/done/cancelled` 是额外 admission gate；它不会篡改历史 Action，但阻止新投递和 Run。

### 10.2 Runtime display status

Action 的显示状态来自 active Run、最新终态和 pending commands：

```text
idle
queued
running
dispatch_unknown
pausing
paused
waiting
completed
failed
stopping
stopped
blocked
```

`completed/failed/paused/stopped` 描述最近一次 Run 或当前执行状态，不是 Action 的永久终态。`queued/running/dispatch_unknown/pausing/stopping` 都算 active Run；只要其中任一存在，不能创建新 Run。Action 仍 `open`、没有 active Run 且启动门禁通过时，才可产生新 Run。

### 10.3 Run lifecycle

```text
queued → running → completed / waiting / failed
                 → dispatch_unknown → running
                 → pausing → paused
                 → stopping → stopped / interrupted / cancelled
queued → cancelled
```

`queued/running/dispatch_unknown/pausing/stopping` 是非终态 Run 状态。`dispatch_unknown` 保留 active Run identity，但不持有可执行 lease，也不允许新 provider/tool 工作。Run 一旦进入 `completed/waiting/paused/failed/stopped/interrupted/cancelled` 终态就不可修改；继续执行创建新 `runId`，而不是把旧 Run 改回 running。

### 10.4 Start gate

创建新 Run 前必须同时满足：

- WorkItem 是 active / needs_attention 且允许执行；
- Action admission 是 open；
- 没有 active Run；
- workspace identity 验证通过；
- tool/model policy 仍有效；
- required approval 存在且未过期；
- 每个 blocking Operation 都满足 22.1 节唯一谓词 `operationSafeToProceed(operation)`；
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
  status: 'pending' | 'scheduled' | 'bound' | 'consumed' | 'blocked' | 'rejected' | 'cancelled',
  boundRunId: null,
  boundTurnId: null,
  terminalAt: null,
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

每个 Run/EngineTurn 持久化：

- `claimedThroughSequence`；
- `consumedThroughSequence`；
- 实际 message entry IDs；
- 实际 control entry IDs。

`bound` 表示 entry 已经不可逆地绑定到唯一 EngineTurn，但尚未取得并持久化该 turn 的 provider response。response CAS 成功后 entry 置为 `consumed`；显式取消 unknown turn 时置为 `cancelled`；turn 仍 unknown 时保持 `bound`。`consumedThroughSequence` 实际是连续 terminal high watermark，只能越过 `consumed/cancelled/rejected`，不能越过仍为 `bound` 的 entry。重启后不能仅靠内存或高水位猜测哪些消息进入了哪个请求。

---

## 12. 安全边界与消息注入

### 12.1 安全边界定义

普通 message 和 Pause 只能在以下持久边界生效：

1. provider response 已完整持久化；
2. 该 response 发出的当前 tool-call batch 已全部得到 terminal tool result；
3. 对应 Operation 的 effect、execution、authority fence 与 resource release 状态已持久化；
4. engine transcript 可以构造合法的下一次 provider request；
5. 尚未发出下一次 provider request。

这不是 Engine 内存中的临时 `if`，而是 Run journal 中可恢复的 checkpoint。

### 12.2 消息到达 running Action

- 当前 provider request 不取消；
- 已开始的 tool-call batch 不插入新消息；
- UI 显示“等待安全边界”；
- 到达边界后原子 claim inbox entries，并创建状态为 `prepared` 的 durable EngineTurn；
- 新消息作为下一次 model input 的独立、有来源内容块；
- 同一事务保存不可变 request body/hash、entry IDs、`boundRunId/boundTurnId`，并把 entries 置为 `bound`；
- 网络调用前再用短事务把同一 EngineTurn 置为 `dispatching`、递增 attempt，并保存 provider idempotency/request key；
- provider response 与 EngineTurn `responded`、entries `consumed`、连续高水位在一个事务中提交；
- provider 调用失败或进程崩溃时，恢复规则以 EngineTurn 状态裁决，绝不把 entries 绑定到另一个 turn。

### 12.3 Provider dispatch 崩溃窗口

- `prepared` 后、`dispatching` 前崩溃：网络调用尚未开始，可以安全 dispatch 同一个 `turnId` 和 request hash；
- `dispatching` 后、response 持久化前崩溃：恢复事务锁定 EngineTurn；只有 provider 能按稳定 request key 查询结果或保证同 key 幂等时，才能自动 reconcile/retry；否则在同一 `BEGIN IMMEDIATE` 中把 turn 置为 `unknown`、Run 置为 `dispatch_unknown`、创建唯一 pending `engine_turn_dispatch` HumanRequest、推进 run/request revisions，并写 Conversation/Event；
- provider 不支持查询或幂等时：不得自动再发请求，entry 保持绑定到该 turn；request owner 用户或 Coordinator 必须显式选择“确认并采用已查询结果”“确认未执行并允许同一 turn 再 dispatch”或“取消该 turn/Run”，不能新建另一个 turn 偷偷重复消费；
- `responded` 后崩溃：恢复直接使用已持久 response，不再次调用 provider；
- adapter 必须显式声明 dispatch capability，未知能力按最保守的 non-idempotent 处理。

裁决事务必须校验 `workItemId + actionId + runId + turnId + requestHash + dispatchAttempt + requestId + expectedRequestRevision + expectedRunRevision + cancellationEpoch`。采用已查询结果时写 response CAS 并恢复同一 Run；允许再 dispatch 时只给同一 Run/turn 分配新的 lease epoch 和 dispatch attempt，不改 request/entries；取消时把 turn 和 Run 收敛为 cancelled/failed 并保留 unknown effect 审计。所有分支在同一事务消费 resolution request、推进 request/run revisions 并写 Conversation/Event；两个用户、用户与 Coordinator、Stop 与裁决并发时只有一个 CAS 成功。`dispatch_unknown` 未裁决期间阻止 Action Start、message wake、WorkItem Stop 以外的控制和 complete。

因此产品承诺是“ActionEntry 在本地只绑定一个逻辑 EngineTurn”，不是“任意 provider 的网络调用物理上恰好一次”。

### 12.4 多工具调用

如果一个 assistant response 已经产生多个 tool call：

- batch 开始前可以先检查 pause/message；
- batch 一旦开始，普通 Pause 不拆开 batch；
- 所有 started call 必须有 terminal tool result；
- 未开始的 call 只有在协议允许写明确 cancelled tool result 时才可取消；
- 第一版采用更保守规则：一个 response 的 tool-call batch 完整结束后再注入消息。

### 12.5 后台任务

后台 shell/tool 返回 durable task envelope 后即形成 tool result，但后台副作用仍由独立 Operation/Task 生命周期跟踪。Pause 不会自动杀死已启动的后台进程；UI 必须显示仍在运行的外部任务，并提供单独取消能力。Run 终态不会冻结或伪造 Operation 终态；后台结果只能追加 Operation event、artifact 和 Coordinator mailbox event，不能回写已终态 RunResult。

---

## 13. Pause、Start 与 Stop

### 13.1 Pause

Pause 是 cooperative safe-boundary pause：

1. 写 `pause` ActionEntry；
2. active Run 显示 `pausing`；
3. 不启动新的 provider request 或 tool batch；
4. 等当前不可拆分工作完成；
5. 持久化 checkpoint、Operation 三轴状态和未消费 inbox；
6. 当前 Run 终态为 `paused`；
7. Action 显示 `paused`。

Pause 不承诺：

- 回滚文件；
- 撤销 push/部署/数据库写；
- 立刻停止同步 shell；
- 杀死后台任务；
- 把 `effectStatus=unknown` 变成 `not_applied`，或把仍活跃 execution 假装成 quiescent。

### 13.2 Start

Start 按钮写 `start` control entry：

- idle/paused/waiting/failed/completed/safe-stopped：通过 start gate 后创建新 Run；
- queued/running：幂等 no-op；
- pausing：按 sequence 记录，pause checkpoint 完成后再创建新 Run；
- superseded/closed：拒绝；
- 任一 blocking Operation 不满足 `operationSafeToProceed`：blocked。

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
5. 对仍活跃 Operation 把 `executionStatus` 写为 `cancel_requested`；effect 已知则保持，确认未发生写 `not_applied`，无法确认写 `unknown`；
6. active Run 终态为 `stopped/interrupted`；
7. 任一 effect unresolved、execution unsafe 或 resource fence 未覆盖的 Operation 存在时 Action 显示 blocked。

Stop 不是撤销。用户如果只是想补充方向，应发消息或 Pause，不应默认 Stop。

---

## 14. HumanRequest

```js
{
  id: requestId,
  workItemId,
  actionId: null,
  runId: null,
  turnId: null,
  operationId: null,
  coordinatorTurnId: null,
  authorizedUserId,
  createdBy: { type: 'coordinator' | 'recovery' | 'system', id },
  kind: 'question' | 'approval' | 'confirmation',
  resolutionType: null | 'engine_turn_dispatch' | 'operation_effect' | 'supplemental_authority' | 'external_recovery_conflict',
  prompt,
  details,
  expectedIdentity: null | {
    requestHash: null,
    dispatchAttempt: null,
    operationRevision: null,
    ownerLeaseEpoch: null,
    executionEpoch: null,
    effectCutoffHash: null,
    grantManifestGeneration: null,
    grantManifestHash: null,
    capabilityUniverseGeneration: null,
    capabilityUniverseHash: null,
    safetyRevision: null,
    recoveryAdmissionEpoch: null,
    terminalSafetySnapshotEpoch: null,
    terminalSafetySnapshotStatus: null,
    supplementalGeneration: null,
    effectiveManifestHash: null,
    authorityIdentity: null,
    externalRecoveryConflictId: null,
    externalRecoveryConflictRevision: null,
    externalDispatchAdmissionEpoch: null,
    cancellationEpoch,
  },
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'expired' | 'cancelled',
  revision,
  openedAt,
  resolvedAt: null,
  resolutionMessageId: null,
  resolutionCommandId: null,
}
```

恢复类 HumanRequest 不是普通提示卡。数据库必须保证每个 unresolved EngineTurn/Operation 最多存在一个 pending resolution request：

- `engine_turn_dispatch` 唯一键是 `(turnId, requestHash, dispatchAttempt, status=pending)`；
- `operation_effect` 使用跨 revision 的 SQLite partial unique index：`CREATE UNIQUE INDEX ... ON human_requests(operation_id) WHERE resolution_type = 'operation_effect' AND status = 'pending'`，并用 `CHECK(resolution_type != 'operation_effect' OR operation_id IS NOT NULL)` 禁止空 owner；`operationRevision` 只存在于冻结 CAS identity，不能进入 pending 唯一键；
- `external_recovery_conflict` 使用 `CREATE UNIQUE INDEX ... ON human_requests(external_recovery_conflict_id) WHERE resolution_type='external_recovery_conflict' AND status='pending'`，并用 CHECK 要求 conflict ID 非空、expected conflict/admission identity完整；它只镜像 pending conflict 的结构化人工入口，Conflict 行本身才是 SSOT；conflict 自动 resolved/superseded 时同一事务消费 request；
- 创建、effect 进入 `unknown`、推进 WorkItem `requestRevision`、写 Conversation/Event 必须在同一个 `BEGIN IMMEDIATE` 事务；
- request 的 `expectedIdentity` 是创建时的冻结身份，resolve wire 还必须提交 `requestId + expectedRequestRevision`；
- Operation revision 或 cancellation epoch 推进时，事务必须锁定并 rebind 同一 pending request 行、推进 request revision 和 expectedIdentity；如果旧 request 已终态，才可在 partial unique 约束下新建；禁止先留旧 pending 再插入新行；
- 重启扫描用 `operationId` 查询 partial unique 行并幂等补建或 rebind，不能因 revision 改变创建第二张卡；
- request 被 Stop、另一个裁决或状态自动探测消费后，任何迟到回复都无副作用。

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
  operationRevision,
  cancellationEpoch,
  safetyRevision,
  recoveryAdmissionEpoch,
  terminalSafetySnapshotEpoch,
  terminalSafetySnapshotStatus,
  memoryRevision,
  inputEventIds: [],
}
```

模型返回后，事务提交前重新比较。任何相关 revision、recovery admission epoch 或 terminal snapshot epoch/status 变化，旧决定都不能提交。普通 CoordinatorTurn 不能跨入 recovery epoch；recovery-mode CoordinatorTurn 也不能在 snapshot 已恢复/再次失效后提交。

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
  resolveOperations: [{
    operationId,
    requestId,
    decision: 'confirm_applied' | 'confirm_not_applied' | 'confirm_failed_no_effect',
    evidenceRefs: [],
    expectedOperationRevision,
    expectedRequestRevision,
    expectedOwnerLeaseEpoch,
    expectedExecutionEpoch,
    effectCutoffHash,
    grantManifestGeneration,
    grantManifestHash,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    safetyRevision,
    recoveryAdmissionEpoch,
    terminalSafetySnapshotEpoch,
    terminalSafetySnapshotStatus,
    cancellationEpoch,
  }],
  resolveExternalRecoveryConflicts: [{
    conflictId,
    requestId,
    decision: 'accept_independent_authority_query' | 'confirm_operator_isolation' | 'accept_stronger_authority_epoch_fence',
    authorityProofId,
    evidenceRefs: [],
    expectedConflictRevision,
    expectedDispatchAdmissionEpoch,
    expectedOwnerLeaseEpoch,
    expectedDispatchFenceEpoch,
    expectedSafetyRevision,
    expectedRecoveryAdmissionEpoch,
    cancellationEpoch,
  }],
  openRequests: [],
  acceptedSharedKnowledge: [],
  complete: null | {
    summary,
    acceptanceResults: [],
    evidenceRefs: [],
    residualRisks: [],
  },
  restoreTerminalSafety: null | {
    resultingLifecycle: 'done' | 'needs_attention',
    summary,
    acceptanceResults: [],
    evidenceRefs: [],
    residualRisks: [],
    expected: {
      lifecycleStatus: 'done',
      terminalSafetySnapshotEpoch,
      terminalSafetySnapshotStatus: 'invalidated' | 'restoring',
      workItemRevision,
      operationRevision,
      requestRevision,
      safetyRevision,
      recoveryAdmissionEpoch,
      cancellationEpoch,
      operationSafetyHash,
    },
  },
}
```

`resolveOperations` 不是第二套授权入口。CoordinatorTurn 提交时，服务端必须为每个元素派生稳定 command identity `coordinatorTurnId:operationId:requestId`，再规范化为与 `resolve_operation` wire 完全相同的 payload，并在 CoordinatorTurn 的同一个外层 `BEGIN IMMEDIATE` 中调用 22.3 节权威 mutation 的 transaction-aware 内部实现；wire 入口只是为同一内部实现建立自己的外层事务。两者都不能绕过 pending request、effect evidence、owner lease、operation/request revision、execution epoch、cutoff hash、manifest/universe generation/hash 或 cancellation epoch fence。整个 CoordinatorTurn 仍受 15.2 节 snapshot CAS；任一 resolution stale 时，外层事务整体 rollback，不得部分提交 reply、其他 resolution 或 complete。

`resolveExternalRecoveryConflicts` 不是任意解除安全告警的旁路。每项必须规范化为 `resolve_external_recovery_conflict` 的同一 transaction-aware mutation；普通 `evidence_gap` 可由自动 matching confirmed attempt 或结构化 independent query补证，通常不需要人工命令。`authority_contract_violation` 只能提交独立 authority query、operator isolation 或更强 authority epoch/fence proof；普通 confirmed send-attempt、用户文本确认和同一被质疑 authority 的普通 success 一律不能 resolve。任一 conflict/authority proof/admission identity stale 时整个 CoordinatorTurn rollback。

`restoreTerminalSafety` 是 recovery-mode Coordinator 的唯一终态恢复命令，不是普通 `complete` 的别名。它只允许 `lifecycleStatus=done`、terminal snapshot invalidated/restoring、当前 recovery admission open 的 CoordinatorTurn 产生；普通 Coordinator、用户、Executor 和浏览器不能构造或提交。

同一个 CoordinatorTurn **禁止**同时提交非空 `resolveOperations` 与 `restoreTerminalSafety`。只要 turn 含任一 resolution，`restoreTerminalSafety` 必须为 null；resolution 外层事务提交前调用 16.3 节共用的 `enqueueTerminalSafetyReadyIfEligible()`，按 post-resolution 权威状态决定是否写 ready event，绝不使用 turn 启动时的 pre-resolution snapshot 或猜测 revision delta。若 lifecycle=done 且全部安全前置条件已成立，helper 原子写唯一 `terminal_safety_ready_for_restore` Coordinator mailbox event；它携带提交后的 WorkItem/Operation/request/safety revisions、recovery admission epoch、terminal snapshot epoch/status 和 operationSafetyHash，并创建一个新的 recovery CoordinatorTurn，后者从新 snapshot 单独提交 restore。若 lifecycle=cancelled，helper 不创建 Coordinator restore turn，而写内部 `cancelled_safety_ready_for_terminalizer` event，交给 Watcher 认领。前置条件未满足时不创建 ready event，等待后续 recovery mutation。两类 event 使用 16.14 节规范化行和 partial unique；`operationSafetyHash` 是 event identity/fence 字段，不进入“每个 snapshot/type 最多一个 pending/claimed”的唯一键。hash/identity 换代时 helper 先把旧 event 与其 CoordinatorTurn/Watcher claim 持久 supersede，再创建/复用新 event；重复 resolution/retry 不能排队第二个 live 恢复执行者，旧 event 也不能阻塞新 restore。

`restoreTerminalSafety` 还不能与 `reply`、`contractPatch`、`createActions`、`postActionMessages`、`controlActions`、`openRequests`、`acceptedSharedKnowledge` 或普通 `complete` 同时非空。`resultingLifecycle=done` 表示最新验收仍成立；`needs_attention` 表示验收失效。具体 shared mutation 见 16.3 节，wire 只是同一 mutation 的内部恢复入口。

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
  operationRevision,
  safetyRevision,
  cancellationEpoch,
  title,
  goal,
  acceptanceCriteria: [],
  status: 'draft' | 'active' | 'needs_attention' | 'cancelling' | 'done' | 'cancelled',
  safetyStatus: 'safe' | 'reconciling' | 'unsafe',
  safetyCauseRefs: [],
  recoveryAdmission: {
    status: 'closed' | 'open',
    epoch,
    allowedOps: [],
    openedAt: null,
    closedAt: null,
  },
  terminalSafetySnapshot: null | {
    epoch,
    lifecycleStatus: 'done' | 'cancelled',
    status: 'current' | 'invalidated' | 'restoring',
    workItemRevision,
    operationRevision,
    requestRevision,
    safetyRevision,
    cancellationEpoch,
    operationSafetyHash,
    causeRefs: [],
    validatedAt,
    invalidatedAt: null,
    restoredFromEpoch: null,
  },
  reuseMemory,
  origin,
  finalResult: null,
  createdAt,
  updatedAt,
  closedAt: null,
}
```

没有单一 `currentActionId/currentRunId`。`status` 只描述业务生命周期；`safetyStatus` 独立描述当前事实是否仍支持该生命周期投影。`done/cancelled + reconciling/unsafe` 是合法且必须可见的组合，不得为了保持“终态”外观隐藏安全失效。

`recoveryAdmission.allowedOps` 只能取 `resolve_operation`、`resolve_supplemental_authority`、`resolve_external_recovery_conflict`、`restore_terminal_safety`、`get_human_request`、只读查询，以及系统内部的 `reconcile_operation`、`probe_execution`、`close_grant_acquisition`、`enforce_authority_fence`、`advance_release_saga`、`advance_supplemental_release`。它永远不允许业务 message、Action Start、创建 Action、reopen 或 complete。用户只能通过已有 pending resolution request 调用 `resolve_operation/resolve_supplemental_authority`；recovery-mode Coordinator 可通过同一 request identity 提交这些 resolution，并在当前 terminal snapshot/recovery turn identity 下提交 `restoreTerminalSafety`。其余项都是经过 owner/identity fence 的系统恢复 mutation。

### 16.3 终态安全失效与恢复

`done/cancelled` 是业务生命周期终态，不是永不失效的安全断言。任何 Operation reconciliation、迟到 effect、迟到 grant/lease、authority callback 或 migration repair 使 `operationSafeToProceed` 从 true 变为 false 时，处理该事实的同一个 `BEGIN IMMEDIATE` 事务必须：

1. 按稳定 evidence/discovery ID 幂等写入 Operation reconciliation 或 supplemental inventory，更新 Operation 状态并推进 `operationRevision`；
2. 锁定 WorkItem，校验当前 lifecycle、`workItemRevision + operationRevision + safetyRevision + cancellationEpoch`；
3. 将 `safetyStatus` 置为 `reconciling`；如果存在 unknown authority、无法关闭 acquisition、无法建立 cutoff/fence 或没有已知恢复路径，则置为 `unsafe`；
4. 推进 `safetyRevision` 和 WorkItem revision，把当前 `terminalSafetySnapshot.status` 置为 `invalidated`，写 `invalidatedAt`、cause refs，并保留原 `lifecycleStatus`、finalResult 和验收历史；
5. 打开新的 `recoveryAdmission.epoch`，其 allowed ops 只能是 recovery-only 集合；恢复类 HumanRequest 按新 safety/recovery epoch 创建或 rebind；
6. 写唯一 `work_item.terminal_safety_invalidated` Event 和高优先级 Conversation warning；向用户发送 terminal-safety notification，并投递一个**恢复模式** Coordinator mailbox event。恢复模式 CoordinatorTurn 只能提交 `resolveOperations`、打开恢复请求，以及在全部恢复条件成立后提交唯一 `restoreTerminalSafety`；不能回复业务消息、修改合同、创建/启动 Action 或使用普通 `complete`；
7. 使 Work Center 列表和 WorkItem header 立即显示 `Done — safety review required` 或 `Cancelled — safety review required`，并把卡片投影到 Needs attention，而不是继续放在 Closed。composer 和 Action 控制仍保持只读，只有结构化 recovery controls 可用。

该事务不能等待用户打开 WorkItem 或发起 reopen；事实一旦进入持久层，canonical DTO、列表投影和通知必须同步失效。并发的 late facts 复用同一 recovery epoch，追加 cause refs 并推进 revisions，不重复创建 warning/request；事实发生在 active/needs_attention/cancelling WorkItem 时也推进 safetyRevision 和 warning，但不伪造 terminal snapshot。

每个可能让 WorkItem 级恢复条件从未满足变为满足的 transaction-aware mutation——包括 `resolveOperations`、自动 effect/execution probe、authority closure、主/supplemental release saga、reconciliation 和 migration repair——都必须在同一个外层事务末尾调用 `enqueueTerminalSafetyReadyIfEligible()`。helper 重新读取全部 Run、Operation、request、reconciliation、supplemental 和 mailbox 状态，重算 `operationSafetyHash`，并校验 lifecycle、safety/recovery/snapshot identity。done 只创建 `terminal_safety_ready_for_restore` Coordinator mailbox event；cancelled 只创建 `cancelled_safety_ready_for_terminalizer` 内部 Event；其他 lifecycle 不创建 terminal ready event。event 的持久化与触发条件变化同事务提交，避免“状态已安全但崩溃前没唤醒恢复者”。

Watcher 认领 `cancelled_safety_ready_for_terminalizer` 时先在一个事务创建/幂等复用 `purpose=terminal_safety_restore,status=ready` 的规范化 CancellationAttempt，绑定 `recoveryAdmissionEpoch + terminalSafetySnapshotEpoch + cancellationEpoch`；然后通过 16.13 节共享 `claimCancellationAttempt()` 协议取得 owner lease。live 行由数据库 partial unique 权威派生，claim 只建立执行权，不修改 safety/lifecycle/snapshot。

安全恢复由唯一 shared mutation `restoreTerminalSafety({ caller, expected, assessment })` 提交；不能由 watcher、UI 投影或普通 complete 隐式触发。`caller` 是显式 tagged union，shared core 复用安全重算和终态写入，但两个 variant 绝不共享或跳过 caller 校验：

```js
caller = {
  kind: 'coordinator',
  coordinatorTurnId,
  mailboxEventId,
  commandIdentity: `${coordinatorTurnId}:restoreTerminalSafety:${terminalSnapshotEpoch}`,
} | {
  kind: 'cancelled_terminalizer',
  cancellationAttemptId,
  ownerId,
  ownerBootId,
  ownerLeaseEpoch,
  dispatchFenceEpoch,
  externalDispatchPolicyHash,
  commandIdentity: `${cancellationAttemptId}:terminalSafetyRestore:${terminalSnapshotEpoch}`,
}
```

两种 variant 都必须在单一 `BEGIN IMMEDIATE` 中校验共同 expected identity：`lifecycleStatus + terminalSnapshotEpoch/status + workItemRevision + operationRevision + requestRevision + safetyRevision + recoveryAdmission.epoch + cancellationEpoch + operationSafetyHash`，并确认全部 Run 已终态、每个 blocking Operation 重新满足 `operationSafeToProceed`、supplemental inventory 已 resolved/clear、没有 pending recovery request/reconciliation。服务端从权威 Operation/supplemental rows 重新计算 `operationSafetyHash`；payload/hash只能作为 optimistic expected value，不能替代服务端重算。coordinator variant 校验并消费 `terminal_safety_ready_for_restore`；cancelled variant 校验并消费 `cancelled_safety_ready_for_terminalizer`，不能互换 event type。

`caller.kind=coordinator` 只允许原 lifecycle done。mutation 额外验证 recovery-mode CoordinatorTurn、它 claim 的唯一 `terminal_safety_ready_for_restore` mailbox event、turn snapshot 与 expected identity 完全一致，并消费该 event；除此之外存在任何未处理 recovery mailbox event 都拒绝 restore。该 caller 必须携带 15.3 节结构化 assessment，并只能选择 done 或 needs_attention。

`caller.kind=cancelled_terminalizer` **只处理已 cancelled WorkItem 的 terminal-safety restore，不处理首次 `cancelling → cancelled`**。它要求原 lifecycle cancelled、terminal snapshot invalidated/restoring、recovery admission open 且 `assessment=null`。调用前必须已有该 WorkItem 唯一的规范化 CancellationAttempt live 行；terminalizer在同一个外层事务先把匹配attempt从active CAS为settling，再调用shared mutation。mutation锁定该行，在同一SQLite事务取得dbNow并严格比较`workItemId + purpose=terminal_safety_restore + cancellationAttemptId + ownerId + ownerBootId + ownerLeaseEpoch + dispatchFenceEpoch + externalDispatchPolicyHash + leaseExpiresAt>dbNow + cancellationEpoch + recoveryAdmissionEpoch + terminalSafetySnapshotEpoch + status=settling`；并确认该attempt没有未解决的exclusive dispatch、authority fence advance 或unknown dispatch reconciliation；调用方必须是 Controller/Watcher registry 中相同 boot/owner 的当前内部 recovery terminalizer actor。它不要求、不读取也不伪造 CoordinatorTurn/mailbox event，固定 resultingLifecycle=cancelled，禁止验收/finalResult输入和任何 lifecycle 变化。`active → settling` 与 shared mutation 必须在同一个外层 `BEGIN IMMEDIATE` 中完成；restore 失败会整笔 rollback，使 attempt 仍为 active。旧 purpose/attempt、旧 owner lease/epoch、superseded/settled attempt 或伪造 internal caller在写入前失败。

对 `resultingLifecycle=done`：只允许原 lifecycle 为 done；要求 command 提供 `summary + acceptanceResults + evidenceRefs + residualRisks`，服务端验证每条当前 acceptance criterion 恰好有一条结果、evidence refs 属于当前 WorkItem/Operation、无 pending risk gate。事务把旧 finalResult 和 invalidated snapshot append 到 history，写新的 finalResult/hash 与 `terminalSafetySnapshot.lifecycleStatus=done,status=current`，关闭 recovery admission，恢复 `safetyStatus=safe`，保持业务 lifecycle done。

对 `resultingLifecycle=needs_attention`：只允许原 lifecycle 为 done；同样要求结构化验收结果和风险，且至少一条 acceptance result 非 pass 或 residual risk 明确阻止 done。事务把旧 finalResult/snapshot保留为历史证据，写 recovery assessment，设置 lifecycle=`needs_attention`、`safetyStatus=safe`，关闭 recovery admission，清除当前 terminal snapshot 指针，并恢复普通 Coordinator admission；它不自动创建/启动 Action。

cancelled safety restore 只允许原 lifecycle cancelled、全部安全条件成立。事务写新的 current cancelled snapshot、关闭 recovery admission、恢复 `safetyStatus=safe`，并在同一事务把规范化 `terminal_safety_restore` attempt 从 settling 置为 settled、写 `settledAt` 与 immutable terminal command result；不能改变 lifecycle 或 finalResult。

`resultingLifecycle=done` 成功写 `work_item.terminal_safety_restored`；`needs_attention` 写 `work_item.terminal_safety_reopened_for_attention`；cancelled safety restore 写独立 Event `work_item.cancelled_safety_restored`。三者都写 Conversation status、推进 WorkItem/safety revisions并刷新 lane。重复 command identity 返回原结果；旧 CoordinatorTurn、新 late evidence、重复 restore 或任一 identity/revision漂移均整笔无副作用。`terminalSafetySnapshot` 每次失效/恢复都生成新 epoch，不原地擦除旧安全历史。

### 16.4 ConversationEntry

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

### 16.5 WorkItemMessage

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

### 16.6 Action

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

### 16.7 ActionEntry

单独 append-only 表，以 `(actionId, sequence)` 唯一排序。message 和 control 共享序列。

### 16.8 EngineTurn

```js
{
  id: turnId,
  workItemId,
  actionId,
  runId,
  ordinal,
  status: 'prepared' | 'dispatching' | 'responded' | 'unknown' | 'cancelled' | 'legacy_imported',
  requestBodyRef,
  requestHash,
  actionEntryIds: [],
  dispatchCapability: 'idempotent' | 'queryable' | 'non_idempotent' | 'unknown',
  providerRequestKey: null,
  dispatchAttempt: 0,
  responseRef: null,
  responseHash: null,
  error: null,
  preparedAt,
  dispatchedAt: null,
  respondedAt: null,
  resolvedAt: null,
}
```

数据库必须保证 `(runId, ordinal)` 唯一、每个 ActionEntry 最多关联一个 EngineTurn，并以 response CAS 防止迟到 attempt 覆盖已确认结果。`requestBodyRef/requestHash` 在 `prepared` 后不可修改；dispatch 重试只能增加同一个 turn 的 attempt，不能重新归约 entries 或换 request body。`legacy_imported` 仅表示迁移来的历史事实，从未声称新系统实际 dispatch 过该请求。

### 16.9 Run

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
  operationSnapshot: {
    operationRevision,
    unresolvedEffectCount,
    unsafeExecutionCount,
    unreleasedResourceCount,
  },
  cancellation: null | {
    cancellationEpoch,
    status: 'requested' | 'acknowledged' | 'process_gone' | 'uncontrollable' | 'timed_out',
    requestedAt,
    deadlineAt,
    resolvedAt: null,
  },
  resultRef: null,
  createdAt,
  startedAt: null,
  endedAt: null,
}
```

### 16.10 RunResult

```js
{
  id,
  actionId,
  runId,
  outcome: 'completed' | 'waiting' | 'paused' | 'failed' | 'interrupted' | 'stopped' | 'cancelled',
  response,
  summary,
  evidenceRefs: [],
  findings: [],
  suggestedNextSteps: [],
  checkpointRef: null,
  operationSnapshot: {
    operationRevision,
    unresolvedEffectCount,
    unsafeExecutionCount,
    unreleasedResourceCount,
  },
  createdAt,
}
```

### 16.11 ContentRef

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

### 16.12 Event

创建、投递、claim、Run 开始、安全边界、控制、工具副作用、终态、批准、supersede、恢复和完成都写 append-only Event。

### 16.13 CancellationAttempt

CancellationAttempt 是规范化、history-preserving lifecycle 行，不嵌入 WorkItem。行内 lease/status 通过 CAS 单调更新；attempt 行本身永久保留，所有换 owner、settle、supersede 另写 append-only Event：

```js
{
  id: cancellationAttemptId,
  workItemId,
  purpose: 'initial_cancel' | 'terminal_safety_restore',
  cancellationEpoch,
  recoveryAdmissionEpoch: null,
  terminalSafetySnapshotEpoch: null,
  ownerId: null,
  ownerBootId: null,
  ownerLeaseEpoch: 0,
  dispatchFenceEpoch: 0,
  leaseExpiresAt: null,
  externalDispatchPolicy: {
    schemaVersion,
    entries: [{
      kind,
      authorityId,
      protocol,
      providerOrToolVersion,
      safetyClass: 'read_only_probe' | 'idempotent_effect' | 'authority_fenced_effect' | 'exclusive_unfenceable_effect',
      contractHash,
      supportsQuery,
      supportsStableIdempotency,
      supportsMonotonicFence,
    }],
  },
  externalDispatchPolicyHash,
  externalDispatchAdmission: {
    epoch,
    status: 'open' | 'blocked_authority_conflict',
    blockedAuthorityIds: [],
    activeConflictIds: [],
    minimumAuthorityEpochs: {},
    updatedAt,
  },
  dispatchFenceAuthorities: {
    [authorityId]: {
      dispatchFenceEpoch,
      reclaimFenceAdvanceId,
      authorityProofId,
      proofSafetyStatus: 'current' | 'stale' | 'failed',
      activeConflictIds: [],
    },
  },
  reclaimProofRef: null,
  reclaimedFromOwnerBootId: null,
  reclaimedFromOwnerLeaseEpoch: null,
  reclaimedExecutionFenceEpoch: null,
  status: 'ready' | 'active' | 'settling' | 'settled' | 'superseded',
  commandIdentity,
  sourceIdentity,
  lastHeartbeatAt: null,
  createdAt,
  updatedAt,
  sourceAcceptedResultBytes,
  sourceAcceptedResultHash,
  sourceAcceptedEventId,
  sourceAcceptedCommittedRevisions: {
    workItemRevision,
    operationRevision,
    requestRevision,
    safetyRevision,
    cancellationEpoch,
    recoveryAdmissionEpoch: null,
    terminalSafetySnapshotEpoch: null,
  },
  terminalCommandResultBytes: null,
  terminalCommandResultHash: null,
  terminalCommandEventId: null,
  terminalCommandCommittedRevisions: null | {
    workItemRevision,
    operationRevision,
    requestRevision,
    safetyRevision,
    cancellationEpoch,
    recoveryAdmissionEpoch: null,
    terminalSafetySnapshotEpoch: null,
  },
  settledAt: null,
  supersededAt: null,
}
```

数据库 DDL 必须包含 purpose-aware CHECK，而不是只依赖应用层：

```sql
CHECK (
  (purpose = 'initial_cancel'
    AND recovery_admission_epoch IS NULL
    AND terminal_safety_snapshot_epoch IS NULL)
  OR
  (purpose = 'terminal_safety_restore'
    AND recovery_admission_epoch IS NOT NULL
    AND terminal_safety_snapshot_epoch IS NOT NULL)
),
CHECK (
  (status IN ('active', 'settling')
    AND owner_id IS NOT NULL
    AND owner_boot_id IS NOT NULL
    AND lease_expires_at IS NOT NULL)
  OR
  (status IN ('ready', 'settled', 'superseded')
    AND lease_expires_at IS NULL)
),
CHECK (
  source_accepted_result_bytes IS NOT NULL
  AND source_accepted_result_hash IS NOT NULL
  AND source_accepted_event_id IS NOT NULL
  AND source_accepted_committed_revisions IS NOT NULL
),
CHECK (
  status NOT IN ('settled', 'superseded')
  OR (terminal_command_result_bytes IS NOT NULL
      AND terminal_command_result_hash IS NOT NULL
      AND terminal_command_event_id IS NOT NULL
      AND terminal_command_committed_revisions IS NOT NULL)
),
CHECK (status != 'settled' OR settled_at IS NOT NULL),
CHECK (status != 'superseded' OR superseded_at IS NOT NULL)
```

terminal result CHECK 明确同时覆盖 settled 与 superseded：supersede 是该 attempt 原 `commandIdentity` 的终态，必须持久化 canonical “attempt superseded” 响应、对应 `cancellation_attempt.superseded` Event 和 committed revisions；它不是 finalize/restore 成功结果。settled 则持久化 canonical finalize/restore 成功响应。两者都支持 command replay，但字节、Event type 和 lifecycle 结果不同。

正常执行时 status 只能由权威 mutation 单调推进 `ready → active → settling → settled`，或从 ready/active/settling 进入 superseded；历史行永不覆盖或删除。唯一恢复例外是**权威证明可接管**时的 `settling → active`：`reclaimCancellationAttempt()` 必须满足下述 expiry/exit-fence 条件，在同一 CAS 替换 owner/boot、递增 ownerLeaseEpoch、写新的 lease/heartbeat/reclaim proof，并追加 `cancellation_attempt.reclaimed` Event。仅 boot 不同、进程内 registry 缺失或普通心跳暂缺都不得倒退状态。
- `externalDispatchPolicy` 在 attempt 创建时从 tool/provider/authority registry 的版本化合同冻结，按 canonical JSON 计算 `externalDispatchPolicyHash`；hash 覆盖 schemaVersion、排序后的全部 entry 和 capability flags。重启、claim、reclaim、prepare、authorize、callback、finalize 都从该持久 payload 重算 hash并与行值比较，不能从当前配置重新分类；未知/缺失 entry按 `exclusive_unfenceable_effect`，policy payload/hash不匹配使 attempt进入 blocked recovery；
- `commandIdentity` 在创建行时冻结：`initial_cancel` 为 `${attemptId}:finalizeWorkItemCancellation:${cancellationEpoch}`，`terminal_safety_restore` 为 `${attemptId}:terminalSafetyRestore:${terminalSafetySnapshotEpoch}`；同一行永不换 identity；
- `sourceIdentity` 记录创建来源：initial cancel 使用 `stop:<workItemId>:<clientCommandId>:<cancellationEpoch>`，terminal restore 使用 `ready-event:<readyEventId>`。重复来源必须查回同一 attempt，不能生成新的 ID。

两种 purpose 共用以下 durable owner lease 协议：

- `claimCancellationAttempt(attemptId, ownerId, ownerBootId, ttl)`：锁定 ready/active 行并校验 attempt/workItem identity。所有时间读取和 expiry 计算都在同一 SQLite 写事务中使用数据库时钟 `dbNow`，调用方不能传 `now`。ready 行写 owner/boot、递增 ownerLeaseEpoch、写 `leaseExpiresAt=dbNow+ttl,status=active`。active 未过期且属于其他 owner/boot 时返回 busy；未过期且完整 owner identity 相同则幂等返回当前 claim，不推进 epoch 或 expiry，续租必须走 renew。不得创建第二个 live attempt。
- `renewCancellationAttempt(attemptId, ownerId, ownerBootId, ownerLeaseEpoch, expectedExpiresAt, ttl)`：同一 SQLite 事务取得 `dbNow`；仅当前未过期 owner 可 CAS 续租。绑定完整 attempt/owner/boot/lease epoch/old expiry，续租推进 `lastHeartbeatAt/leaseExpiresAt=dbNow+ttl`，不改变 cancellation/recovery/snapshot identity。
- Agent 新 boot 只触发 liveness/exit-proof 探测，不是抢占授权。`ownerBootId != 当前 boot`、进程内 registry 缺失、普通心跳暂缺或仅 OS PID 不存在，都不能在 lease 未过期时授权 reclaim。
- `reclaimCancellationAttempt(...)` 先锁定 attempt，重算并验证持久 `externalDispatchPolicy/hash`，再读取该 attempt 全部 unresolved `ExternalRecoveryIntent`、prepared/dispatching/unknown logical dispatch、authorized/sending/unknown send-attempt 与 ReclaimFenceAdvance。安全条件取这些对象的最强分类：只有全部**剩余 intent 与在途 send-attempt**都是 read-only 或真正同 key幂等时，SQLite `leaseExpiresAt <= dbNow` 才足以直接接管；存在 authority-fenced effect 时，必须先完成16.16节ReclaimFenceAdvance并持久化全部 required authority 新 token proof；存在任一 exclusive-unfenceable intent/send-attempt时，即使 lease 已过期也必须取得旧owner terminal exit proof和更高execution-fence proof。无法满足最强条件时reclaim返回blocked，不改变owner/lease epoch。不存在“尚未prepare所以不计入分类”的恢复动作。
- 提前接管同样要求持久 instance registry 已原子写入与旧 `ownerId + ownerBootId + ownerLeaseEpoch` 精确匹配的 terminal exit proof，并且 execution fence subsystem 已证明旧 owner 的外发能力被更高 fence epoch撤销。接管必须保存 `reclaimProofRef + reclaimedFromOwnerBootId + reclaimedFromOwnerLeaseEpoch + reclaimedExecutionFenceEpoch`；authority-fenced分类还保存外部 fence proof/token。attempt CAS同时验证proof、当前旧owner identity和全部dispatch policy snapshot。
- reclaim 复用原 attempt ID，替换owner/boot、递增ownerLeaseEpoch与`dispatchFenceEpoch`并回到active。旧owner之后的renew/finalize/callback因attempt lease/fence epoch stale而拒绝；旧owner尝试新dispatch时也必须在16.15节授权事务失败。任何接管前已发出的外部动作仍进入Operation审计/reconciliation，不能当作未发生。
- settling 只有在同一事务即将调用 finalize/restore时短暂存在；正常事务失败整笔 rollback为active。若数据库因崩溃留下 settling行，启动扫描仍须满足数据库 lease过期或完整 exit+execution-fence proof，不能仅因boot不同直接reclaim。
- 所有 finalize/restore caller 校验 `attemptId + purpose + ownerId + ownerBootId + ownerLeaseEpoch + dispatchFenceEpoch + externalDispatchPolicyHash + leaseExpiresAt > dbNow + status=settling + commandIdentity`，并确认没有 status=required/prepared 的 intent、没有 `authorized/sending/unknown` send-attempt、没有 `prepared/dispatching/unknown` logical dispatch/fence advance，也没有未解决 callback/reconciliation conflict。`reconciled` send-attempt 是保留完整审计证据的 non-blocking terminal state；只有 16.15 节统一事务和逐 sibling proof 才能写入。read-only intent 也必须先 satisfied/cancelled；不能因“无副作用”跳过完成证据。旧owner、旧boot、旧dispatch fence/policy、旧lease epoch、过期lease和已settled/superseded行均无副作用。

SQLite partial unique：

```sql
CREATE UNIQUE INDEX cancellation_attempt_one_live_per_work_item
ON cancellation_attempts(work_item_id)
WHERE status IN ('ready', 'active', 'settling');

CREATE UNIQUE INDEX cancellation_attempt_initial_live
ON cancellation_attempts(work_item_id, purpose, cancellation_epoch)
WHERE purpose = 'initial_cancel' AND status IN ('ready', 'active', 'settling');

CREATE UNIQUE INDEX cancellation_attempt_restore_live
ON cancellation_attempts(work_item_id, purpose, recovery_admission_epoch, terminal_safety_snapshot_epoch)
WHERE purpose = 'terminal_safety_restore' AND status IN ('ready', 'active', 'settling');

CREATE UNIQUE INDEX cancellation_attempt_command_identity
ON cancellation_attempts(command_identity);

CREATE UNIQUE INDEX cancellation_attempt_source_identity
ON cancellation_attempts(source_identity);
```

WorkItem 不保存冗余 current-attempt pointer。当前 attempt 由 `cancellation_attempt_one_live_per_work_item` 保护的 live 行权威派生：`SELECT ... WHERE work_item_id=? AND status IN ('ready','active','settling')` 最多返回一行。claim/finalize/restore 全部锁定该规范化行并校验 `attempt.workItemId`，不存在跨 WorkItem pointer 或 pointer 指向 terminal 行的状态空间。

创建流程在同一 `BEGIN IMMEDIATE` 中锁定 WorkItem 与 natural/source identity：若 sourceIdentity 已存在，无论行处于 live 还是 terminal，都返回该行的 immutable `sourceAcceptedResultBytes`，不创建新行、不改变状态；否则先把旧 live 行置为 superseded、写其 canonical superseded command result并清除活动 lease (`leaseExpiresAt`)，保留最后 owner/boot/lease epoch/heartbeat作为审计事实，再插入新 ready 行。新行插入时即把 Stop/ready-event 的受理响应序列化为 canonical UTF-8 JSON bytes，原子写 `sourceAcceptedResultBytes/hash/eventId/committedRevisions`。这个顺序保证 general/purpose partial unique 从不瞬时冲突。

`sourceIdentity` 与 `commandIdentity` 是两个不同的幂等命名空间：source replay 返回“请求/ready event 已受理并对应 attempt X”的原始响应；terminal command replay 返回 finalize/restore/supersede 的原始终态响应，二者不得共用字节。settled 或 superseded transition 必须在更新 WorkItem/Conversation/Event 的同一 SQLite 事务内，把命令响应序列化一次并写 `terminalCommandResultBytes/hash/eventId/committedRevisions`。事务提交后，source replay 逐字节返回 source snapshot，command replay 逐字节返回 terminal snapshot；两者都先校验 SHA-256，绝不从当前 WorkItem/terminal snapshot/lane重建。后续 late evidence、安全失效或 lifecycle变化不得改写任一结果字段。settled/superseded行永久保留，用于字节级幂等、旧caller拒绝、事故审计和迁移验证。

### 16.14 TerminalSafetyReadyEvent

terminal safety ready 不是无状态通知，而是持久 mailbox/control event：

```js
{
  id,
  workItemId,
  type: 'terminal_safety_ready_for_restore' | 'cancelled_safety_ready_for_terminalizer',
  recoveryAdmissionEpoch,
  terminalSafetySnapshotEpoch,
  operationSafetyHash,
  status: 'pending' | 'claimed' | 'consumed' | 'superseded',
  claimedById: null,
  claimedByBootId: null,
  claimLeaseEpoch: 0,
  claimExpiresAt: null,
  supersededByEventId: null,
  createdAt,
  consumedAt: null,
  supersededAt: null,
}
```

同一 `(workItemId,recoveryAdmissionEpoch,terminalSafetySnapshotEpoch,type)` 最多一个 pending/claimed event，并以 SQLite partial unique index强制。`enqueueTerminalSafetyReadyIfEligible()` 在写 H2 事件前，必须把同 WorkItem/recovery epoch/type 下 identity/hash 不匹配的 H1 pending/claimed event 置为 superseded，失效其 claim/CoordinatorTurn，并记录 `supersededByEventId`；随后创建或幂等复用 H2。restore 只把自己 claim 的 event 置为 consumed，superseded event 不算“未处理 recovery mailbox event”，不能阻塞新 restore。Agent 启动扫描回收过期 claimed event：若 identity 仍 current则复用同一 event ID、递增 claimLeaseEpoch并重新 claim；若已 stale则 supersede后由 helper重建。

```sql
CREATE UNIQUE INDEX terminal_safety_ready_live
ON terminal_safety_ready_events(work_item_id, recovery_admission_epoch, terminal_safety_snapshot_epoch, type)
WHERE status IN ('pending', 'claimed');
```

### 16.15 ExternalRecoveryIntent、Dispatch 与 SendAttempt

所有 cancellation probe、provider/tool/task cancel、watchdog 探测、authority closure、grant/credential revoke、lease/resource release 和补偿性 recovery 调用，都必须先注册持久 `ExternalRecoveryIntent`，再创建/复用一个 logical `ExternalRecoveryDispatch`；每次实际外发则创建不可变、append-only 的 `ExternalRecoverySendAttempt`。adapter、watchdog 和 task manager 不得绕过这三层直接外发。唯一例外是 16.16 节 `ReclaimFenceAdvance`，它只能推进 authority fencing token，不能携带业务恢复请求；其每次外发同样使用 `ExternalRecoverySendAttempt`。

```js
{
  id: intentId,
  workItemId,
  cancellationAttemptId,
  operationId: null,
  runId: null,
  taskId: null,
  kind,
  semanticTargetHash,
  safetyClass: 'read_only_probe' | 'idempotent_effect' | 'authority_fenced_effect' | 'exclusive_unfenceable_effect',
  authorityId,
  authorityContractHash,
  externalDispatchPolicyHash,
  status: 'required' | 'prepared' | 'satisfied' | 'cancelled' | 'superseded',
  sourceIdentity,
  createdAt,
  resolvedAt: null,
}

{
  id: dispatchId,
  intentId,
  workItemId,
  cancellationAttemptId,
  attemptPurpose: 'initial_cancel' | 'terminal_safety_restore',
  preparedByOwnerId,
  preparedByOwnerBootId,
  preparedByOwnerLeaseEpoch,
  preparedAtDispatchFenceEpoch,
  operationId: null,
  runId: null,
  taskId: null,
  kind,
  safetyClass: 'read_only_probe' | 'idempotent_effect' | 'authority_fenced_effect' | 'exclusive_unfenceable_effect',
  authorityId,
  authorityContractHash,
  authorityFenceToken: null,
  authorityFenceProofRef: null,
  idempotencyKey,
  requestBytes,
  requestHash,
  semanticTargetHash,
  aggregateStatus: 'prepared' | 'dispatching' | 'confirmed' | 'failed' | 'unknown' | 'superseded',
  nextAttemptNumber,
  confirmedAttemptId: null,
  confirmationProofRef: null,
  externalEffectRef: null,
  preparedAt,
  resolvedAt: null,
}

{
  id: sendAttemptId,
  dispatchId: null,
  fenceAdvanceId: null,
  attemptNumber,
  ownerId,
  ownerBootId,
  ownerLeaseEpoch,
  dispatchFenceEpoch,
  externalDispatchAdmissionEpoch,
  envelopeBytes,
  envelopeHash,
  requestHash,
  authorityContractHash,
  idempotencyKey,
  authorityFenceToken: null,
  status: 'authorized' | 'sending' | 'confirmed' | 'failed' | 'unknown' | 'superseded' | 'reconciled',
  callbackIdentity: null,
  responseBytes: null,
  responseHash: null,
  externalEffectRef: null,
  reconciledByKind: null | 'send_attempt' | 'authority_query',
  reconciledBySendAttemptId: null,
  reconciledByAuthorityProofId: null,
  reconciliationProofRef: null,
  reconciliationEventId: null,
  authorizedAt,
  sentAt: null,
  resolvedAt: null,
  reconciledAt: null,
}
```

#### ExternalRecoveryAuthorityProof

Authority proof 是独立、不可变、可失效的持久对象，不能只存一个文件引用：

```js
{
  id: authorityProofId,
  workItemId,
  cancellationAttemptId,
  logicalType: 'dispatch' | 'fence_advance',
  logicalId,
  authorityId,
  authorityEpoch,
  proofKind: 'confirmed_send' | 'authority_query' | 'operator_isolation' | 'stronger_authority_epoch_fence',
  sourceSendAttemptId: null,
  queryIdentity: null | {
    controlPlaneId,
    credentialGeneration,
    requestHash,
    responseHash,
    callbackIdentity,
  },
  proofHash,
  proofPayloadRef,
  proofEventId,
  requestHash,
  idempotencyKey,
  semanticTargetHash,
  authorityContractHash,
  confirmedFenceToken: null,
  externalEffectIdentity,
  coveredSiblingIds: [],
  status: 'current' | 'stale' | 'superseded',
  revision,
  createdAt,
  staleAt: null,
  staleEventId: null,
  supersededAt: null,
}
```

proof payload/hash、authority epoch、logical identity、query identity 和 covered sibling 集在创建后不可修改；失效只能把 status 单调写为 stale/superseded、推进 revision 并追加 `staleEventId`。`confirmed_send` 必须设置 `sourceSendAttemptId`，引用同 logical row 的 confirmed send-attempt，且 `queryIdentity=null`；其他 proof kind 必须 `sourceSendAttemptId=null`。`authority_query` 必须保存独立 control-plane request/response、credential generation、authority epoch 和 callback identity；operator isolation 与 stronger fence proof 必须绑定隔离或新 authority epoch 的可验证外部事实和 `proofEventId`。普通业务 callback 或同一被质疑 authority 的普通 success 不能伪装成 authority query。

#### ExternalRecoveryReconciliationConflict

External dispatch conflict 使用跨 Operation/Run/Task/fence-advance 的通用 SSOT：

```js
{
  id: conflictId,
  stableIdentityHash,
  workItemId,
  cancellationAttemptId,
  logicalType: 'dispatch' | 'fence_advance',
  logicalId,
  operationId: null,
  runId: null,
  taskId: null,
  authorityId,
  kind: 'evidence_gap' | 'authority_contract_violation',
  status: 'pending' | 'resolved' | 'superseded',
  siblingIds: [],
  callbackEvidenceIds: [],
  authorityProofIds: [],
  revision,
  workItemRevision,
  safetyRevision,
  externalDispatchAdmissionEpoch,
  eventId,
  createdAt,
  resolvedByProofId: null,
  resolutionKind: null | 'matching_confirmed_attempt' | 'independent_authority_query' | 'operator_isolation' | 'stronger_authority_epoch_fence',
  resolvedEventId: null,
  resolutionProofHash: null,
  resolvedAt: null,
  supersededEventId: null,
  supersededAt: null,
}
```

`stableIdentityHash = hash(workItemId + attemptId + logicalType + logicalId + authorityId + kind + originatingCallbackOrProofIdentity)`。稳定 identity 只绑定最初证明矛盾的 callback/proof，不包含之后不断增长的 evidence 集，避免每次追加证据都生成第二条 active conflict。后续 sibling/callback/proof 存规范化子行，并分别以 `(conflictId,siblingId)`、`(conflictId,callbackEvidenceId)`、`(conflictId,authorityProofId)` 唯一。数据库 partial unique 保证同一 stable identity 最多一条 pending conflict。Conflict 的 `revision + externalDispatchAdmissionEpoch` 是所有 resolve/send gate 的 optimistic fence；Event 是审计，不替代 conflict SSOT。

```sql
CREATE UNIQUE INDEX external_recovery_authority_proof_identity
ON external_recovery_authority_proofs(authority_id, authority_epoch, proof_hash);

CREATE UNIQUE INDEX external_recovery_authority_query_identity
ON external_recovery_authority_proofs(authority_id, authority_epoch, json_extract(query_identity, '$.controlPlaneId'), json_extract(query_identity, '$.requestHash'), json_extract(query_identity, '$.responseHash'))
WHERE proof_kind = 'authority_query';

CHECK (
  (proof_kind = 'confirmed_send'
    AND source_send_attempt_id IS NOT NULL
    AND query_identity IS NULL)
  OR
  (proof_kind = 'authority_query'
    AND source_send_attempt_id IS NULL
    AND query_identity IS NOT NULL)
  OR
  (proof_kind IN ('operator_isolation', 'stronger_authority_epoch_fence')
    AND source_send_attempt_id IS NULL
    AND query_identity IS NULL)
),
CHECK (
  (proof_kind IN ('confirmed_send', 'authority_query')
    AND request_hash IS NOT NULL
    AND idempotency_key IS NOT NULL
    AND semantic_target_hash IS NOT NULL
    AND authority_contract_hash IS NOT NULL
    AND external_effect_identity IS NOT NULL)
  OR
  (proof_kind IN ('operator_isolation', 'stronger_authority_epoch_fence')
    AND proof_event_id IS NOT NULL)
),
CHECK (
  proof_kind != 'stronger_authority_epoch_fence'
  OR confirmed_fence_token IS NOT NULL
);

CREATE UNIQUE INDEX external_recovery_conflict_active
ON external_recovery_reconciliation_conflicts(stable_identity_hash)
WHERE status = 'pending';

CREATE UNIQUE INDEX external_recovery_conflict_sibling
ON external_recovery_conflict_siblings(conflict_id, sibling_id);

CREATE UNIQUE INDEX external_recovery_conflict_callback
ON external_recovery_conflict_callbacks(conflict_id, callback_evidence_id);

CREATE UNIQUE INDEX external_recovery_conflict_proof
ON external_recovery_conflict_proofs(conflict_id, authority_proof_id);

CHECK (
  (status = 'pending'
    AND resolved_by_proof_id IS NULL
    AND resolution_kind IS NULL
    AND resolution_proof_hash IS NULL
    AND resolved_event_id IS NULL
    AND resolved_at IS NULL
    AND superseded_event_id IS NULL
    AND superseded_at IS NULL)
  OR
  (status = 'resolved'
    AND resolved_by_proof_id IS NOT NULL
    AND resolution_kind IS NOT NULL
    AND resolution_proof_hash IS NOT NULL
    AND resolved_event_id IS NOT NULL
    AND resolved_at IS NOT NULL
    AND superseded_event_id IS NULL
    AND superseded_at IS NULL)
  OR
  (status = 'superseded'
    AND superseded_event_id IS NOT NULL
    AND superseded_at IS NOT NULL)
);
```

Conflict 的解除 proof 通过窄权限 conflict-resolution control plane 导入：独立只读 authority query 使用与被质疑业务调用隔离的 endpoint/credential 或 authority 管理 API；operator isolation 与 stronger epoch fence 由相应 authority/安全控制面签名。该控制面只能创建/验证 `ExternalRecoveryAuthorityProof`，不能 prepare/authorize/send 普通 ExternalRecoveryDispatch，也不能直接改 logical/intent/attempt；所有状态变化仍由统一 reconciliation/conflict mutation 提交。

`authority_contract_violation` 一旦创建，必须在同一个 `BEGIN IMMEDIATE` 中调用 `blockExternalDispatchForAuthority()`：锁定 CancellationAttempt、相关 Conflict/Proof、该 authority 的所有 logical dispatch/fence advance 和可选 Operation/Run/Task；把 `externalDispatchAdmission.status` 写为 `blocked_authority_conflict`，递增 admission epoch，加入 authority/conflict ID，记录 `minimumAuthorityEpochs[authorityId]`；所有关联 AuthorityProof 置 stale，confirmed ReclaimFenceAdvance 的 `proofSafetyStatus` 置 stale，并加入 `activeConflictIds`。若该 proof 已被 `consumedByAttemptDispatchFenceEpoch` 消费，则同步把 `CancellationAttempt.dispatchFenceAuthorities[authorityId].proofSafetyStatus` 置 stale、加入 conflict ID，并把该 authority 下所有 `prepared/authorized` 普通 dispatch/send-attempt 置 superseded；已经 sending/unknown 的行保留为证据并进入 conflict sibling 集。关联 Operation 转 hazardous/quarantine并推进 WorkItem safety revision；无 Operation 的 Run/Task/fence-advance 仍由通用 Conflict + attempt admission 阻塞。**不回退 owner 或 dispatchFenceEpoch**，但从该事务提交起禁止任何新的外部恢复发送。

`ExternalRecoverySendAttempt` 必须用 SQL CHECK 保证 `dispatch_id` 与 `fence_advance_id` 恰有一个非空；`(dispatch_id,attempt_number)` 和 `(fence_advance_id,attempt_number)` 分别 partial unique。owner/boot/lease/fence、envelope bytes/hash、request/contract/key/token 在插入后不可修改；状态和 callback/result 只能由绑定该 attempt ID 的 CAS 推进。logical dispatch 的 owner字段只记录 prepared-by 历史，reclaim 后不改写；旧、新 owner 的 envelope 永远落在不同 send-attempt 行。

数据库还必须强制 reconciliation terminal identity：

```sql
CHECK (
  status != 'reconciled'
  OR (
    reconciled_by_kind IN ('send_attempt', 'authority_query')
    AND (
      (reconciled_by_kind = 'send_attempt'
        AND reconciled_by_send_attempt_id IS NOT NULL
        AND reconciled_by_authority_proof_id IS NULL)
      OR
      (reconciled_by_kind = 'authority_query'
        AND reconciled_by_send_attempt_id IS NULL
        AND reconciled_by_authority_proof_id IS NOT NULL)
    )
    AND reconciliation_proof_ref IS NOT NULL
    AND reconciliation_event_id IS NOT NULL
    AND reconciled_at IS NOT NULL
  )
)
```

`authorized/sending/unknown → reconciled` 只能由 `reconcileExternalRecoveryLogicalResult()` 写入。send-attempt 来源必须写 `reconciledByKind=send_attempt`；query-only 路径必须先持久化 `ExternalRecoveryAuthorityProof(proofKind=authority_query)`，再写 `reconciledByKind=authority_query`。普通 callback、adapter 和清理任务不能直接写 reconciled。logical aggregate 的 `confirmed → unknown` 与 intent 的 `satisfied → prepared` 不是一般重试状态转换；只允许同一 reconciliation 事务在迟到 evidence 与既有 proof 冲突时执行，并必须创建/更新规范化 conflict、推进 WorkItem/attempt/safety revisions。Conflict/Event/proof 都必须可挂在无 Operation 的 Run/Task/fence-advance 上。

分类来自 CancellationAttempt 的持久 `externalDispatchPolicy`；按 `kind + authorityId + protocol/model/tool version` 找到冻结entry并复制其`contractHash`为`authorityContractHash`。运行期adapter不能读取当前配置后重新分类，也不能自行把未知操作降级为“幂等”或“只读”。默认分类是最保守的`exclusive_unfenceable_effect`：

1. `read_only_probe`：外部合同保证不改变受保护状态。允许旧/新 owner 重复发送同一 frozen request；结果仍须按 dispatch/attempt epoch CAS，只能作为 evidence，不能直接覆盖新 owner 的权威状态。
2. `idempotent_effect`：authority 明确保证同一 `idempotencyKey` 永久绑定同一 `requestHash + semanticTargetHash`，重复调用返回同一外部 effect/result；同 key 不同 bytes/target 必须被 authority 拒绝。reclaim 后只能复用已有 prepared/dispatching/unknown 行、key 和 request bytes，不能创建不同 key 重新表达同一动作。
3. `authority_fenced_effect`：authority 强制校验单调 `dispatchFenceEpoch` token，并拒绝低于已激活 epoch 的请求。reclaim 必须先通过稳定 fence-advance key让 authority 原子提高 token，再将 proof CAS 回 attempt；只有 proof 持久化后才能切换 DB owner。旧 owner 即使持有已 prepared envelope，发送时也会被 authority 拒绝。
4. `exclusive_unfenceable_effect`：外部动作会改变状态，但 authority 不提供同 key 幂等或单调 fence。普通 lease expiry 不授予新 owner并发执行权；reclaim 前必须取得旧 owner terminal exit proof，并由 execution-fence subsystem证明旧进程、credential、socket/IPC和外发能力已撤销。无法证明时 attempt 保持原 owner/进入 blocked recovery，Operation 标记 hazardous_orphan，不允许新 owner发送该类动作。

每个 intent 的 source identity 与每个 dispatch 的 logical identity 对 `(attemptId, kind, operation/run/task identity, semantic target)` 稳定；即使 read-only 也必须有 idempotency key 以便审计和 callback 去重。未来动作必须先注册 intent：Stop/Run/Operation/release-set mutation 在知道某项恢复动作可能需要外发时，于同一事务插入/查回 intent。`prepareExternalRecoveryDispatch()` 只能消费当前 owner 下 status=required/prepared 的匹配 intent；任何未登记的外发一律拒绝并记录 policy violation。这样 reclaim 能评估**尚未创建 dispatch 的剩余动作**，而不只扫描在途网络请求。

数据库唯一约束：

```sql
CREATE UNIQUE INDEX external_recovery_intent_source
ON external_recovery_intents(cancellation_attempt_id, source_identity);

CREATE UNIQUE INDEX external_recovery_intent_identity
ON external_recovery_intents(cancellation_attempt_id, kind, operation_key, run_key, task_key, semantic_target_hash);

CREATE UNIQUE INDEX external_recovery_dispatch_key
ON external_recovery_dispatches(authority_id, idempotency_key);

CREATE UNIQUE INDEX external_recovery_dispatch_identity
ON external_recovery_dispatches(intent_id);

CREATE UNIQUE INDEX external_recovery_send_attempt_dispatch
ON external_recovery_send_attempts(dispatch_id, attempt_number)
WHERE dispatch_id IS NOT NULL;

CREATE UNIQUE INDEX external_recovery_send_attempt_fence
ON external_recovery_send_attempts(fence_advance_id, attempt_number)
WHERE fence_advance_id IS NOT NULL;
```

operation/run/task identity 使用 NOT NULL 规范化 key 或生成列参与唯一性，不能依赖 SQLite `NULL != NULL` 留出重复行。intent 的 kind/target/classification/policy hash 在插入后不可修改；logical dispatch 的 request bytes/hash/safetyClass/authorityContractHash/idempotencyKey/semanticTargetHash 在 prepared 后不可修改。重试不修改 logical dispatch 的 prepared-by 身份，而是插入下一个 append-only send-attempt。

每次准备和发送外部恢复调用都经过两阶段持久授权：

1. `prepareExternalRecoveryDispatch()` 在 `BEGIN IMMEDIATE` 中锁定 WorkItem、唯一 live CancellationAttempt、匹配 `ExternalRecoveryIntent`、Operation/Run/Task 和 logical dispatch identity。它校验 `attemptId + purpose + ownerId + ownerBootId + ownerLeaseEpoch + leaseExpiresAt > dbNow + dispatchFenceEpoch + externalDispatchPolicyHash + externalDispatchAdmission.epoch/status`，并查询该 authority 的 pending `ExternalRecoveryReconciliationConflict`。admission 不是 open、authority 被 blocked、存在 pending authority-contract conflict、或关联 consumed fence proof 为 stale/failed时，一律拒绝且无副作用。通过后确认 intent 仍 required/prepared 且 policy identity匹配，按 frozen policy 得到 safetyClass，冻结 request bytes/hash、semantic target、authority contract、key/token并插入或查回同一 logical dispatch；intent推进prepared。旧owner、过期lease、旧policy/fence/admission epoch、未登记intent或same key/different request一律无副作用。
2. `authorizeExternalRecoverySend()` 紧邻 adapter/authority send执行，在新的 SQLite写事务再次锁定live attempt、intent、logical dispatch、admission与该authority active conflicts，重复上述owner/lease/purpose/fence/policy/admission校验。它分配`nextAttemptNumber`，插入不可变`ExternalRecoverySendAttempt`，其envelope包含dispatch/send-attempt ID、owner/boot/lease epoch、dispatch fence、admission epoch、request/hash/key/token；logical aggregate推进dispatching。事务返回该持久envelope；调用方只能逐字节发送它，不能在事务后重构或修改。retry/unknown恢复总是创建新send-attempt行，旧行保留。
3. send前若进程暂停，恢复后不得直接发送内存envelope；必须重新读取send-attempt并调用`beginExternalRecoveryNetworkSend(sendAttemptId, owner identity...)`。该CAS再次锁定attempt admission、active conflicts与关联fence proof，校验live attempt lease/fence/policy/admission epoch及send-attempt status=authorized；任一 unresolved authority conflict、blocked admission或stale/failed consumed fence proof都拒绝发送。通过后置为sending并返回持久bytes。若lease/fence/admission已换代则将旧send-attempt标记superseded，不发送。

数据库检查不能消除“授权事务提交后、网络 send 前进程暂停”的窗口，因此安全性由 frozen safetyClass 补齐：read-only重复无副作用；idempotent effect即使旧/new owner都发送也由authority同key同bytes收敛为同一effect；authority-fenced effect由外部token拒绝旧envelope；exclusive-unfenceable effect禁止仅凭expiry产生新owner，所以旧envelope与新owner永不并存。任何 adapter/authority 不满足其声明合同时，记录policy violation、把相关Operation转hazardous_orphan并阻止后续自动恢复。

callback/result 先按 `sendAttemptId + dispatchId/fenceAdvanceId + attemptNumber + envelopeHash + requestHash + authorityContractHash + idempotencyKey + callbackIdentity` 幂等写对应 send-attempt 行，随后调用普通 dispatch 与 fence advance 共用的 `reconcileExternalRecoveryLogicalResult()`；callback 不能自行推进 logical aggregate、intent、Run、Operation 或 WorkItem 投影。

`reconcileExternalRecoveryLogicalResult({ logicalType, logicalId, source, coveredSiblingIds })` 在单一 `BEGIN IMMEDIATE` 中锁定 WorkItem、CancellationAttempt、intent（普通 dispatch）、logical row、全部 sibling send-attempt、AuthorityProof、active Conflict及Event identity。`source` 是 tagged union：

```js
source = {
  kind: 'send_attempt',
  confirmedSendAttemptId,
} | {
  kind: 'authority_query',
  authorityProofId,
}
```

send-attempt source 必须属于同一 logical row 且 status=confirmed；事务创建/查回 `AuthorityProof(proofKind=confirmed_send)`。query source 必须引用 current `AuthorityProof(proofKind=authority_query)`，不能伪造 send-attempt ID。随后逐个验证 `coveredSiblingIds`：

- 普通 read-only/idempotent sibling 必须与 logical row 具有相同 `requestHash + idempotencyKey + semanticTargetHash + authorityContractHash`；authority proof还必须明确列出外部effect/result identity及覆盖的send-attempt ID。same key/different bytes/target、different key或不同contract绝不覆盖。
- authority-fenced sibling 必须属于同一 logical target/contract/key，且其 token 小于等于 proof 已激活的 confirmed token；proof 必须证明所有低 token 请求被拒绝，或确认同一 target/effect 已由该 token 唯一收敛。
- exclusive-unfenceable sibling不能由普通 confirmed send覆盖；只有 independent authority query proof能把该 sibling的request/callback identity与已确认的同一external effect逐一对应。
- 每个被覆盖 sibling 的 immutable envelope、callback、response、externalEffectRef保持原样；事务只把 `authorized/sending/unknown` CAS为`reconciled`。send source写`reconciledByKind=send_attempt/reconciledBySendAttemptId`；query source写`reconciledByKind=authority_query/reconciledByAuthorityProofId`；两者都写proof/Event/time。`confirmed/failed/superseded/reconciled` sibling不被重写。

如果所有 `authorized/sending/unknown` sibling 都被 proof 覆盖，且此前 reconciled proof仍current、没有pending Conflict，事务才可原子把logical aggregate置confirmed、写confirmed attempt/proof、intent置satisfied，并写`external_recovery.logical_reconciled` Event、推进revisions。若任一 sibling未覆盖，已覆盖项可reconciled，但logical保持unknown、intent保持prepared；事务按稳定identity创建/更新`kind=evidence_gap,status=pending` Conflict及子行，未覆盖项继续blocking。部分proof不能把logical冒充confirmed。后续proof可与未失效历史逐-sibling proof取并集，但必须重验每份proof与全部callback evidence。

迟到callback到达reconciled sibling时，先追加不可变evidence并重验proof：

- 仅缺callback/证据、且没有证明authority合同失效时，创建/更新`evidence_gap`；它可由matching confirmed send或independent query解除。
- 已认证callback证明same key出现不同effect、same token/低token被接受、或与authority proof矛盾时，创建/更新`authority_contract_violation`。同一事务把相关AuthorityProof置stale，把logical/intent降回unknown/prepared，标记Operation hazardous/quarantine，并调用`blockExternalDispatchForAuthority()`；普通confirmed send不能解除。

`resolveExternalRecoveryConflict()`锁定Conflict、proof、attempt admission、关联ReclaimFenceAdvance及全部logical/sibling，并校验 conflict revision、admission epoch、owner lease/fence和WorkItem safety revision。`evidence_gap`可由matching confirmed-send proof或independent query解决；`authority_contract_violation`绝不接受`proofKind=confirmed_send`，只能使用current `authority_query`、`operator_isolation`或`stronger_authority_epoch_fence`。authority query必须来自独立control plane/credential generation；operator isolation必须证明旧执行与外发能力已隔离；stronger fence proof必须具有高于`minimumAuthorityEpochs[authorityId]`的authority epoch/token，并证明所有低token请求被拒绝。

成功事务写`resolvedByProofId/resolutionKind/resolutionProofHash/resolvedEventId/resolvedAt`，消费对应HumanRequest，并重验所有proof/sibling。若冲突涉及已confirmed或已被attempt消费的ReclaimFenceAdvance，只有独立query或更强fence proof可把`proofSafetyStatus`从stale/failed写回current，并更新`authorityProofRef/confirmationProofRef`；普通confirmed send不得恢复。只有该authority没有其他pending contract-violation、所有被消费fence proof重新current、minimum authority epoch满足、相关Operation不再hazardous/quarantine且全部conflict proof current，才能递增admission epoch、移除conflict并重新open发送。状态恢复、admission reopen、Conflict resolved、HumanRequest消费和Event写入同一事务；重复/崩溃重放由Conflict stable identity、proof identity和Event identity幂等。

### 16.16 ReclaimFenceAdvance

`authority_fenced_effect` 的 token advance 不能要求当前 attempt owner lease，否则 lease 到期后的 reclaim 会循环依赖。它使用独立、窄权限、持久控制面对象；该对象只能把某个 authority 的 attempt fence 从旧 epoch推进到预定新 epoch，不能包含 provider/tool cancel、probe、release、revoke 或其他业务 payload：

```js
{
  id: fenceAdvanceId,
  cancellationAttemptId,
  workItemId,
  authorityId,
  authorityContractHash,
  expectedOwnerId,
  expectedOwnerBootId,
  expectedOwnerLeaseEpoch,
  expectedDispatchFenceEpoch,
  expectedExternalDispatchAdmissionEpoch,
  targetDispatchFenceEpoch,
  requestBytes,
  requestHash,
  idempotencyKey,
  aggregateStatus: 'prepared' | 'dispatching' | 'confirmed' | 'failed' | 'unknown' | 'superseded',
  nextAttemptNumber,
  confirmedSendAttemptId: null,
  confirmationProofRef: null,
  authorityProofRef: null,
  proofSafetyStatus: 'unproven' | 'current' | 'stale' | 'failed',
  consumedByAttemptDispatchFenceEpoch: null,
  activeConflictIds: [],
  preparedAt,
  resolvedAt: null,
}
```

稳定唯一键为 `(cancellationAttemptId, authorityId, targetDispatchFenceEpoch)`；request bytes/hash/idempotency key在prepared后不可改。target必须严格等于`expectedDispatchFenceEpoch + 1`。

```sql
CREATE UNIQUE INDEX reclaim_fence_advance_identity
ON reclaim_fence_advances(cancellation_attempt_id, authority_id, target_dispatch_fence_epoch);

CREATE UNIQUE INDEX reclaim_fence_advance_key
ON reclaim_fence_advances(authority_id, idempotency_key);
```

同一 attempt/authority 最多一个 aggregateStatus 为 `prepared/dispatching/unknown` 的 live advance，并以 partial unique 强制；创建新 target前必须确认旧 target已confirmed或superseded。

```sql
CREATE UNIQUE INDEX reclaim_fence_advance_live
ON reclaim_fence_advances(cancellation_attempt_id, authority_id)
WHERE aggregate_status IN ('prepared', 'dispatching', 'unknown');
```

`prepareReclaimFenceAdvance()` 在 SQLite `BEGIN IMMEDIATE` 中锁定 attempt，确认 lease 已过期或存在匹配旧 owner/boot/lease epoch的 terminal exit proof，重算冻结 dispatch policy，确认该 authority 的所有相关 dispatch都声明并实际支持 monotonic fence；随后冻结只含 fence advance 的request。它不切换owner，不修改attempt fence epoch。

`sendReclaimFenceAdvance()` 不需要旧 owner lease，但必须重新锁定 attempt 和 advance logical row，确认 attempt owner/boot/lease/fence 仍等于 expected、lease 仍已过期或 exit proof 仍 current、没有别的 live advance、目标 authority contract/hash 一致；随后分配 nextAttemptNumber并插入 append-only `ExternalRecoverySendAttempt(fenceAdvanceId=...)`。它**不能**调用普通 `beginExternalRecoveryNetworkSend()`，因为后者要求当前 owner lease。

fence advance 使用专用 `beginReclaimFenceAdvanceNetworkSend(sendAttemptId, controllerId, controllerBootId)`。该窄权限 CAS 不要求 attempt owner lease，但必须验证：send-attempt 只绑定 fenceAdvanceId；advance/attempt/workItem identity 完整；expected old owner/boot/lease epoch 与 attempt 当前行一致；`leaseExpiresAt <= dbNow` 或匹配的 terminal exit proof 仍有效；expected/target dispatch fence 分别等于 attempt 当前 epoch 和 `current+1`；policy hash与 authority contract 重算一致；request 只含 authority/token/target epoch，不含 provider/tool cancel、probe、release、revoke或任意业务 payload；status=authorized。它还必须锁定attempt admission、该authority active conflicts和当前advance proof：admission blocked、存在pending authority-contract conflict、proofSafetyStatus为stale/failed或minimumAuthorityEpoch未满足时拒绝发送。CAS将send-attempt置为sending并返回持久 envelope bytes。controllerId/boot只作审计，不能改变attempt owner或获得普通recovery dispatch权限。

authority合同必须保证同idempotency key+target epoch重复调用幂等，且一旦target激活便拒绝所有低epoch请求。多个 Controller/Watcher 可因崩溃重试同一 advance，但只能创建递增的 send-attempt，全部 envelope 保持同 request/key/target；authority 收敛为同一 token。回调先终结对应send-attempt；`confirmReclaimFenceAdvance()`查询/验证authority proof后，必须调用同一个 `reconcileExternalRecoveryLogicalResult(logicalType='fence_advance', ...)`。只有proof逐个覆盖同一advance下全部`authorized/sending/unknown` sibling时，事务才把advance aggregate置confirmed、写confirmedSendAttemptId/confirmationProofRef，并将其他covered sibling置reconciled；未覆盖 sibling继续blocking且advance保持unknown。多个required authority分别推进；任一advance failed/unknown或存在未reconciled sibling时reclaim保持blocked。

只有所有涉及`authority_fenced_effect`的required authority都confirmed同一target epoch、没有exclusive-unfenceable阻塞，`reclaimCancellationAttempt()` 才能在同一SQLite事务验证proof集合、把attempt `dispatchFenceEpoch`推进到target、替换owner/boot并递增ownerLeaseEpoch。旧owner准备过的普通ExternalRecoveryDispatch因外部authority低token被拒绝；advance对象本身不能被adapter解释成业务dispatch。进程在authority成功与本地proof落盘之间崩溃时，恢复器按稳定key查询同一advance，不创建新target或不同key。

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
5. 冻结 provider request body/hash，并创建唯一 `prepared` EngineTurn；
6. 将可投递 messages 以 entry IDs 绑定到该 turn，entries 置为 `bound`；
7. 写 checkpoint 和 claimed high watermark，但不提前推进 consumed high watermark；
8. 写 Event。

提交后 adapter 只能 dispatch 已冻结的 EngineTurn。response 到达后，用另一个事务校验 `turnId + dispatchAttempt + requestHash + leaseEpoch`，原子写 response、将 turn 置为 `responded`、将对应 entries 置为 `consumed`，并只推进连续 consumed high watermark。未知 dispatch 由恢复或显式人工裁决，不允许把 entry 重新绑定到另一个 turn。

### 17.6 Run 终态

一个事务：

1. 校验完整 run identity 和 lease；
2. 关闭 lease；
3. 写 immutable RunResult；
4. 写该时刻的 evidence 和 Operation liveness snapshot，但不伪造仍在运行 Operation 的终态；
5. 更新 Run 和 Action projection；
6. 写 Conversation Action card；
7. 写 Event；
8. 投递 Coordinator mailbox 终态事件。

Run 结果不能直接把 WorkItem 改为 done。Run 终态后仍存活的 Operation 继续按自身 lease/revision 更新；每次状态变化推进 WorkItem `operationRevision`，追加 Event 和 mailbox invalidation，但不能修改 RunResult。默认情况下，这些 Operation 会阻止同一 Action 新 Run、自动 wake 和 WorkItem complete。

所有可能改变 Operation effect observation、reconciliation、execution/cutoff、grant/supplemental inventory、authority fence 或 release saga 的入口，必须调用同一个 transaction-aware `mutateOperationSafety()`。该 mutation 在写入前后分别计算 `operationSafeToProceed`，推进 Operation/WorkItem `operationRevision`，并在同一 `BEGIN IMMEDIATE` 中执行以下规则：

- `false → false`：持久化实际进展和 cause refs；若 WorkItem 已在 recovery epoch，推进 `safetyRevision`，但不重复创建 warning、request 或 Coordinator recovery turn；
- `false → true`：只标记该 Operation 已收敛；WorkItem 级恢复仍必须等待全部 Run、Operation、request、reconciliation 和 recovery mailbox 通过 16.3 节 fenced restore；
- `true → false`：若 WorkItem 是 `done/cancelled` 且 terminal snapshot current，原子执行 16.3 节 terminal-safety invalidation；若 WorkItem 是 active/needs_attention/cancelling，则推进 `safetyRevision`、写 warning/Event 并保持原 admission；
- 任一 stale identity、旧 release callback 或旧 recovery epoch 不能跳过该 mutation；外部事实可进入 reconciliation/supplemental inventory，但权威投影只能由该 mutation 更新。

因此 Operation 更新、终态安全失效、canonical DTO revision 和用户可见告警不存在“先更新 Operation，稍后再修 WorkItem”的崩溃窗口。

### 17.7 WorkItem stop/cancel

`stop_work_item` 不是依次调用每个 Action Stop。它先在单一 `BEGIN IMMEDIATE` 事务中建立全 WorkItem 取消边界：

1. 校验 `clientCommandId + workItemId + expectedWorkItemRevision` 并做幂等去重；
2. 将 WorkItem 置为 `cancelling`，确认 `safetyStatus=safe` 或复用当前 recovery epoch，推进 `cancellationEpoch`、WorkItem/action-entry/run/request/operation/safety revisions；在规范化 `cancellation_attempts` 按 sourceIdentity 查回或插入 `purpose=initial_cancel,status=ready` 行（recovery/snapshot epoch 均为 null），按通用 live partial unique supersede旧live行并写两类幂等结果；事务提交后当前Controller立即调用共享 `claimCancellationAttempt()` 取得owner lease；
3. 通过 WorkItem cancellation gate 关闭所有 Action 的新 message/start admission，但不篡改 Action 自身的 open/superseded/closed 历史；并发到达的 message/start/complete 必须在同一 revision fence 下失败，不得部分写入；
4. 对全部 queued/running/dispatch_unknown/pausing/stopping active Run 推进 lease epoch，并创建或幂等复用 `(runId, cancellationEpoch)` cancellation attempt。尚未 dispatch 的 queued Run（包括仅有 `prepared` EngineTurn）和 `dispatch_unknown` Run 没有可继续接受的执行实体：在本事务立即写 immutable `cancelled` 或 `interrupted` RunResult；后者保留 `providerInvocation=unknown`。真实 running/pausing/stopping process 的 Run 先置为非终态 `stopping`，由 cancellation watchdog 收敛。迟到 provider/tool/result 不能通过旧 lease改写 Run/turn，但其中的 effect/grant/resource 事实必须进入 Operation reconciliation；既有 waiting/paused/completed/failed/stopped RunResult 保持不可变；
5. 把所有未绑定 ActionEntry 置为 `cancelled` 并保留审计；已 `bound` 的 entries 保持原 EngineTurn 身份。对应 turn 已 responded 则保留 consumed；prepared 可直接 cancelled；dispatching/unknown 在逻辑上置为 cancelled、entries 置为 cancelled，并永久记录 `providerInvocation=unknown`；迟到 response 不能恢复 turn/entry，但必须解析并持久化其中的 Operation evidence/reconciliation；所有情况都不能重新排队；
6. 取消普通 pending HumanRequest 和全部 `engine_turn_dispatch` request，关闭用户/Executor 到 Coordinator 的新工作 admission，并写对应 terminal mailbox/event；`operation_effect` request 只在匹配当前 effectCutoff 的 final observation 提交时消费。effect 为 pending/unknown、observation provisional、cutoff 缺失/变化或 reconciliation pending/conflict 时，按新 cancellation epoch/execution epoch/cutoff 原子 rebind 同一 pending 行；仅 effectStatus 看起来 terminal 不能消费或删除 request。内部 Run/Operation 终态只追加审计 mailbox event，不触发普通 CoordinatorTurn；但 `mutateOperationSafety()` 使 terminal snapshot 从 current 失效时，必须按 16.3 节投递唯一 recovery-mode CoordinatorTurn，不能被本条抑制；
7. 对 `executionStatus=running` 的 Operation 写 `cancel_requested`并推进 execution epoch；已有 `hazardous_orphan` 不得降级，`not_started/quiescent/fenced` 不得被 Stop 改坏。Stop 时的 effect probe 在 execution尚无 cutoff 时只能写 provisional observation；无法确认写 unknown。随后关闭 grant acquisition、收敛 pending grant attempts、建立 quiescent/fence cutoff，再基于 cutoff重新 probe或请求用户确认。任何 effect 更新都不得假装 execution已静默，也不能跳过 manifest closure；
8. 写唯一 Conversation control entry 和 `work_item.cancel_requested` Event。

事务提交后才请求中止 provider、tool 和后台 task，但每一个外部 probe/cancel/release/watchdog 动作都必须先经过 16.15 节 `prepareExternalRecoveryDispatch()` 与 `authorizeExternalRecoverySend()`；不存在“拿到 attempt 后可直接调 adapter”的隐式权限。每个真实 process cancellation attempt 持久化 `requestedAt/deadlineAt/status`；watchdog 以 `cancellationAttemptId + ownerLeaseEpoch + dispatchFenceEpoch + runId + cancellationEpoch + leaseEpoch` 探测 owner registry、Task/Operation记录和OS进程：

- 收到明确 cancel acknowledgement 或确认进程不存在：CAS 写 `cancelled` RunResult；
- 进程已经完成但结果在旧 epoch：逻辑 Run 写 `interrupted`；结果不能改写 Run，却必须进入 Operation reconciliation，用于建立/否定 cutoff 和复核 effect；
- provider/tool 不可取消、Agent 崩溃后不可查询或超过 deadline：不无限等待，CAS 写 `interrupted` RunResult；对应 Operation 的 effect 无法确认时写 `effectStatus=unknown`，execution 无法证明静默且无法强制 fence 时写 `executionStatus=hazardous_orphan`，并继续持有/隔离其排他资源；
- watchdog 重启后从 durable deadline 继续，重复 Stop 复用同一 cancellation attempt，不延长 deadline、不重复 terminal RunResult。

逻辑 Run 终结不表示物理副作用或执行实体已收敛。只要任一 blocking Operation 不满足 `operationSafeToProceed`，或仍有 pending `operation_effect` request，WorkItem 保持 `cancelling`；对外写入只允许 `resolve_operation` 和重复幂等 Stop，只读查询始终允许，系统 recovery probe、cancellation watchdog、authority fence 和 terminal CAS 继续运行；message、Start、reopen 或 complete 一律拒绝。Run 不会再成为无限等待条件，因为每个 active Run 都由上述确定性 terminalizer 收敛。全部 Run 已终态、每个 blocking Operation 都满足 `operationSafeToProceed`，所有 effect/supplemental resolution request、reconciliation 和 recovery mailbox event 已消费后，当前 cancellation controller 以显式 caller `{ kind:'initial_cancel_terminalizer', cancellationAttemptId, ownerId, ownerBootId, ownerLeaseEpoch, dispatchFenceEpoch, externalDispatchPolicyHash, commandIdentity: cancellationAttemptId + ':finalizeWorkItemCancellation:' + cancellationEpoch }` 调用独立 shared mutation `finalizeWorkItemCancellation()`，而不是 `restoreTerminalSafety()`。mutation锁定该WorkItem唯一live CancellationAttempt行，在同一SQLite事务取得dbNow并校验registry actor与`workItemId + purpose=initial_cancel + cancellationAttemptId + ownerId + ownerBootId + ownerLeaseEpoch + dispatchFenceEpoch + externalDispatchPolicyHash + leaseExpiresAt>dbNow + cancellationEpoch + status=active`及全部WorkItem/Operation/request/safety revisions；将attempt置为settling后重新计算`operationSafetyHash`，写lifecycle=cancelled、current cancelled terminal snapshot、`safetyStatus=safe`、关闭recovery admission、`work_item.cancelled` Event和Conversation status，并把同一attempt置为settled、写settledAt与immutable terminal command result。任一步失败整笔 rollback，attempt 仍为 active；重复 command identity 按历史 settled 行返回原结果。任何迟到事实、旧 purpose/attempt/lease 或重复 terminalizer 并发胜出都会使 CAS 失败。首次取消不调用 cancelled safety restore，也不写 `work_item.cancelled_safety_restored`。Stop 不回滚 applied effect，也不删除消息、entry、request 或 mailbox 审计。

`cancelled` WorkItem 默认拒绝全部新输入和执行。正常状态下它的每个 blocking Operation 都满足 `operationSafeToProceed`，且没有 pending resolution request；显式 reopen 通过 23.3 节的完整 fence 后才回到 active。若这些不变量不成立，reopen 失败并进入恢复诊断，不能改成 needs-attention 绕过取消边界。reopen 不恢复 cancelled entries、requests、mailbox events 或旧 Runs；仍 `open` 的 Action 可以接收一条新的 message/start 并创建新 Run，superseded/closed Action 永不复活。

### 17.8 Completion 竞态

完成事务必须 fence：

- WorkItem revision；
- Conversation revision；
- Action set revision；
- Action entry revision；
- Run revision；
- Request revision；
- Operation revision；
- safety revision；
- recovery admission epoch；
- cancellation epoch；
- terminal safety snapshot epoch/status（若已有）。

complete 提交时还必须确认 `safetyStatus=safe`、`recoveryAdmission.status=closed`、每个 blocking Operation 满足 `operationSafeToProceed`、没有 supplemental/reconciliation/recovery request/mailbox，并原子写 `terminalSafetySnapshot.lifecycleStatus=done,status=current` 与 `operationSafetyHash`。如果 Action message 或迟到 Operation fact 先提交，complete 因 revision/safety fence 变化失败；如果 complete 先提交，后续 message 以 `work_item_closed` 拒绝，而后续外部事实必须通过 `mutateOperationSafety()` 原子失效 terminal snapshot。不能出现消息已接受或安全事实已失效但 WorkItem 仍被权威投影为安全 done。

---

## 18. Engine 集成

### 18.1 Action thread 构造

每次新 Run 或下一 engine turn 的上下文包括：

- 冻结 Action objective 和 permissions；
- WorkItem 当前权威合同摘要；
- Action thread 历史；
- 最近安全 checkpoint；
- 本次 claim 的 message entries；
- Operation 的 effect/execution/resource-release 权威快照；
- unresolved effect、unsafe execution 和 held resource 警告；
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
- Action objective、permissions、pending request，以及 unresolved effect/unsafe execution/held resource 永远驻留；
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
- 失败、unknown effect、unsafe execution 和未释放资源不能被 summary 提升为已确认安全事实；
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
  originatingRunId,
  ownerLeaseEpoch,
  kind,
  target,
  idempotencyKey,
  replayPolicy: 'safe' | 'probe_first' | 'never_automatic',
  concurrencyPolicy: 'blocking' | 'detached_read_only',
  effectStatus: 'pending' | 'applied' | 'not_applied' | 'failed_no_effect' | 'unknown',
  effectObservation: null | {
    finality: 'provisional' | 'final',
    observedExecutionEpoch,
    observedCutoffHash: null,
    observedAt,
    source: 'automatic_probe' | 'user' | 'coordinator' | 'migration',
    evidenceRefs: [],
  },
  effectReconciliation: {
    revision,
    status: 'clear' | 'pending' | 'conflict',
    evidence: [{
      evidenceId,
      sourceType: 'provider' | 'tool' | 'task' | 'authority' | 'migration',
      sourceIdentity,
      executionEpoch: null,
      cutoffHash: null,
      payloadRef,
      status: 'pending' | 'accepted' | 'conflict',
      observedAt,
      reconciledAt: null,
    }],
  },
  executionStatus: 'not_started' | 'running' | 'cancel_requested' | 'quiescent' | 'fenced' | 'hazardous_orphan',
  executionEpoch,
  effectCutoff: null | {
    status: 'current' | 'stale',
    cutoffHash,
    executionEpoch,
    closureType: 'not_started' | 'quiescent' | 'authority_fence',
    processIdentity: null,
    grantManifestGeneration,
    grantManifestHash,
    effectiveManifestHash,
    supplementalGeneration,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    fenceEpoch: null,
    evidenceChannelsClosedThrough,
    closureProofRef,
    closedAt,
  },
  taskId: null,
  processIdentity: null,
  grantManifest: {
    generation,
    status: 'open' | 'closing' | 'closed',
    safetyStatus: 'current' | 'stale',
    policySnapshotHash,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    capabilityUniverse: [{
      capabilityId,
      authorityId,
      targetScope,
      maxPrivilege,
      derivationPolicy,
      maxExpiry,
      resourceSetGeneration,
    }],
    requiredAuthorityIds: [],
    inventoryComplete,
    pendingGrantAttemptIds: [],
    grants: [{
      grantId,
      parentGrantId: null,
      authorityId,
      issuerEpoch,
      capabilityId,
      target,
      resourceSetGeneration,
      credentialGeneration: null,
      expiresAt: null,
      status: 'pending' | 'active' | 'revoked' | 'expired' | 'rejected',
    }],
    authorityClosures: [{
      authorityId,
      acquisitionEpoch,
      status: 'open' | 'closing' | 'closed' | 'failed',
      closureProofRef: null,
    }],
    manifestHash: null,
    closedAt: null,
  },
  resourceLeaseIds: [],
  resourceRelease: {
    status: 'held' | 'releasing' | 'partially_released' | 'released' | 'stale',
    lastProvenStatus: null | 'held' | 'releasing' | 'partially_released' | 'released',
    releaseSetGeneration,
    grantManifestGeneration,
    grantManifestHash,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    effectiveManifestHash,
    supplementalGeneration,
    requiredLeaseIds: [],
    leases: [{
      leaseId,
      authorityId,
      leaseEpoch,
      resourceSetGeneration,
      status: 'held' | 'release_requested' | 'released' | 'failed' | 'unknown',
      attempt,
      idempotencyKey,
      proofRef: null,
      requestedAt: null,
      releasedAt: null,
    }],
    revision,
    releasedAt: null,
  },
  supplementalInventory: {
    generation,
    quarantineEpoch,
    status: 'clear' | 'quarantined' | 'closing' | 'releasing' | 'resolved' | 'unknown_authority',
    effectiveManifestHash: null,
    baseManifestGeneration,
    baseManifestHash,
    acquisitionGateStatus: 'open' | 'closing' | 'closed' | 'failed',
    acquisitionClosureProofRef: null,
    authorityMappingRequestIds: [],
    discoveries: [{
      supplementalId,
      sourceEvidenceId,
      kind: 'grant' | 'lease' | 'credential' | 'capability' | 'resource',
      authorityId: null,
      authorityIdentity,
      grantId: null,
      leaseId: null,
      parentGrantId: null,
      issuerEpoch: null,
      leaseEpoch: null,
      credentialGeneration: null,
      resourceSetGeneration: null,
      capabilityId: null,
      target,
      discoveredAt,
      status: 'recorded' | 'quarantined' | 'revocation_requested' | 'revoked' | 'release_requested' | 'released' | 'unknown_authority',
      attempt,
      idempotencyKey,
      proofRef: null,
    }],
    recoveryReleaseSets: [{
      generation,
      sourceSupplementalIds: [],
      effectiveManifestHash,
      status: 'held' | 'releasing' | 'partially_released' | 'released',
      items: [{
        supplementalId,
        kind: 'grant_revocation' | 'credential_revocation' | 'lease_release' | 'resource_release',
        authorityId: null,
        externalId,
        issuerOrLeaseEpoch: null,
        resourceSetGeneration: null,
        status: 'held' | 'requested' | 'released' | 'revoked' | 'failed' | 'unknown_authority',
        attempt,
        idempotencyKey,
        proofRef: null,
      }],
      revision,
    }],
    revision,
    resolvedAt: null,
  },
  authorityFence: null | {
    fenceEpoch,
    status: 'pending' | 'enforced' | 'failed' | 'stale',
    grantManifestGeneration,
    grantManifestHash,
    effectiveManifestHash,
    supplementalGeneration,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    authorityClosureProofRefs: [],
    coveredGrantIds: [],
    coveredResourceLeaseIds: [],
    authorityProofRef,
    enforcedAt: null,
  },
  revision,
  executionEvidenceRefs: [],
  recoveryProbe: null,
  startedAt,
  executionEndedAt: null,
}
```

Operation 是独立于 immutable RunResult 的 durable lifecycle，并把三类事实正交保存：`effectStatus/effectObservation` 回答在什么执行截止点观察到了什么副作用；`executionStatus/effectCutoff` 回答旧 task/process/provider execution 在哪个 epoch 后不再能扩大 effect；`grantManifest/resourceRelease` 回答旧 execution 曾经或仍可能取得哪些外部能力，以及这些资源是否已逐项释放。`originatingRunId` 只说明来源，不表示 Run 终态会终止 Operation。人工 effect 裁决永远不能隐式改变 executionStatus、关闭 grant acquisition 或释放资源。

#### Effect observation 与 execution cutoff

`effectStatus` 在没有匹配 cutoff 的 final observation 时只是事实候选。execution 仍为 `running/cancel_requested/hazardous_orphan` 时，用户、Coordinator 或自动 probe 提交的三个 effect decision 都必须写 `effectObservation.finality=provisional`，绑定当时的 `observedExecutionEpoch`，不能满足安全谓词。execution 每次获得新的进程、恢复执行或扩大写能力都推进 `executionEpoch`；比当前 epoch 旧的 observation 自动失效为 provisional。

只有以下事务能建立 `effectCutoff`：

- Operation 从未启动：`executionStatus=not_started`，确认没有 pending grant attempt，关闭 grant manifest；
- 可信 terminal/cancel acknowledgement 或稳定 process-gone 探测：把 execution 写为 `quiescent`，先关闭所有 evidence channel 与 grant acquisition，再记录 journal/task/tool/event high watermarks；
- 完整 authority fence：所有 required authority 先关闭 acquisition，撤销/换代 manifest 中每个 active/pending grant，再把 execution 写为 `fenced`。

cutoff hash 覆盖 `operationId + executionEpoch + processIdentity + closureType + capabilityUniverseGeneration/hash + grantManifestGeneration/hash + fenceEpoch + evidenceChannelsClosedThrough + closure proof`。cutoff 建立后必须重新运行 effect probe，或让用户/Coordinator基于该 cutoff 重新确认；只有 `effectObservation.finality=final`、`observedExecutionEpoch` 与 cutoff epoch 相等、`observedCutoffHash=cutoffHash`、effect evidence 覆盖全部 closed evidence channel，且没有 pending/conflicting reconciliation 时，effect 才算 resolved。活 execution 期间的旧 `applied/not_applied/failed_no_effect` 不能直接升级为 final。

迟到 tool/task/provider/effect evidence不能仅进冷审计。它先进入 durable reconciliation inbox，并标记与哪个 execution epoch/cutoff 相关：若 evidence 属于 cutoff 之前且与 final observation 一致，幂等附加 proof；若冲突或无法定位 epoch，原子把 observation 降为 provisional、effectStatus 写 `unknown`、创建或 rebind 唯一 `operation_effect` request，并推进 Operation/WorkItem revisions。cutoff 之后还能产生受保护 effect，说明 quiescence/fence proof 失效：execution 转 `hazardous_orphan`、authority fence 标记 failed、资源保持 held，禁止继续。

#### Grant manifest 与 authority fence

Operation 创建时从冻结的 tool/permission/resource policy 生成权威 capability universe，记录每类能力的 authority、target scope、最大权限、派生规则、最大有效期和 resource-set generation；`capabilityUniverseHash` 是后续 grant 与 fence 的可比较上界。任何 credential、lease、token、端口、worktree 写令牌、部署/远端写权限或派生能力，都必须在外部 authority 签发前先登记 pending grant attempt。登记事务校验 `grantManifest.status=open`、manifest generation 和 capability-universe generation/hash，且申请必须是 universe 中某项的子集；随后分配稳定 `grantId + authorityId + issuerEpoch + resourceSetGeneration`。authority 只接受已登记、generation/hash 匹配的 attempt，并把结果 CAS 回同一行。派生 token 必须引用 `parentGrantId`，不能超出 parent capability、expiry、issuer epoch 或 universe derivation policy。未登记或超出 universe 的 grant 视为权限系统违规，Operation 立即进入 `hazardous_orphan`。

关闭 manifest 使用 acquisition gate，而不是事后枚举：事务先把 manifest 从 open 置为 closing，冻结 capability-universe generation/hash，之后所有新 grant/refresh/derived-token attempt 均被数据库与外部 authority 拒绝；再逐个 required authority 关闭其 acquisition epoch，等待所有 pending attempt 收敛，并记录 closure proof。只有 capability universe 与 requiredAuthorityIds 完整、每个 authority closure 为 closed、pendingGrantAttemptIds 为空、每个 grant 都落在 universe 内、grant parent 链完整、inventoryComplete=true 时，才能冻结 manifest generation/hash 并置为 closed。required authority/capability universe 来自 Operation 创建时冻结的 tool/permission/resource policy；动态增加 authority 或 capability 必须在 manifest open 时先推进 universe 和 manifest generation。进入 closing 后不能扩张，任何并发扩权只能失败并转 hazardous_orphan。

`executionStatus=quiescent` 只允许可信 cancel acknowledgement、稳定 process identity 的 process-gone 探测或正常 terminal tool/task result写入；它仍要求 acquisition gate 已 closed，防止遗留 credential refresh。`executionStatus=fenced` 不等于“用户相信它停了”，而是每个 required authority 的 closure proof 与 grant manifest generation/hash 都被验证，且 fence 精确覆盖 manifest 中全部 active/pending grant ID、issuer epoch、credential generation 和 resource set generation。只更新数据库 ownerLeaseEpoch 或只列 `coveredCapabilities` 不能形成 fence。无法关闭 acquisition、完整冻结 manifest或覆盖全部 grant 的实体必须是 `hazardous_orphan`。

#### Supplemental / quarantine inventory

closed manifest、enforced fence 或 released saga 之后发现未登记/超 universe 的 grant、credential、lease、capability 或 resource 时，不能修改旧 manifest 假装它当时已知，也不能重新开放业务 acquisition。发现事实的事务必须先按 `(operationId, sourceEvidenceId, authorityIdentity, externalId/target)` 幂等追加 `supplementalInventory.discovery`；未知 external ID 仍以 authority identity、target、issuer/lease epoch 和 evidence hash 建稳定 synthetic ID。

同一事务必须：

1. 推进 supplemental generation 与 Operation/WorkItem revisions；将 `supplementalInventory.status` 置为 quarantined 或 unknown_authority；
2. 将 base manifest、旧 effectCutoff、authorityFence 和 resourceRelease aggregate 标记 stale，保存 `lastProvenStatus` 但使其不再满足安全谓词；
3. 计算新的 append-only `effectiveManifestHash = hash(base manifest generation/hash + supplemental generation + ordered discoveries)`；旧 manifest hash 保持不可变；
4. 把 execution 置为 hazardous_orphan，effect observation 降为 provisional/unknown并进入 reconciliation；触发 16.3 节 terminal-safety invalidation；
5. 用独立 supplemental acquisition gate 关闭该 authority identity 的 refresh、derived-token、lease renewal 和新派生能力。已知 authority 记录 closure proof；未知 authority 创建唯一 `supplemental_authority` HumanRequest，WorkItem 保持 safetyStatus=unsafe，禁止用户用 effect decision 声称已隔离；
6. 基于当前全部 unresolved supplemental discoveries 冻结新的 recovery-only release set。该集合只允许 revoke/release/quarantine，不能签发业务 grant。每项保存 authority identity、external ID、issuer/lease epoch、resource-set generation、attempt、idempotency key 和 proof。

recovery release set 采用与主 release saga 相同的逐项物理状态机；重复 callback 和重启按 supplemental ID + generation + attempt 幂等收敛。发现第二个迟到对象时推进 generation 并建立包含所有未解决对象的新 set；已证明 revoked/released 的旧项引用原 proof，不重新执行，未完成项继承原 idempotency key/attempt。旧 set 保留历史并标记 superseded，不能删除或覆盖。

只有所有 supplemental authority acquisition gate 都 closed、未知 authority 已由用户映射到可信 authority 或明确保持不可解除的 quarantine、全部 discoveries 都有 revocation/release proof、最新 recovery set 为 released、reconciliation clear，才能把 supplemental inventory 写为 resolved。系统随后基于 effective manifest 重建 cutoff/fence 和主 release aggregate；`operationSafeToProceed` 使用 effective manifest 与 supplemental generation，不能回退使用 base manifest 的旧 released/enforced 投影。未知 authority 不能自动变 safe；若无法建立 authority 和隔离 proof，Operation 永久保持 hazardous quarantine，WorkItem 继续 recovery-only admission。

#### 逐 lease release saga

外部 authority 的物理 release 不能由 SQLite 整笔回滚。系统先冻结 `requiredLeaseIds` 与 `releaseSetGeneration`；每个 lease 用稳定 idempotency key 和期望 authority/lease epoch 写 `release_requested`，事务提交后调用对应 authority，再用 proof CAS 写该 lease 的 `released/failed/unknown`。进程在外部成功与本地确认之间崩溃时，恢复器按 idempotency key查询 authority 并补写 proof；不得重新创建不同 attempt。聚合状态从各 lease 投影为 `held/releasing/partially_released/released`，准确反映部分物理释放，绝不声称外部动作能随数据库 rollback。只有 manifest 已 closed、release set 等于当前全部 required leases、每项都是 released 且 proof 的 authority/epoch/generation 匹配，聚合才可写 released。没有排他资源的 Operation 创建时直接为 released。

只有显式分类为 `detached_read_only`、没有写/部署/端口等 grant/lease、execution 不会继续产生受保护副作用且其输出不参与当前验收时，Operation 才可不阻止新 Run。每次 effect observation、execution epoch/cutoff、grant/fence 或 lease-release 状态变化，都在同一事务推进 Operation revision 和 WorkItem `operationRevision`。

所有 Start、message wake、WorkItem cancelled、reopen 和 complete 共用唯一确定性谓词 `operationSafeToProceed(operation)`：

```text
effectSafe = effectStatus ∈ {applied, not_applied, failed_no_effect}
          AND effectObservation.finality = final
          AND effectObservation.observedExecutionEpoch = effectCutoff.executionEpoch
          AND effectObservation.observedCutoffHash = effectCutoff.cutoffHash
          AND effect evidence 覆盖 closed channels
          AND reconciliation inbox 没有 pending/conflict
executionSafe = executionStatus ∈ {not_started, quiescent}
             OR (executionStatus = fenced
                 AND authorityFence.status = enforced)
grantUniverseSafe = grantManifest.status = closed
                 AND grantManifest.safetyStatus = current
                 AND inventoryComplete
                 AND pendingGrantAttemptIds 为空
                 AND required authority closure proofs 完整
                 AND capability universe generation/hash 与冻结 policy 精确相等
                 AND supplementalInventory.status ∈ {clear, resolved}
                 AND supplemental acquisition closures/recovery release proofs 完整
                 AND effectiveManifestHash 匹配当前 supplemental generation
                 AND effectCutoff/authorityFence 绑定 effective manifest/supplemental generation
                 AND fenced 时 authorityFence universe/manifest generation/hash/grants 精确相等
resourcesSafe = resourceRelease.status = released
             AND resourceRelease 不是 stale
             AND releaseSetGeneration 对应 effective manifest
             AND requiredLeaseIds 与 base + supplemental resource inventory 精确相等
             AND 每个主/supplemental item 都有匹配 authority/epoch/generation 的 release/revocation proof
operationSafeToProceed = effectSafe AND executionSafe AND grantUniverseSafe AND resourcesSafe
```

`quiescent/not_started` 不要求 authority fence，但仍要求 grant acquisition 已关闭；`fenced` 没有冻结 manifest 和完整 authority closure proof 时绝不安全。任何章节出现“effect 已确定”“execution 已静默/隔离”“权限已覆盖”或“资源已释放”，都必须等价展开为此谓词，不能另造更宽松的 gate。

### 22.2 崩溃窗口

- 工具前创建 `effectStatus=pending, executionStatus=not_started` 和 open grant manifest；任何外部 grant/lease 在签发前先登记。获得执行实体 identity 后推进 `executionEpoch` 并写 `executionStatus=running`；
- 同步工具完成不直接令 effect final。系统先关闭 grant acquisition 与 evidence channel，写 quiescent cutoff，再在该 cutoff 上运行 effect probe；后台 envelope 只能证明任务已启动，execution 继续为 running；
- 中间崩溃分别恢复 effect、execution、grant manifest 和 release saga：effect 不确定写 `unknown`；execution 不可查询且不能强制 fence写 `hazardous_orphan`；manifest 不能证明完整则保持 closing/failed；每个 release attempt 按 idempotency key 查询 authority。不能用其中一轴推断另一轴；
- effect observation provisional、execution unsafe、grant universe 未关闭或任一 release 未证明时，都阻止自动 Start、message wake 和 complete；
- 恢复先关闭 acquisition、建立 cutoff，再确认 effect、取消、强制 authority fence 或请求用户基于 cutoff 裁决；不能因为用户又发了一条消息就盲目重放；
- 后台任务晚于 originating Run 结束时，结果进入 reconciliation inbox，更新 Operation、artifact、Event 和 Coordinator mailbox；RunResult 保持不变；
- Stop 或 lease 失效后的迟到结果必须带 `operationId + executionEpoch + processIdentity/fenceEpoch + grantManifestGeneration`。revision stale 不等于事实可丢弃：先持久审计并运行 reconciliation，再决定是否使 effect observation/cutoff/fence 失效。

### 22.3 Operation resolution

Operation 的 effect、execution、grant universe 与 resource release 使用不同出口，任何路径都不能以一轴代替另一轴：

1. **自动 effect probe**：恢复器先通过ExternalRecoveryDispatch持久化`read_only_probe`（或真实会改变外部状态时使用更强分类）及预期 `cancellationAttemptId + ownerLeaseEpoch + dispatchFenceEpoch + operationId + revision + executionEpoch + effectCutoffHash + grantManifestGeneration/hash + capabilityUniverseGeneration/hash + cancellationEpoch`。只有 cutoff 已建立、evidence high watermarks 闭合且 reconciliation 无 pending/conflict 时，结果才能写 final observation；否则只能写 provisional。确认已发生 → `applied`；确认未发生 → `not_applied`；确认失败且无副作用 → `failed_no_effect`；不确定 → `unknown`。若 final observation 成功且存在 pending `operation_effect` request，同一事务消费 request 并推进 request revision。
2. **人工 effect 裁决**：effect 首次 unknown 或旧 observation 失效时，在同一事务创建/rebind 唯一 pending `operation_effect` HumanRequest。用户或 Coordinator 提交结构化 decision 和 effect evidence；若 execution 尚无 cutoff，只写 provisional observation并保留/rebind request，UI 明确显示“待 execution 收敛后复核”；只有 payload 的 `effectCutoffHash/executionEpoch` 匹配当前 cutoff，才可写 final 并消费 request。
3. **系统 execution probe/cancel**：每次外发先创建/授权ExternalRecoveryDispatch；只读process-gone探测是`read_only_probe`，cancel请求只有在authority明确同key幂等时才是`idempotent_effect`，支持单调token时是`authority_fenced_effect`，否则是`exclusive_unfenceable_effect`。稳定 process/task identity 的 terminal result、可信 cancel acknowledgement 或 process-gone 探测只能证明 execution 不再动作；系统还必须关闭 grant acquisition/evidence channel并建立 cutoff。探测不确定时保持 `running/cancel_requested`，超过 deadline 且无法完整 fence 时写 `hazardous_orphan`。
4. **系统 authority fence**：业务期的closure/revoke仍经ExternalRecoveryDispatch；**reclaim期间用于打破owner lease循环的token advance只走16.16节ReclaimFenceAdvance**。只有authority强制拒绝旧token时，普通业务动作才能分类`authority_fenced_effect`，否则按幂等或exclusive规则处理。每个required authority独立关闭acquisition、撤销/换代其grant，并返回带issuer/acquisition epoch的closure proof。系统在全部 closure proof 和冻结 manifest通过后，才能写 enforced fence、`executionStatus=fenced` 和 authority-fence cutoff。用户、Coordinator 和 `resolve_operation` 不能写这些状态。
5. **资源 release saga**：每个lease/revoke item映射到唯一ExternalRecoveryDispatch。authority合同保证同key同request同effect时分类idempotent；支持单调release fence时分类authority-fenced；两者都不满足则exclusive且reclaim受阻。系统按frozen release set逐lease请求外部authority，持久化每项结果并更新聚合投影。失败或 unknown 项保留，稍后按同一 idempotency key恢复；它不回滚已经成功的外部 release。

`resolve_operation` 事务必须校验 `workItemId + actionId + operationId + requestId + expectedOperationRevision + expectedRequestRevision + expectedOwnerLeaseEpoch + expectedExecutionEpoch + effectCutoffHash + grantManifestGeneration + grantManifestHash + capabilityUniverseGeneration + capabilityUniverseHash + cancellationEpoch`。它只写 effectStatus/effectObservation、推进 revisions并写 evidence/Conversation/Event；不得修改 executionStatus、effectCutoff、grantManifest、authorityFence 或 resource release。execution 没有匹配 cutoff 时不消费 request。重复 `clientCommandId` 返回原结果；两个用户、用户与 Coordinator、自动 probe 与人工裁决、Stop/reopen/complete并发时只有一个 CAS 成功。

允许 decision：

- `confirm_applied` → effect 候选 `applied`，要求能证明目标和实际 effect；
- `confirm_not_applied` → effect 候选 `not_applied`，要求能证明 effect 没有发生；
- `confirm_failed_no_effect` → effect 候选 `failed_no_effect`，要求能证明失败且无残留副作用。

三个 decision 在 execution 仍为 `running/cancel_requested/hazardous_orphan` 时一律 provisional。execution 收敛后必须基于新 cutoff 自动 probe 或重新确认；旧进程在 provisional decision 后产生的 effect 必须进入 reconciliation，不能因旧 Operation revision 而只进冷审计。effect final 后如果发现属于 cutoff 前的冲突证据，立即降级为 unknown/provisional并重开同一 effect request；cutoff 后 effect 则令 execution/fence proof 失效。

资源 release gate 只推进逐 lease saga：先冻结 release set，再逐项持久化 requested/released/failed/unknown。单项成功永不被数据库 rollback；聚合 `partially_released` 是正常可恢复状态。只有每项最新 lease 都有匹配 authority/epoch/generation 的 proof，才写 aggregate released。部分释放期间 Operation 与 WorkItem 继续 blocking，但已释放 lease 不会被错误重新分配给旧 execution。

没有足够 effect 证据时保持 `unknown`；无法证明 cutoff、关闭 grant universe或完整 fence 时保持/进入 `hazardous_orphan`。不存在“忽略 unknown/hazardous orphan 并继续”的 decision；需要补偿或重试时必须在旧 execution 已安全隔离、manifest closed且资源 saga满足安全谓词后创建新的 approval/Operation。

### 22.4 Runner 重启

恢复时：

1. 读取 active Run lease；
2. 读取 durable EngineTurn，按 `prepared/dispatching/responded/unknown` 和 adapter capability裁决，不按内存重造请求；
3. 读取 Operation 的 execution epoch、grant manifest generation、pending grant attempt、effect cutoff/reconciliation、逐lease release records，以及live CancellationAttempt的冻结externalDispatchPolicy、全部prepared/dispatching/unknown ExternalRecoveryDispatch和ReclaimFenceAdvance；
4. 判断 provider/tool/process 与每个外部 authority 是否仍可查询；
5. 核对最后 safe checkpoint、request hash、ActionEntry high watermarks和 response CAS；
6. orphaned execution 无法证明 process gone 或完整 fence时写 `hazardous_orphan`；effect observation降为 provisional/unknown；manifest/release 保持实际部分状态，不伪造 closed/released；
7. 按 ExternalRecoveryDispatch 分类幂等收敛 pending grant attempt、authority closure 和 release attempt；外部成功而本地未确认时，查询 proof 必须绑定同一 logical ID/key/request/target/contract 及明确 sibling IDs，并调用 `reconcileExternalRecoveryLogicalResult()`。proof 覆盖的 unknown sibling 转 reconciled；未覆盖 sibling保持blocking。exclusive unknown不得自动重发或由另一attempt成功推定已解决；
8. 处理迟到 evidence reconciliation；不复用旧 runId静默重跑；同一逻辑 EngineTurn只有在幂等/人工裁决允许时增加 attempt；
9. 只有 `operationSafeToProceed` 成立时创建 recovery Run 或允许 Start；迟到旧 Run/turn/Operation 写请求不能直接覆盖权威状态，但其事实证据不得丢弃。

准确产品承诺是：状态、消息、证据、部分外部释放和已知/未知副作用不会丢；不承诺所有外部操作都能自动继续或回滚。

---

## 23. WorkItem 完成与重新打开

### 23.1 完成门禁

Coordinator 可提出 complete，但确定性代码必须确认：

- WorkItem 是 active/needs_attention，不是 cancelling/cancelled；
- 没有 queued/running/dispatch_unknown/pausing/stopping Run；
- 没有未消费或 `bound` Action message/control；
- 没有 pending HumanRequest；
- 每个 blocking Operation 都满足 `operationSafeToProceed`；
- 没有未处理 Coordinator mailbox event；
- Coordinator snapshot 中的 `operationRevision + safetyRevision + recoveryAdmission.epoch` 与事务内权威值一致；
- `safetyStatus=safe`、`recoveryAdmission.status=closed`，不存在 invalidated/restoring terminal snapshot；
- 所有 revisions 匹配；
- 每条验收条件有结果；
- 最终摘要、证据和残余风险完整。

不要求固定 deliver Action、Review stage 或 graph sink。

### 23.2 完成后的 Action

WorkItem `done + safetyStatus=safe` 后：

- composer 变只读；
- Action 历史仍可查看；
- Start/Pause/Stop 和“发送给 Action”禁用；
- Action admission 历史不被批量改写；
- 新消息必须先显式重新打开 WorkItem；
- 若 safetyStatus 变为 reconciling/unsafe，仍保持业务 composer/Action 控制只读，但显示 recovery-only controls、warning 和 Needs attention 投影，不要求先 reopen。

### 23.3 重新打开

重新打开事务：

- 只接受 `done/cancelled`；`cancelling` 必须先通过 Operation resolution 和 terminalizer 收敛，reopen 请求直接拒绝且无副作用；
- 校验 `expectedWorkItemRevision + operationRevision + requestRevision + safetyRevision + recoveryAdmission.epoch + terminalSafetySnapshot.epoch/status + cancellationEpoch`；只接受 `safetyStatus=safe`、recovery admission closed、terminal snapshot current、每个 blocking Operation 满足 `operationSafeToProceed`，且没有 pending resolution/reconciliation/recovery mailbox；
- 保存 control ConversationEntry；
- WorkItem 回到 active，重新打开 Coordinator mailbox admission；
- 原 finalResult 保留；
- Coordinator 接收 reopen 事件；
- 仍 open 的旧 Action可再次定向；
- superseded/closed Action 不能复活；
- Coordinator 可创建新 Action。

若持久库出现 `cancelled` 同时仍有 unresolved Operation 的不变量破坏，reopen 必须失败并进入恢复诊断，不能借 `needs_attention` 绕过 cancellation gate。

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
- `resolve_engine_turn`
- `resolve_operation`
- `resolve_supplemental_authority`
- `resolve_external_recovery_conflict`
- `restore_terminal_safety`（仅 Agent 内部 recovery-mode Coordinator / deterministic cancelled terminalizer）
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

`resolve_engine_turn` 只处理 `dispatch_unknown`，不能修改 request body 或换绑 entries：

```js
{
  clientCommandId,
  workItemId,
  actionId,
  runId,
  turnId,
  requestId,
  decision: 'adopt_queried_response' | 'confirm_not_executed_and_redispatch' | 'cancel',
  queriedResponseRef: null,
  expected: {
    requestRevision,
    requestHash,
    dispatchAttempt,
    runRevision,
    cancellationEpoch,
  },
}
```

只有 payload `requestId` 指向 pending `engine_turn_dispatch` HumanRequest 的 owner 用户，或带相同 request identity 的 Coordinator fenced decision 可以调用。`adopt_queried_response` 要求可验证 provider response identity/hash；`confirm_not_executed_and_redispatch` 要求用户明确承担重复调用风险且仍使用同一 turn/request hash；`cancel` 把 turn 和 entries/Run 收敛为 cancelled/failed 并保留 unknown-effect audit。一个 `BEGIN IMMEDIATE` 事务校验完整 expected identity、消费 HumanRequest、更新 turn/Run/entries/request revisions、写 Conversation/Event；重复 `clientCommandId` 返回原结果，迟到或冲突 decision 无副作用。

`resolve_operation` 只处理 payload `requestId` 绑定的 pending `operation_effect` HumanRequest：

```js
{
  clientCommandId,
  workItemId,
  actionId,
  operationId,
  requestId,
  decision: 'confirm_applied' | 'confirm_not_applied' | 'confirm_failed_no_effect',
  evidenceRefs: [],
  expected: {
    operationRevision,
    requestRevision,
    ownerLeaseEpoch,
    executionEpoch,
    effectCutoffHash,
    grantManifestGeneration,
    grantManifestHash,
    capabilityUniverseGeneration,
    capabilityUniverseHash,
    safetyRevision,
    recoveryAdmissionEpoch,
    terminalSafetySnapshotEpoch,
    terminalSafetySnapshotStatus,
    cancellationEpoch,
  },
}
```

服务端验证 caller 是 request owner 用户，或该请求当前 Coordinator snapshot 的 fenced decision。裁决按 22.3 节执行同一事务；没有可验证 effect evidence 时保持 `effectStatus=unknown` 并返回明确错误，不消费 request。execution 没有当前 cutoff，或 expected cutoff/epoch/manifest generation 不匹配时，只能写 provisional observation并保留/rebind request；匹配 cutoff 的 final observation 才消费 request。成功不修改 executionStatus、grantManifest、authorityFence 或 resource release，也不直接允许 Start/wake/reopen/complete；所有入口仍必须通过 `operationSafeToProceed`。

`resolve_supplemental_authority` 只处理 payload `requestId` 绑定的 pending `supplemental_authority` HumanRequest：

```js
{
  clientCommandId,
  workItemId,
  operationId,
  requestId,
  decision: 'map_authority' | 'confirm_unresolvable_quarantine',
  authorityId: null,
  authorityProofRefs: [],
  expected: {
    operationRevision,
    requestRevision,
    safetyRevision,
    recoveryAdmissionEpoch,
    terminalSafetySnapshotEpoch,
    terminalSafetySnapshotStatus,
    supplementalGeneration,
    quarantineEpoch,
    effectiveManifestHash,
    authorityIdentity,
    cancellationEpoch,
  },
}
```

`map_authority` 只能把未知 authority identity 映射到项目已配置且当前 owner 可验证的 authority，并保存 identity/ownership proof；它不签发 grant、不恢复业务 acquisition、不直接撤销/释放外部资源。成功事务消费 request、推进 request/operation/safety revisions，保持 WorkItem recovery-only admission，并由系统基于同一 supplemental generation 启动 acquisition closure 与 recovery release set。`confirm_unresolvable_quarantine` 只确认该 authority 当前无法解析，保持 `safetyStatus=unsafe`、hazardous quarantine 和 held/stale resources；它不能让 `operationSafeToProceed` 成立。重复/冲突命令按完整 expected identity 幂等或无副作用。

`resolve_external_recovery_conflict` 只处理 payload `requestId` 绑定的 pending `external_recovery_conflict` HumanRequest；proof 必须已由 16.15 节窄权限 control plane 持久化，wire 只能引用 `authorityProofId`，不能携带任意 proof bytes、自由文本确认或普通 send callback：

```js
{
  clientCommandId,
  coordinatorTurnId,
  workItemId,
  cancellationAttemptId,
  conflictId,
  requestId,
  decision: 'accept_independent_authority_query' | 'confirm_operator_isolation' | 'accept_stronger_authority_epoch_fence',
  authorityProofId,
  evidenceRefs: [],
  expected: {
    conflictRevision,
    conflictStatus: 'pending',
    externalDispatchAdmissionEpoch,
    ownerLeaseEpoch,
    dispatchFenceEpoch,
    safetyRevision,
    recoveryAdmissionEpoch,
    terminalSafetySnapshotEpoch,
    terminalSafetySnapshotStatus,
    cancellationEpoch,
  },
}
```

服务端把该请求规范化为 15.3 节 `resolveExternalRecoveryConflicts` 的同一 transaction-aware mutation。它锁定 conflict、proof、attempt admission、关联 logical/send/fence rows、HumanRequest 和 WorkItem；重新验证 proof identity/hash/status/authority epoch、conflict kind 与 allowed resolution。`evidence_gap` 可接受 matching confirmed-send proof，但 `authority_contract_violation` 对 `proofKind=confirmed_send`、同一被质疑 authority 的普通 success、用户文本确认和未持久化 evidence 一律拒绝。后者只接受独立 `authority_query`、`operator_isolation` 或 `stronger_authority_epoch_fence`。成功后按 16.15 节原子 resolve conflict、消费 request、重验 sibling/proof、恢复或保持 admission；重复 command 返回原结果，任一 expected identity stale 时无副作用。

`restore_terminal_safety` 是 Agent 内部结构化 op；Server/Web 不暴露可由浏览器直接构造的写入口。它只承载 recovery-mode Coordinator 的 `caller.kind=coordinator` command，调用 16.3 节同一个 shared mutation：

```js
{
  clientCommandId,
  coordinatorTurnId,
  workItemId,
  resultingLifecycle: 'done' | 'needs_attention',
  summary,
  acceptanceResults: [],
  evidenceRefs: [],
  residualRisks: [],
  expected: {
    lifecycleStatus: 'done',
    terminalSafetySnapshotEpoch,
    terminalSafetySnapshotStatus: 'invalidated' | 'restoring',
    workItemRevision,
    operationRevision,
    requestRevision,
    safetyRevision,
    recoveryAdmissionEpoch,
    cancellationEpoch,
    operationSafetyHash,
  },
}
```

WebSocket router 必须拒绝来自浏览器/user VP/Executor 的该 op；只有 Engine 持有的当前 recovery-mode Coordinator turn identity 可以提交。调用方不能省略验收字段、改成普通文本 summary 或复用 `complete`。服务端不信任 payload 的 lifecycle、hash 或 evidence ownership，必须重新读取和验证全部权威状态。cancelled terminalizer 不走该 op；它由 Controller/Watcher 以 `caller.kind=cancelled_terminalizer` 直接调用 shared mutation，并接受独立 cancellation attempt/owner lease 校验。

`stop_work_item`：

```js
{
  clientCommandId,
  workItemId,
  expectedWorkItemRevision,
  reason,
}
```

响应先返回持久化后的 `cancelling` 投影和 `cancellationEpoch`，不谎报物理进程已经全部停止。只有全部 Run 终态、每个 blocking Operation 都满足 `operationSafeToProceed` 且没有 pending resolution request 后，事件和 canonical get 才显示 `cancelled`。

### 24.3 退出目标合同的旧操作

- 直接修改 Action instruction；
- Action generation 原地 reset/retry；
- 传入 dependencies/stages/workflow graph；
- 独立 Action 页 composer；
- 浏览器直接改 owner、permissions 或 workspace。

旧 `action_input` 只能迁移为 `post_work_item_message(target=action)`，且必须经过新 admission、ordering 和 start gate；不能保留旧 generation mutation 语义。

### 24.4 事件

`list_work_items` 与 `get_work_item` 的 canonical DTO 必须包含 lifecycle status、`safetyStatus/safetyRevision/safetyCauseRefs`、recovery admission、terminal snapshot epoch/status、pending recovery request count 和 redacted supplemental/quarantine summary。lane projection 规则固定：terminal lifecycle + safety safe → Closed；terminal lifecycle + safety reconciling/unsafe → Needs attention；active/cancelling 保持原 lane 但显示 safety warning。前端不得仅按 lifecycle status 决定 lane 或只读提示。

`work_center_event` 是可丢失 invalidation 通知，不是事实源：

- 带 WorkItem/action/run/operation/request/safety/content revisions、recovery admission epoch、terminal snapshot epoch/status 和 cancellation epoch；
- 浏览器按全部 revision fence 刷新；`safetyRevision` 增长必须失效列表与详情缓存，即使 lifecycle status 未变化；
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

### 26.3 迁移身份原则

迁移必须使用一个高于现有 `SCHEMA_VERSION = 22` 的新 schema 版本，不能在运行期读取路径里边读边修。每个旧对象都有稳定 source identity：

```text
legacySourceKey = <sourceSchemaVersion>:<sourceTable>:<sourcePrimaryKey>
legacy input occurrence = events.id / pending_action_inputs.event_id
legacy input semantic id = event.data.inputId ?? "legacy-event:<eventId>"
```

目标表持久化 `legacySourceKey`，migration ledger 对它做唯一约束。相同正文不是同一 occurrence；正文、附件、event ID、inputId、source Run、generation、spec hash 和 identity history 都必须逐条保留。`superseded` 是永久负事实，后续 rebound 不能复活该 source event。

迁移先按 Action owner 隔离全部 event/input/run，再按事件 ID 稳定排序。事件只在 WorkItem、Action 和可选 Run owner 全部匹配时有资格迁移；identity 缺失不能当作 wildcard。旧 generation/spec 不再驱动目标调度，但必须保存在 `legacyIdentity` 审计字段，并用于判定 occurrence 是否属于当前 Action 合同。

### 26.4 schema 17–22 输入迁移矩阵

| 旧 schema / 可用证据 | 迁移规则 |
| --- | --- |
| 17–18：可能缺 generation/spec、rebound 或稳定 inputId | `event_id` 是 occurrence 身份。只有 canonical Action context、source Run transcript 或 terminal consumption 能证明已应用时才迁为 `consumed`；不能证明归属的未消费行迁为 `blocked/rejected` 审计并创建 HumanRequest，绝不自动 pending。 |
| 19：已有 Action/Run identity repair 证据 | 保留 source generation/spec/run 和 repair/supersede event；被 schema 19 instruction repair supersede 的 Run 导入 immutable historical Run，其输入是否 current 仍需 canonical context 或后续 rebound 证明。 |
| 20–21：`pending_action_inputs` 含 generation/spec/run 与 superseded/rebound audit | 同时比较 row、event、Run、Action identity；只有当前 identity 或未被 supersede 的 audited rebound 才能迁为 current occurrence。identity mismatch 迁为 rejected audit。 |
| 22：存在 repaired `inputId` / identity history | `inputId` 为 semantic identity，`event_id` 仍为 occurrence 和排序身份；相同 inputId 只能映射一个 canonical occurrence，但相同正文、不同 inputId/eventId 必须分别保留。 |

列不存在时按该旧版本的“证据缺失”处理，不用空字符串或 generation 1 猜测匹配。迁移测试必须从真实旧 schema DDL 打开数据库并经过实际升级链，不能只构造当前 DTO。

### 26.5 occurrence 状态映射

按以下优先级映射，每条 source event 只命中一次：

1. `superseded_at IS NOT NULL` 或 `action.input_superseded.sourceEventId(s)` 命中：写 rejected/cancelled ActionEntry 审计，不进入 pending，不进入新 EngineTurn；
2. `consumed_at IS NOT NULL` 且 owner/identity 可信：写 `consumed` ActionEntry，绑定到 source Run 对应的 `legacy_imported` EngineTurn；没有可证明 Run 时绑定 migration audit turn，不伪造 provider dispatch；
3. canonical context 含同一 `inputId` 或 `legacy-event:<eventId>`：迁为当前 Action thread occurrence；若已有可信 source Run consumption 则 consumed，否则按 row 状态决定 pending；
4. 未被 supersede 且存在匹配当前 identity 的 `action.input_rebound`：迁为 current occurrence，同时保留 source/target identity audit；
5. 未消费、owner 完整、匹配 current generation/spec 且从未 supersede：迁为 pending，但 WorkItem 初始为 needs_attention，migration 本身不自动 wake；
6. orphan、identity mismatch、rebound 指向已 supersede event、正文/附件与 source event 不一致：写 rejected migration audit 和诊断，不进入 prompt；必要时创建 HumanRequest 让用户显式重新发送。

附件跟随 occurrence，不按正文合并。source event 同时出现在 canonical context 和 pending row 时只生成一个 ActionEntry；migration ledger 和 `(actionId, legacySourceKey)` 唯一约束阻止重复执行产生副本。旧 `action.input_rebound` 和 `action.input_superseded` 作为审计 Event 导入，但目标 ActionEntry 状态才是运行期权威。

### 26.6 legacy Operation 三轴保守迁移

schema 17–22 没有目标模型的独立 Operation 表，迁移只能从 Run manifest、tool/task event、terminal result、resource/worktree metadata 和 OS 可验证事实重建；缺失证据不能用默认值猜测安全。每个重建 Operation 使用 `legacySourceKey = <schema>:<run-or-event-table>:<primaryKey>`，并保留原始证据引用。

| legacy 可证明事实 | effect observation | execution / cutoff | grant manifest / release 处理 |
| --- | --- | --- | --- |
| 调用尚未开始，且可证明没有 pending grant attempt、执行实体或排他资源 | `not_applied`，final，绑定 `not_started` cutoff | `not_started`；冻结空 manifest/cutoff | 无资源则 released；否则迁移不变量失败 |
| terminal success 能证明 effect，稳定 task/process identity 已 terminal/process-gone，且所有 legacy evidence channel high watermark 可闭合 | `applied`，先 provisional；迁移后基于 cutoff自动 probe才可 final | `quiescent` cutoff | 从可证明 authority/grant/resource 生成 closed manifest；逐 lease saga 从 held 开始 |
| terminal failure 声称 effect 未发生，且 execution 已 terminal/process-gone | `failed_no_effect`，provisional；必须在 cutoff 后复核 | `quiescent` cutoff | 同上，不因 failure 文本自动 final/release |
| effect 能证明已发生，但 execution 或 capability universe 无法闭合 | `applied` provisional | `hazardous_orphan`，无 cutoff | quarantine manifest open/failed，资源 held；不能升级安全 |
| active/in-flight/orphan、只有旧 `known/unknown` 摘要、缺 terminal identity，或 evidence 冲突 | `unknown` provisional | `running` 或 `hazardous_orphan` | 创建唯一 effect request；manifest inventory incomplete；资源 held |
| 可验证进程仍在运行 | 任何 effect 都 provisional | `running`，Stop 后 `cancel_requested`，无 cutoff | grant acquisition先 closing；进入 watchdog，不自动 wake |

旧 `known` 只可作为 effect 线索，不能证明 final observation、cutoff、closed grant universe 或 `quiescent/fenced`；旧 Run 终态也不能证明后台 task/process 已退出。旧数据缺少 required authority/grant/resource inventory 时，迁移器创建 `legacy_quarantine` manifest，列出 workspace 写根、已知 worktree、端口、credential、远端 target 和未知 capability占位；`inventoryComplete=false`、`resourceRelease.status=held`。无法列举全部 authority/capability时保持 `hazardous_orphan`，不允许用户 effect decision解除隔离。

迁移不能伪造外部 release 的原子性。每个已知 lease迁入独立 release row，初始 held；只有原系统已有可验证 authority/epoch/generation release proof时才迁为 released，否则由新 saga逐项释放。部分成功迁为 `partially_released`并保留逐 lease proof；迁移事务 rollback只回滚本地 shadow数据，不回滚迁移前已存在的外部事实，也不在迁移事务内执行新的外部 release。

每个迁移 Operation 都校验四组组合：effect final 必须匹配 cutoff；cutoff 必须闭合 evidence channel和 grant acquisition；fenced 必须匹配冻结 manifest的全部 grant/authority；released 必须由逐 lease proof聚合。迁移 WorkItem初始为 `needs_attention`，Start/wake/complete继续受 `operationSafeToProceed` 阻止；migration自身只允许只读 probe和既有外部事实 reconciliation，不启动新的业务执行。

### 26.7 CancellationAttempt 与 ready event 迁移

真实 schema 17–22 没有 `cancellation_attempts`、`terminal_safety_ready_events`，也没有可迁移的嵌套 `WorkItem.cancellationAttempt` 或 current-attempt pointer。迁移不得根据 `status=cancelled`、旧 `work_item.cancelled` Event、Run lease 或时间戳伪造 attempt owner、boot、lease、command identity 或 ready event：

- 目标 WorkItem 不新增 current-attempt pointer；迁移后的当前 attempt始终从规范化表的通用 live partial unique查询；
- 旧 cancelled/done lifecycle、取消 Event 和 Run evidence作为原始历史保留，但不生成 settled/superseded CancellationAttempt；旧系统没有该权威对象；
- 迁移后若 WorkItem 仍为 `cancelling` 或需要 terminal-safety recovery，由新状态机根据当前 lifecycle/safety/recovery identity 创建新的 `ready` attempt。`initial_cancel` 的 source identity 使用 migration recovery command ID；`terminal_safety_restore` 使用新生成的 ready event ID。不得把旧时间戳冒充 source identity；
- legacy done/cancelled 进入 26.8 节的 safety reconciliation 后，只有 `enqueueTerminalSafetyReadyIfEligible()` 产生的规范化 ready event 才可创建 terminal restore attempt；
- 若检测到非生产 prototype DB 中存在旧嵌套 attempt JSON，生产 migration 必须停止并给出备份/专用一次性转换诊断，不能静默猜测 owner lease。专用转换也必须为每个历史对象生成独立规范化行，保留 purpose/status/source，无法证明 owner/expiry 时收敛为 `ready` 或 `superseded`，绝不能迁为 active/settling；
- migration ledger 对新表使用稳定 key `cancellation-attempt:<workItemId>:<sourceIdentity>` 与 `terminal-ready:<workItemId>:<type>:<recoveryEpoch>:<snapshotEpoch>:<operationSafetyHash>`，重复打开数据库不能重复行；
- 真实 schema 17–22 没有 ExternalRecoveryIntent、ExternalRecoveryDispatch、ExternalRecoverySendAttempt、ExternalRecoveryAuthorityProof、ExternalRecoveryReconciliationConflict、ReclaimFenceAdvance 或 frozen dispatch policy。迁移绝不伪造 intent/dispatch/send/fence-advance 或历史 authority proof；Conflict 只可由旧库中实际存在且身份可验证的矛盾 evidence 保守重建为 pending，不得推导 resolved/superseded。新状态机创建首个 CancellationAttempt 时，从当时版本化 tool/provider/authority registry 冻结 policy payload/hash。无法找到版本化 authority contract的 entry默认 `exclusive_unfenceable_effect`；legacy in-flight external action作为 Operation unknown/hazardous evidence导入，不迁成 read-only/idempotent dispatch；
- legacy Event/tool/task 中若能看出 callback/proof 矛盾，只导入为 `authority_contract_violation,status=pending` Conflict 和规范化 evidence 子行，authority proof ID 为空并保持 admission blocked；不能从旧成功日志、旧 token 数值或 terminal Run 推导 current proof、resolved conflict 或 open admission。仅有 evidence 缺失而无合同矛盾时导入 `evidence_gap,status=pending`；
- migration ledger 为新 proof/conflict 表使用稳定 key `external-authority-proof:<authorityId>:<authorityEpoch>:<proofHash>` 与 `external-conflict:<stableIdentityHash>`；Conflict 子行按 sibling/callback/proof identity 幂等。重复迁移不能生成第二条 active conflict、重复 HumanRequest 或改变 admission epoch；迁移后只有新 control-plane query/isolation/fence proof 才能 resolve；
- prototype attempt 转换时若缺 frozen policy payload，只能写包含全部已知kind/authority的exclusive policy，并进入blocked recovery；不得只保存hash或用当前adapter能力回填较弱分类。ExternalRecoveryIntent/Dispatch/SendAttempt 与 ReclaimFenceAdvance 只由迁移后的新 recovery mutation 创建；migration ledger 分别使用 `external-intent:<attemptId>:<sourceIdentity>`、`external-dispatch:<attemptId>:<intentId>`、`external-send:<dispatchOrAdvanceId>:<attemptNumber>` 和 `reclaim-fence:<attemptId>:<authorityId>:<targetEpoch>`；
- 迁移验证要求：通用 live partial unique保证每个 WorkItem最多一行live attempt；两类purpose partial unique、command/source identity unique全部成立；不存在无 owner/boot/expiry的active/settling行，terminal行均有immutable result bytes/hash/Event/revisions；每个新attempt都有可重算的policy payload/hash，未知contract保持exclusive。

### 26.8 原子 shadow migration 与验证

1. 在单一 `BEGIN IMMEDIATE` 中创建目标 shadow tables 和 migration ledger；
2. 导入 WorkItem、Action thread、legacy identity history、Run、EngineTurn、ActionEntry、HumanRequest、Operation 的 observation/cutoff/manifest/release saga、authority/quarantine record 和 Event；按26.7节初始化CancellationAttempt、ready-event、ExternalRecoveryIntent/Dispatch/SendAttempt、AuthorityProof、ReclaimFenceAdvance空集与migration ledger；ExternalRecoveryReconciliationConflict 表只导入步骤1已从真实矛盾 evidence 证明的 pending rows及其子行。禁止新增pointer、伪造旧attempt/proof、预先resolve/supersede conflict或弱化未知外部动作分类；
3. active legacy Run 不继续执行：推进旧 lease fence，导入为 interrupted/cancelled；其 Operation 严格按 26.6 节映射 provisional effect、execution/cutoff、grant manifest 和逐 lease release，不用 `known/terminal` 猜测 final safety；
4. legacy stage/dependency 只进入 migration metadata，不进入目标调度表；
5. 对每个 source table 校验 owner、source count、occurrence count、附件 hash、终态 Run、effect final/cutoff 匹配、manifest authority/grant inventory、逐 lease held/released/failed/unknown proof和 superseded/rebound/consumed 分类总数；
6. 任一不变量失败则整笔 rollback，旧 schema 和 scheduler 保持原状；
7. 全部验证通过后在同一事务切换 schema version/table view，停用旧 graph scheduler；提交后只会看到完整旧模型或完整新模型，不存在半迁移；
8. 重启或重复打开数据库时，schema version 和 migration ledger 令迁移成为 no-op；禁止重复 ActionEntry、EngineTurn、ConversationEntry、Operation、CancellationAttempt、TerminalSafetyReadyEvent、quarantine record 或 Event；
9. 每个迁移 WorkItem 创建一条 migration CoordinatorTurn/Conversation summary，列出 blocked/rejected occurrence、unknown effect、hazardous execution 和 held resources。非终态 lifecycle 进入 `needs_attention`；legacy lifecycle 若是 done/cancelled，则保留该 lifecycle history，同时创建 `safetyStatus=reconciling/unsafe`、invalidated terminal snapshot 和 recovery-only admission，仅将列表 lane 投影到 Needs attention，不能把旧终态直接视为安全；
10. 迁移中的 late grant/lease、unknown authority 和部分外部 release 全部按 supplemental inventory/recovery release set 导入；相同 legacySourceKey/sourceEvidenceId 重放不得重复 discovery、authority request、release attempt、warning 或 recovery epoch；
11. 提交后的产品回滚使用迁移前备份和明确 downgrade 工具，不通过删除新行假装恢复。

`reopen_work_item` 不是迁移重试机制；重复 reopen 只改变 WorkItem admission，不得重新导入或复活任何 legacy occurrence。

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

- canonical lifecycle/safety projection revision、recovery admission epoch 和 terminal snapshot epoch；
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
- 消息在本地恰好绑定到一个 durable EngineTurn，不能因恢复绑定到第二个 turn；
- completed/failed/paused Action 收到消息后创建新 Run；
- superseded/closed Action 拒绝且保留 draft；
- WorkItem done 与 message 竞态只有一个事务胜出；done 提交后到达的 Operation fact 不走 message admission，而是通过 `mutateOperationSafety()` 原子失效 terminal snapshot。

### 29.2 控制竞态

- message → pause：消息保留，pause 前不启动新 turn；
- pause → message：按 sequence 请求恢复；
- pause → start：pause checkpoint 后产生新 Run；
- start 重放幂等；
- running 上 start no-op；
- stop 推进 lease，迟到 Run 结果被拒绝；
- stop 后任一 effect unresolved、execution unsafe 或 resource held 都阻止 message auto-start；
- background task 在 Pause 后仍明确展示，originating RunResult 保持不可变；
- 任一 blocking Operation 不满足 `operationSafeToProceed` 时阻止 Start、message wake、complete、cancelled 和 reopen；测试必须覆盖 effect provisional/unknown、unsafe execution、stale manifest/fence、supplemental unresolved，以及 release held/releasing/partially_released/stale；
- detached read-only Operation 只有无写资源 lease、execution 不再产生受保护副作用且输出不参与验收时才可放行；
- 后台 Operation 迟到结果受 operation revision、owner lease、execution epoch、cutoff、manifest generation/hash 和 fence epoch 约束；stale writer 不能直接覆盖权威状态，但 evidence 必须进入 durable reconciliation；
- 对 `confirm_applied/confirm_not_applied/confirm_failed_no_effect × running/cancel_requested/hazardous_orphan` 的 9 个组合，裁决都只能写 provisional observation、保留同一 pending request，不能满足 `operationSafeToProceed`；
- 上述每个组合都注入 late effect 与 terminal/process-gone：late evidence 必须先进入 reconciliation；建立新 cutoff 后必须重新 probe/确认，旧 provisional observation 不得直接升级 final；
- `confirm_not_applied` 后旧进程真实写入并退出时，最终 effect 必须收敛为 applied/unknown，而不是继续 not_applied；`confirm_applied` 后旧进程扩大 effect 时也必须使旧 observation/cutoff 失效；
- cutoff 前的冲突 evidence 原子把 final observation 降级为 provisional/unknown 并 rebind 同一 request；cutoff 后仍产生 effect 时 execution 转 hazardous_orphan、fence failed、resource held；
- 自动 effect probe 与人工 `resolve_operation` 冲突时只有一个 CAS 生效，失败方不消费 request、不改变 execution/manifest、不推进 release saga；
- 两个用户、用户与 Coordinator 的 effect 裁决冲突只有一个成功；stale operation/request revision、owner lease epoch、execution epoch、cutoff hash、manifest generation/hash 或 cancellation epoch 无副作用；
- `resolve_operation` 与 Stop、reopen、complete 并发由同一 revisions/cancellation fence 串行，不能一边裁决 effect 一边提交旧 complete；cancelling 状态的 reopen 始终拒绝；
- Agent 重启后 ActionEntry high watermark 不倒退。

### 29.3 Run 与 Engine

- 每次 resume 创建新 runId；
- 旧 Run 终态不可改写；
- 多次 Action message 按数量和顺序进入模型；
- `prepared` 前后崩溃安全 dispatch 同一 request hash，不重新归约 entries；
- `dispatching` 后崩溃时，无 provider 幂等/查询能力就进入 `dispatch_unknown` 且不自动重发；
- `dispatch_unknown` 阻止新 Run、wake 和 complete；`resolve_engine_turn` 的裁决 CAS 只能在同一 Run/turn 采用已验证查询结果、明确允许新 attempt 或取消；
- EngineTurn 首次 unknown 与重启扫描并发只创建一个 pending `engine_turn_dispatch` request；重复扫描不推进 identity；
- 两个用户、用户与 Coordinator 的冲突/重复裁决只有一个事务生效，stale requestId/request revision/requestHash/attempt/run revision/cancellation epoch 无副作用；
- Stop 与 `resolve_engine_turn` 并发只有一个事务生效；Stop 胜出后 request 被取消，迟到裁决不能恢复 turn/entry，provider response 的 turn 结果进入冷审计，但其中的 Operation effect/grant/resource evidence 必须进入 durable reconciliation；
- responded response CAS 后恢复不重复 provider 调用；
- provider failure 不把 message 绑定到第二个 EngineTurn；
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
- 任一 blocking Operation 不满足 `operationSafeToProceed` 时阻止 Start；
- 未授权 Session 不可搜索；
- 同 workDir 不自动授权；
- VP private 不被其他 VP直接读取；
- shared 只能由 Coordinator 接受；
- Work Center 数据不写项目目录。

### 29.6 WorkItem stop、完成与迁移

- 对 lifecycle `done` 和 `cancelled` 分别注入三类迟到事实：cutoff 前冲突 evidence、cutoff 后新 effect、late grant/lease。每个 case 都必须在写事实的同一事务把 current terminal snapshot invalidated、推进 safety/work-item/operation revisions、打开唯一 recovery epoch、写 warning/Event/notification，并把 canonical DTO/lane 从 Closed 投影到 Needs attention；不得等待 reopen；
- terminal safety invalidation 后业务 composer/Action controls 继续只读，但 recovery-only request/probe/fence/release 可执行；普通 CoordinatorTurn 不能跨入 recovery epoch，只有唯一 recovery-mode turn 可提交受限命令；
- 多个并发 late facts 复用同一 recovery epoch，追加 cause refs；重复 evidence/discovery 不重复 warning、request、notification 或 Coordinator recovery turn；
- 首次 `cancelling → cancelled`：Controller/Watcher 使用 `purpose=initial_cancel` attempt 调用 `finalizeWorkItemCancellation()`；它不经过 `restoreTerminalSafety()`，成功原子写 `work_item.cancelled` 和 attempt settled，失败 rollback 后 attempt 保持 active；
- 已 cancelled 后 safety restore：`cancelled_safety_ready_for_terminalizer` 由 Watcher 认领，事务按 ready-event sourceIdentity 查回或创建规范化 `purpose=terminal_safety_restore,status=ready` 行，再调用共享 `claimCancellationAttempt()`；owner 接管必须复用 attempt ID、替换 ownerId/ownerBootId 并原子递增 ownerLeaseEpoch；全部 Operation/supplemental/reconciliation 收敛后，在同一外层事务把 attempt active→settling 并以 tagged `cancelled_terminalizer` 调用 shared restore。它没有 CoordinatorTurn、assessment 或 lifecycle 选择，只能恢复 cancelled，成功写 `work_item.cancelled_safety_restored` 并永久保留 settled attempt；
- recovery turn 含任一 `resolveOperations` 时 `restoreTerminalSafety` 必须为 null；最后一项 resolution 提交后仅在 post-resolution 权威状态已满足全部条件时原子排队唯一 `terminal_safety_ready_for_restore` event，并创建**新的** recovery CoordinatorTurn；不得使用旧 turn 的 pre-resolution snapshot restore；
- `done invalidated → all safe → 新 recovery turn → restoreTerminalSafety(resultingLifecycle=done)`：Coordinator 提交完整 acceptance results/finalResult evidence；服务端重算 safety hash和 evidence ownership，写新 current done snapshot、restored event，关闭 recovery admission，lane 回 Closed；
- `done invalidated → acceptance failed → restoreTerminalSafety(resultingLifecycle=needs_attention)`：至少一条 acceptance 非 pass 或阻塞风险；保留旧 finalResult/snapshot history，lifecycle 转 needs_attention，恢复普通 Coordinator admission，不创建/启动 Action，lane 留在 Needs attention；
- resolve 最后一项 request 后，验证只有新 recovery turn 能 restore；旧 resolution turn 同时携带 restore 必须 schema 拒绝。覆盖一个 resolution、两个按稳定 operation/request identity 排序的 resolution、resolution 提交前插入 late evidence、重复 resolution command和 ready-event重放；任何额外 row/revision 变化都使 resolution或后续新 turn snapshot失效，不允许猜测 revision delta；
- H1 ready event 已 pending/claimed 后注入 late evidence，恢复为 H2 时必须在同一 helper事务把 H1 event及旧 CoordinatorTurn/Watcher claim置为 superseded、清除 claim lease并创建/复用H2；superseded H1不计入未处理 mailbox，不能阻塞H2 restore。重复H1/H2 callback和Agent重启保持单一live event；
- restore 与新 late evidence 并发：late fact 先提交则 operation/safety/snapshot revision使 restore 无副作用；restore 先提交则 late fact 通过 `mutateOperationSafety()` 立即失效新 snapshot并打开下一 recovery epoch，不能丢事实或保持 Closed；
- 旧 recovery CoordinatorTurn、重复 command id、两个 recovery turn、restore 与 `resolve_operation` stale、terminal snapshot 已再次失效/恢复等竞态都只有一个完整事务成功；失败方不修改 finalResult、lifecycle、admission、warning 或 lane；
- cancelled 无 CoordinatorTurn 的合法 safety restore 必须成功；旧/wrong-purpose/superseded cancellationAttemptId、旧 owner lease/cancellation/recovery/snapshot epoch、重复 terminalizer、late evidence并发和伪造 internal caller必须无副作用。失败时 attempt不得卡在 settling；shared core对 coordinator与cancelled_terminalizer分别执行 caller校验，禁止“没有 CoordinatorTurn就跳过鉴权”；
- `initial_cancel` attempt 不能调用 restore，`terminal_safety_restore` attempt 不能调用首次 finalize；两类 caller tag、command identity、Event 和 lifecycle前置条件不可互换。覆盖首次取消、cancelled late invalidation后恢复、失败重试和进程重启；
- 两种 purpose 都重放 Controller/Watcher 在 claim 前、Run/Operation 收敛中、active→settling 前和 finalize/restore 事务内崩溃；Agent启动扫描复用同一attempt ID。未过期lease下boot变化、registry缺失、PID消失但无execution-fence proof都不得抢占；旧owner续租/finalize、重复reclaim和两个Watcher并发只有一个CAS成功，不得产生第二个ready/active/settling attempt；
- cancelled ready event 的重复认领、Watcher崩溃和owner lease到期使用同一共享协议；旧owner caller无副作用。initial_cancel在Stop提交后、Run收敛中和finalize前崩溃都能按dispatch最强分类安全接管或明确blocked，不能以split-brain换取收敛；
- expiry reclaim后旧owner恢复并尝试每类**新**dispatch：read-only可重复但只能产生evidence；idempotent effect必须复用同一dispatch行、同一key和相同request/target，same key/different bytes或different key重表达同一identity均被数据库/authority拒绝；authority-fenced effect旧token由authority拒绝；exclusive-unfenceable effect在无exit+execution-fence proof时reclaim与新dispatch都blocked；
- 旧/新owner同时调用`prepareExternalRecoveryDispatch/authorizeExternalRecoverySend`：旧owner因owner/boot/lease/fence stale在send前失败；若旧owner已拿到envelope后暂停，则按四类contract分别验证无副作用、同key同effect、低token拒绝或禁止并存。覆盖授权后网络发送前暂停、发送成功回调前崩溃、callback迟到和新owner重试；
- frozen policy payload/hash在重启后可重算；篡改payload/hash、当前registry降级分类、未知kind/authority或缺versioned contract均转blocked/exclusive，不能外发。schema17–22迁移后首个attempt冻结当前versioned policy；legacy unknown external action不被迁为弱分类；
- authority-fenced reclaim覆盖多个authority：每个ReclaimFenceAdvance使用稳定key/target，A成功B失败时DB owner不切换；崩溃后查询A并补proof、以原key重试B。全部confirmed后reclaim单事务推进attempt fence和owner。重复advance、same key/different target、不同key同target及旧target callback均不能产生第二个epoch或切换owner；
- fence advance 网络发送必须走 `beginReclaimFenceAdvanceNetworkSend()`，不得走要求当前owner lease的普通 `beginExternalRecoveryNetworkSend()`。覆盖 lease 已过期、旧owner仍写在attempt行、两个Controller并发发送、authorized后暂停、authority成功本地未落盘、重复send-attempt和controller重启；所有外发只能是同key/同target/同bytes的token advance，不能携带业务payload或授予普通dispatch权限；
- 普通 dispatch：attempt 1=`unknown`，attempt 2同logical ID/key/request/target/contract=`confirmed`。`reconcileExternalRecoveryLogicalResult()` 必须原子写logical confirmed、intent satisfied、confirmedAttempt/proof，并把attempt 1转`reconciled`且保留原envelope/callback/response；finalize blocker归零。事务在logical更新、sibling reconciliation、intent更新或Event之间崩溃时整笔rollback，重放产生同一结果；
- authority query确认同一logical effect时，proof必须显式列出覆盖的unknown sibling IDs。覆盖全部则按上条收敛；只覆盖部分则仅对应sibling可reconciled，logical仍unknown、intent仍prepared、finalize继续blocked；
- same key/different request bytes或semantic target、different key重表达同一identity、不同authority contract/fence token的成功attempt都不能覆盖旧unknown sibling；logical不能confirmed。exclusive-unfenceable unknown只有逐sibling query proof可收敛；
- fence advance同样覆盖attempt 1 unknown→attempt 2同key/target confirmed；旧unknown send-attempt必须转reconciled后advance才confirmed。多authority A已confirmed、B仍unknown时reclaim继续blocked；B查询/重试confirmed并reconcile其siblings后才允许owner/fence切换；
- query-only reconciliation：持久化 current `ExternalRecoveryAuthorityProof(proofKind=authority_query)`，用 tagged source 写 `reconciledByKind=authority_query/reconciledByAuthorityProofId`；不提供 send-attempt ID。SQLite CHECK 必须接受该合法组合，并拒绝 kind/ID 均空、两 ID 同时非空、send kind 缺 send ID、query kind 缺 proof ID；普通 dispatch 与 fence advance 对称；
- active conflict partial unique：同一 stableIdentity 并发插入/重启重放只产生一条 pending Conflict；新增 sibling/callback/proof 只追加唯一子行，不改变 stable identity。resolved/superseded terminal CHECK 要求完整 proof/Event/time，pending request 与 conflict 同事务创建/消费；无 Operation 的 Run/Task/fence-advance 也能查询同一 SSOT；
- low-token/fence proof conflict：已消费的 confirmed ReclaimFenceAdvance 收到认证低-token accepted 或 proof 冲突 callback时，同一事务创建 `authority_contract_violation`、把 proof/advance/attempt authority safety置 stale、递增并阻塞 dispatch admission、supersede尚未发送行、保留sending/unknown sibling。四个 gate `prepareExternalRecoveryDispatch/authorizeExternalRecoverySend/beginExternalRecoveryNetworkSend/beginReclaimFenceAdvanceNetworkSend` 都必须拒绝新发送；不回退owner/fence epoch；
- `authority_contract_violation` 解除矩阵：同一被质疑 authority 的普通 confirmed attempt、用户文本确认、普通业务 callback都必须拒绝且 Conflict保持pending/admission blocked。仅独立authority query、operator isolation或更强authority epoch/fence proof可resolve；proof须current并高于minimum epoch，事务原子恢复proof/advance safety、解除hazardous/quarantine、消费HumanRequest并在没有其他active contract conflict时重新open admission；
- reconciled sibling迟到callback：与proof一致时幂等附加evidence；冲突时写通用 reconciliation conflict、logical/intent降回unknown/prepared、`operationSafeToProceed=false`，不能恢复旧owner或删除旧证据。覆盖重复callback、重复reconciliation、stale Event identity和Agent崩溃重开；
- recovery turn command 混入 reply/contract/action/control/openRequest/complete 必须整体拒绝；普通 Coordinator、用户、Executor 和浏览器直接调用 `restore_terminal_safety` 必须在 mutation 前拒绝且无 Event；
- `resultingLifecycle=done` 缺 acceptance result、重复/未知 criterion、越权 evidence、未清 pending recovery state或 payload safety hash 与服务端重算不一致时拒绝；`needs_attention` 没有任何失败/阻塞风险时拒绝，防止无依据降级；
- terminal lifecycle + safety safe 投影 Closed；terminal lifecycle + reconciling/unsafe 投影 Needs attention。恢复 done、转 needs_attention、再次 late invalidation 的 Event/DTO/cache revision和 lane必须同步；断线重连、列表缓存和详情缓存都以 safetyRevision/terminal snapshot epoch 失效；
- released 主 saga 后发现 late lease：旧 aggregate 立刻 stale，新 discovery 进入 append-only supplemental inventory，冻结 recovery-only release set，全部 proof 前 `operationSafeToProceed=false`；
- closed manifest 后发现 late derived token/grant：旧 cutoff/fence/manifest safety 投影 stale，关闭 supplemental acquisition，保留 parent/issuer/credential/resource-set identity，不能重新开放业务 acquisition；
- unknown authority 创建唯一 `supplemental_authority` request；map 后只启动 closure/release，unresolvable 保持 unsafe quarantine。重复 callback、第二个 late object 和 Agent 崩溃恢复都复用 generation/idempotency key，已 released/revoked 项不重复执行；
- pending/bound ActionEntry 阻止 WorkItem done；
- queued/running/dispatch_unknown/pausing/stopping Run 阻止 done；
- 任一 blocking Operation 不满足 `operationSafeToProceed` 时阻止 done；
- stop 与并发 message/start/complete 只有一个事务胜出，不产生部分输入；
- stop 单事务推进 WorkItem cancellation epoch 和全部 active Run lease epoch；
- stop 保留 terminal Run；queued Run、仅有 prepared EngineTurn 的 Run 和 dispatch_unknown Run 在取消事务内立即产生 cancelled/interrupted RunResult；真实 running Run 经 cancellation attempt/watchdog 收敛；
- Agent 在 stop 提交后崩溃，重启 watchdog 仍使用原 durable deadline；超时或 owner/process 不可查询时确定性写 interrupted，不永久停在 stopping；
- 重复 Stop 复用 `(runId, cancellationEpoch)` attempt，不延长 deadline、不重复 RunResult/Conversation/Event；
- stop 与 cancel acknowledgement、正常完成、迟到 provider response 并发时，terminal RunResult 只有一个；旧 lease 不能改写 Run/turn，但其中的 Operation effect/grant/resource evidence 必须幂等进入 reconciliation/supplemental inventory；
- stop 把所有未绑定 ActionEntry、pending HumanRequest 和新工作 mailbox admission 收敛为 cancelled audit；bound EngineTurn 按 responded/prepared/dispatching/unknown 分别裁决，迟到 response 不能复活 entry；
- stop 后 Operation 的 effect observation、execution cutoff、grant manifest 和逐 lease release saga 分别收敛；running 只能前进到 cancel_requested，hazardous_orphan 不得降级；活 execution 下的 effect decision 保持 provisional 并保留/rebind同一 request；
- 三个 `confirm_applied/confirm_not_applied/confirm_failed_no_effect` 在 execution 仍为 `running/cancel_requested/hazardous_orphan` 时必须保持 resource held，并拒绝 cancelled、reopen、Start 和 new Run；只有新 cutoff 上的 final observation 才可消费 request；
- grant attempt 与 manifest closing 并发只有一个顺序生效：attempt 先提交则必须进入冻结 inventory并等待收敛，closing 先提交则 grant/refresh/derived-token 在数据库和 authority 两侧都被同 generation/acquisition epoch 拒绝；
- credential refresh、派生 token、新 authority 与新 resource-set generation 都必须先登记且属于冻结 capability universe；并发扩权、未登记 grant、parent/issuer/generation 不匹配均使 Operation hazardous_orphan，不能形成 enforced fence；
- fence 必须精确核对 capability-universe generation/hash、manifest generation/hash、全部 grant ID/parent、issuer epoch、credential generation、resource-set generation 和 authority closure proof；任一缺失或 stale 都阻止 fenced 和 release；
- 只有 process-gone/cancel acknowledgement 令 execution `quiescent`，或完整 authority proof 令其 `fenced`，且逐 lease saga 全部有有效 proof 后，才可收敛 cancelled；
- authority A release 成功、authority B 失败/unknown 时聚合必须是 `partially_released`；SQLite rollback 不得把 A 的物理释放伪造回 held，也不得提前写 aggregate released；
- partial release 后 Agent 崩溃，恢复器按 A 的原 idempotency key 查询并补写/确认 proof，对 B 使用原 attempt/key 重试；不得重复释放 A、创建 B 的新 attempt 或丢失部分状态；
- duplicate/stale authority callback 只有匹配 lease ID、authority、lease epoch、release-set generation 和 attempt 的 CAS 可生效；全部最新 lease proof 齐全前 `operationSafeToProceed` 必须为 false；
- reopen 后 open Action 可接收新 entry 并创建新 Run，superseded/closed Action 不复活；
- cancelling WorkItem 的 unresolved effect 只允许 `resolve_operation`，execution/resource 只允许系统 probe/fence/release；三轴全部安全并进入 cancelled 后才允许 reopen；
- 真实 schema 17/18/19/20/21/22 fixture 经完整版本链导入 Action threads、Runs 和 legacy EngineTurns；
- 相同正文、不同 eventId/inputId occurrence 分别保留，附件不按正文折叠；
- superseded occurrence 只进 rejected audit，rebound 不得复活它；
- consumed occurrence 绑定 legacy_imported EngineTurn，未消费可信 occurrence 不由 migration 自动 wake；
- orphan/identity mismatch occurrence 不进入 prompt，并产生可解释诊断；
- 重复 migration 受 legacySourceKey ledger 唯一约束，不重复 entry/turn/event；
- active legacy Run 不盲目继续；其 Operation 按 26.6 节保守导入，无法证明的 effect 为 provisional/unknown、execution 为 hazardous_orphan、manifest inventory incomplete、resource saga held，并阻止 wake；
- legacy `known`/Run terminal 不能证明 final observation、execution cutoff 或 closed capability universe；缺 authority/grant/resource inventory 时创建 quarantine manifest/authority record；
- migration 对 observation/cutoff、capability universe/manifest、逐lease saga、partial unique `operation_effect` request、CancellationAttempt通用/purpose partial unique、command+source identity、terminal result snapshot、ready-event live unique、intent/dispatch/send-attempt/fence-advance CHECK与unique、AuthorityProof tagged CHECK/query identity、Conflict terminal CHECK/active partial unique/子行unique、policy payload/hash及send reconciliation字段做计数与不变量校验；相同 legacySourceKey 重放不重复 grant、lease attempt、reconciliation evidence/Event、attempt、ready event、dispatch、send attempt、proof、conflict、fence advance或request。legacy数据不伪造`reconciled`或resolved conflict；只有迁移后取得逐sibling current authority proof才能写入；
- 用真实schema17/18/19/20/21/22 fixture验证迁移后attempt/ready-event表为空且WorkItem schema没有attempt pointer；随后触发 initial_cancel 与 terminal safety restore，验证各自产生独立规范化行，settled/superseded 历史永久保留，重复 migration/open/Stop/ready event 不重复行或 command/source identity；
- 专用 prototype 嵌套对象转换 fixture 覆盖无法证明 owner lease时只迁为 ready/superseded，绝不迁为 active/settling；purpose epoch CHECK、通用/purpose live partial unique、terminal result CHECK和历史审计全部通过；
- shadow migration 校验失败整笔 rollback，成功切换只有完整旧/新模型；
- 重复 reopen 幂等且不会重新迁移 occurrence；
- 目标数据库没有 dependency/stage 调度语义。

---

## 30. 实施顺序

设计经独立复审通过后再实现：

1. **规范化存储**：Conversation、ActionEntry、Action、Run、EngineTurn、HumanRequest、Operation、CancellationAttempt、TerminalSafetyReadyEvent、ExternalRecoveryIntent、ExternalRecoveryDispatch、ExternalRecoverySendAttempt、ExternalRecoveryAuthorityProof、ExternalRecoveryReconciliationConflict、ReclaimFenceAdvance。
2. **Runner 协议**：durable provider dispatch、safe checkpoint、entry bound/consumed high watermark、Run lease、消息注入。
3. **控制命令**：Pause/Start/Stop、WorkItem cancellation epoch、Operation liveness gate、恢复。
4. **Coordinator 合同**：create/control/message Action，不包含 graph。
5. **Wire**：单一 WorkItem message 入口、Action control、unknown EngineTurn/Operation resolution、结构化 external recovery conflict resolution、recovery-only terminal safety restore、ContentRef 读取。
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
- [x] running Action 的新消息在安全边界绑定到唯一 durable EngineTurn。
- [x] provider dispatch 的幂等/未知边界、唯一 HumanRequest 和 fenced 恢复裁决已明确。
- [x] 非 running open Action 的消息默认触发新 Run。
- [x] Start 不伪造用户消息。
- [x] Pause 不承诺撤销副作用，跨 Run Operation liveness 独立持久化。
- [x] WorkItem Stop 具有全局 admission/lease/cancellation 原子边界。
- [x] Operation effect observation、execution cutoff、capability universe 与逐 lease release saga 正交持久化；任一不安全都阻止 Start、wake、complete、cancelled 和 reopen。
- [x] 活 execution 下的 effect decision 只能 provisional，final evidence 必须绑定闭合 cutoff，迟到事实必须 reconciliation。
- [x] grant acquisition 由冻结 capability universe 与 authority epoch 约束，fence 不能靠自报 covered capabilities。
- [x] 跨 authority release 逐 lease 幂等恢复，支持 partially released，不承诺 SQLite 回滚外部动作。
- [x] Coordinator Operation 裁决与 wire 复用同一权威 mutation，不存在旁路。
- [x] recovery-mode Coordinator 通过唯一 `restoreTerminalSafety` command 恢复 done 或转 needs_attention，禁止复用普通 complete。
- [x] legacy input occurrence、superseded/rebound/consumed 与重复迁移合同已定义。
- [x] 没有 DAG、依赖图、stage 或 workflow template。

本文档通过独立设计复审后即成为实现基线；领域合同变化必须先更新设计并重新复审。
