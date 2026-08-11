# WebRTC Browser Runtime 设计

- 状态：设计提案，作为实现拆分与验收契约
- 日期：2026-08-07
- Owner：Linus
- 范围：从 Web UI 低延迟观看和控制 Agent 本地 Chromium，并允许用户与 Yeaft 共用同一个浏览器上下文
- Phase 0 实测结果：[`2026-08-08-browser-runtime-phase-0-results.md`](./2026-08-08-browser-runtime-phase-0-results.md)

## 1. 决策摘要

Browser Runtime 的实时数据面采用 WebRTC，但系统不做成“只有 WebRTC”：

- **WebRTC VideoTrack** 承载 Chromium 页面画面；
- **WebRTC DataChannel** 承载用户实时输入和轻量运行状态；
- **现有 authenticated WebSocket / HTTP** 继续承载鉴权、Agent 选择、Browser Session 生命周期、SDP/ICE 信令、TURN 临时凭证、重连和错误恢复；
- **Yeaft Engine 与 Chromium 同在 Agent**，AI 操作直接调用本地 Browser Runtime，不绕 WebRTC，也不经 Server 中转；
- **Server 只做 owner-checked 控制面 relay**，不解码媒体、不持久化 SDP/ICE、不成为 SFU；
- **TURN 是生产必需能力**，不能把“多数情况下能 P2P”当作可用性保证；
- **授权用户与 Yeaft 可以同时提交动作**，不做用户↔VP 的排他控制权转移；Agent 以 producer 身份、generation、独立的 control/pointer 序号和 page revision 做 fencing，并在唯一 action dispatcher 中串行执行；
- 第一阶段只支持一个可见 page、无音频、无录屏持久化、无多个 Web 用户共同编辑。

主媒体/数据 endpoint 固定为**受控 Chromium 扩展的 offscreen document**：它拥有 `RTCPeerConnection`、DataChannels 和 video sender，Agent Node 只负责授权、信令协调、Chromium 生命周期、AI 工具与串行动作执行。首选媒体源是同一扩展中的 `tabCapture`，`MediaStreamTrack` 不跨进程传递。CDP `Page.startScreencast` 只作为受能力探测约束的 fallback：Agent 把有界的最新 JPEG/PNG 帧经本机 IPC 交给同一个 offscreen endpoint 解码、绘制并从 canvas 生成 track；该路径成本和延迟都更差。

不接受以下实现：

1. 把 JPEG/PNG frame 塞进 DataChannel；
2. 把 SDP、ICE 或 TURN credential 写入普通 Session transcript；
3. 用户输入同时经 DataChannel 和 WebSocket 双写到 Chromium；
4. 用裸 `sessionId` 或客户端声称的 `userId` 做 owner 判断；
5. WebRTC 断开后自动重放旧键盘、点击或导航动作；
6. 为了 Browser Runtime 把 Server 改成媒体代理。

## 2. 背景与现有边界

当前拓扑已经分成 Browser、Server、Agent 三层：

```text
Browser (Vue / Pinia)
  <-> authenticated HTTP + WebSocket
Server (Express / ws / SQLite)
  <-> owner-checked WebSocket relay
Agent (workbench + CLI providers + Yeaft engine)
```

现有实现提供了可以复用的控制面基础：

- `server/ws-client.js` 在分发前要求 Web client 已认证，并通过 `resolveAgentAccessError()` 检查 Agent ownership 和在线状态；
- `server/ws-utils.js` 的 `verifyAgentOwnership()` 以 Agent owner 为边界，Agent-scoped event 可由 `forwardAgentEvent()` 只投影给有权用户；
- `agent/index.js` 已在注册时上报 capability 列表，Browser Runtime 应通过新 capability 渐进启用；
- `web/stores/helpers/websocket.js` 已有连接 generation、指数退避、心跳和移动端恢复逻辑；
- Agent 断线缓冲只允许白名单消息，实时媒体和输入不应进入 `agent/connection/buffer.js`；
- 同名 `sessionId` 可由不同 Agent 拥有，跨 Agent 身份必须包含 `agentId`。

当前仓库**没有 Browser Runtime、`browserSessionId` 或 WebRTC wire**，Agent production dependencies 也没有 Chromium automation 或 production browser peer runtime。因此本文定义的是未来协议和组件边界，不描述已交付功能。

## 3. 目标、非目标与成功指标

### 3.1 目标

1. 用户从现有 Web UI 创建并打开一个 Agent-local Chromium。
2. 桌面环境中，用户输入到画面变化的 p95 延迟在 direct/host candidate 下不超过 250 ms，在同区域 TURN relay 下不超过 400 ms。
3. 画面根据网络和页面活动自适应，默认目标为 1280×720、24 fps；静态页面主动降帧。
4. WebSocket、ICE、Browser page 或 Agent 短暂故障都有有限、可观察、可恢复的状态机。
5. 用户和 Yeaft 操作同一个 `BrowserContext`，但不会无序并发写入。
6. Server 不接收媒体 payload，且所有控制消息都执行 user + Agent + Browser Session ownership 检查。
7. CPU、内存、网络、Session 数量和空闲时间有硬上限，不产生无界后台 Chromium。

### 3.2 非目标

- 不提供通用远程桌面、VNC 或整个 OS 画面；
- 不提供多人同时编辑、SFU、会议或公开分享链接；
- 不在第一阶段传音频、麦克风或摄像头；
- 不跨 Agent 迁移一个活跃 Browser Session；
- 不保证 Browser Session 在 Agent/Chromium 进程重启后保持内存态；
- 不自动持久化视频、网页正文、cookies、localStorage 或访问凭据到 Server；
- 不把 Browser Runtime 作为绕过现有 WebSearch/WebFetch ownership 和数据投影规则的通道；
- 不在本文选择具体 extension peer runtime、TURN 或 Chromium automation package；这些必须经过 spike 与供应链 review。

### 3.3 SLO 与容量基线

| 指标 | 初始目标 |
| --- | --- |
| Session create → 首帧 p95 | direct ≤ 3 s；TURN ≤ 5 s |
| 输入 → 可见反馈 p95 | direct ≤ 250 ms；TURN ≤ 400 ms |
| ICE 建连成功率 | ≥ 99.5%，包含 TURN fallback |
| ICE restart 成功率 | ≥ 95%（一次自动 restart） |
| 视频冻结检测 | 3 s 无 decoded frame 且页面非静态时告警 |
| Agent 默认并发 Browser Sessions | 2（可配置且有硬上限） |
| 无 viewer 空闲回收 | 2 分钟 |
| 有 viewer、无交互空闲提示/回收 | 30 分钟 / 35 分钟 |

这些是 rollout gate，不是永远固定的产品承诺。实现必须通过 telemetry 校准，不能为了命中 fps 持续烧 CPU。

## 4. 术语与身份

| 名称 | 含义 |
| --- | --- |
| `Browser Runtime` | Agent 上拥有 Chromium 生命周期、page、媒体源和输入执行的服务 |
| `browserSessionId` | 一个 Agent-local 浏览器执行单元的随机、不透明 ID |
| `peerId` | 一次 Web viewer attachment；每次 attach/reconnect 新建 |
| `connectionGeneration` | 同一 peer 的 offer/answer/ICE fencing generation |
| `producerId` | Agent 授予一个输入生产者的短期不透明 ID；Web peer、VP turn 各自独立 |
| `producerGeneration` | 该 producer 的授权 fencing generation；重连、turn 结束或撤权后递增 |
| `controlSeq` | 一个 producer 在 reliable control 路径上的连续序号；必须 gap-free |
| `pointerSeq` | 一个 Web producer 在 lossy pointer 路径上的单调高水位序号；允许 gap，只拒绝 stale/duplicate |
| `pageRevision` | 顶层导航或 active page 变化后递增，用于丢弃旧坐标事件 |
| `actionId` | 一次需要 ack 的用户或 AI 动作 ID，在 producer scope 内唯一 |

权威身份是：

```text
(ownerUserId, agentId, browserSessionId)
```

`peerId`、`connectionGeneration`、`producerId`、`producerGeneration` 和 `pageRevision` 都是其下的临时 fencing 字段。不要将 Browser Session 复用为 Yeaft Session，也不要把 `conversationId` 当作 Browser Session owner。创建请求可以带来源引用：

```js
sourceRef?: {
  kind: 'yeaft-session' | 'chat-conversation' | 'work-item',
  sessionId?: string,
  conversationId?: string,
  workItemId?: string
}
```

`sourceRef` 只用于 UI 返回路径和审计，不能替代 Agent ownership 检查。

## 5. 总体架构

```text
Browser Web UI
  BrowserPanel + browser Pinia store
  RTCPeerConnection (answerer)
       │
       ├── VideoTrack: Chromium tab
       ├── DataChannel control: reliable / ordered
       ├── DataChannel pointer: unordered / maxRetransmits=0
       └── DataChannel state: reliable / ordered
       │
       │  ICE direct or TURN relay (DTLS-SRTP + SCTP)
       ▼
Controlled Chromium extension offscreen document
  RTCPeerConnection (offerer) + DataChannels
       │
       ├── tabCapture MediaStreamTrack (same extension process)
       └── authenticated local runtime port
             ▼
Agent Browser Runtime
  ├── Playwright/CDP page control
  ├── producer authorization + bounded action dispatcher
  ├── context/page lifecycle
  ├── download/upload policy
  └── bounded diagnostics

Browser Web UI
       │ authenticated WSS / HTTPS (control + signaling only)
       ▼
Yeaft Server
  auth + Agent ownership + Browser Session route table
       │ existing owner-scoped Agent WSS
       ▼
Agent Browser Control Adapter
  lifecycle + SDP/ICE + TURN credential request + status
```

### 5.1 组件职责

#### Web

新增独立 `browser` store，不把 Browser ownership 塞进 `chat.js`：

- 按 `agentId + browserSessionId` 保存 snapshot；
- 管理 `RTCPeerConnection`、remote video、DataChannels 和 stats sampling；
- 把 DOM pointer/keyboard/viewport 事件转换为 protocol message；
- 只在 peer、connection generation 和 Web producer authorization 都匹配时发输入；
- WebSocket reconnect 后重新取 authoritative snapshot，再 attach 新 peer；旧 peer 不恢复写权限；
- 显示 direct/relay、延迟、输入已禁用、重连、Agent 离线和 Session 已销毁状态。

#### Server

- 验证 Web 用户身份、角色/entitlement 和目标 Agent ownership；
- 为 lifecycle request 提供 request correlation 与 safe error；
- 维护**易失**的 Browser Session route metadata，或从 Agent snapshot 重建；
- 在转发 create/attach 时覆盖客户端自报身份，向 Agent stamp `ownerUserId`、`clientId`、`webConnectionId` 和 `webConnectionGeneration`；
- 将 Web 发来的 signal 只转给 session owner Agent；
- 将 Agent signal 只转给发起 attachment 的确切 `clientId`；
- 在 attach/restart bootstrap 中先签发 endpoint-scoped 短期 TURN credential，再允许 Agent 创建 peer/offer；
- 实施每 user、每 Agent 的创建/attach rate limit；
- 不读取 SDP 内容做业务逻辑，不保存媒体，不缓存实时输入。

#### Agent

- 是 Browser Session、Chromium context、page、producer authorization 和 action ledger 的权威 owner；
- 启动固定版本、受控参数的 Chromium，不连接用户日常浏览器；
- 通过受认证、只绑定当前 Browser Session 的本机 runtime port 驱动扩展 offscreen peer；offscreen endpoint 生成 offer、处理 answer/trickle ICE、创建 DataChannels 和 VideoTrack；
- 接收 Server-stamped identity，不信任 Web payload 中的 owner/client 字段；
- 串行执行用户与 AI 动作，校验 producer generation、对应通道的 sequence space 和 page revision，并应用队列配额；
- 采集有界状态与指标并通过控制面上报；
- Agent 控制连接丢失时立即撤销 Web producer、释放按键/按钮并关闭 peer；Agent 重启时关闭内存态 Browser Sessions。

#### TURN

- 部署 UDP + TCP + TLS 入口，至少支持 `turn:` UDP 和 `turns:` TCP/443；
- 使用 5–10 分钟 TTL 的临时 credential，username/签名 scope 绑定 `ownerUserId + agentId + browserSessionId + peerId + connectionGeneration + endpointRole(web|agent) + credentialId + expiry`；Web 与 Agent endpoint 使用不同 credential；TURN REST shared-secret credential 本身通常只能由 TURN 校验 username/expiry，因此 `credentialId` scope 还必须由 Server route ledger 强制，不能假称 TURN daemon 理解业务字段；
- attach/restart request 以 `requestId + connectionGeneration` 幂等；重复请求返回同一未过期 credential，generation 结束、peer close、超时或失败时撤销 Server route/credentialId 并让既有 TURN allocation 在短 TTL 内自然过期；如果部署要求立即 cut-off，必须使用 TURN management API 主动删除 allocation，不能把删除 route 描述成已经撤销 TURN credential；
- 有带宽、allocation、并发、日志脱敏和滥用限制；
- credential 只在 authenticated attach/restart bootstrap 中返回，并分别只投影给对应 endpoint；credential TTL 不能超过 peer route TTL，过期前需要 restart/new generation，禁止原 generation 静默续签；
- Server 不持久化明文 TURN secret。

## 6. Chromium、媒体与 AI 控制

### 6.1 BrowserContext 所有权

每个 `browserSessionId` 拥有一个隔离的 Chromium `BrowserContext` 和一个 active page：

```text
BrowserSession
  ├── BrowserContext (cookies/storage/cache isolated from other sessions)
  ├── active Page
  ├── capture target + logical peer record in the shared offscreen peer host
  ├── authorized Web/VP producers
  ├── bounded action queue + action ledger
  └── one or more viewer peers (phase 1 default max: 2)
```

第一阶段固定使用一个 Browser Runtime 专用的临时 Chromium user-data-dir，并在 Runtime shutdown 后删除；其中每个 Browser Session 使用独立 incognito `BrowserContext`，Session close 时销毁该 context，不提供登录态跨 Browser Session 保留。一个 Chromium process 可以托管多个隔离 context；extension offscreen document 是该 profile 的共享 peer host，但其 peer/capture/action state 必须按 Browser Session 隔离。持久 context/profile 会改变磁盘 owner、扩展加载、cookie/storage、崩溃恢复、加密和删除语义，必须另做设计、单独 capability 和 migration；不能把临时 context 悄悄替换为 `launchPersistentContext()`，也不能写入普通 Session 数据目录。

Chromium 启动约束：

- executable/version 固定并做 capability probe；
- remote debugging 只监听 loopback 或 private pipe，不暴露 TCP 到网络；
- 扩展固定 digest，禁止从任意路径加载；
- 不使用 `--no-sandbox` 作为生产默认；容器环境若无法满足 Chromium sandbox，capability 必须 fail closed；
- 默认拒绝 geolocation、notifications、camera、microphone、clipboard-read 等站点权限；
- 下载进入 Browser Session 专用临时目录，必须经显式用户动作才能转入 workDir；
- upload 只能引用当前 owner 已授权的 Agent-local 文件 handle，不能接收浏览器提供的任意绝对路径。

### 6.2 主 endpoint 与首选捕获：extension offscreen + `tabCapture`

Browser media peer 不放在 Node 或独立 sidecar。它固定运行在受控 Chromium 扩展的 offscreen document；同一 JS context 创建 `RTCPeerConnection`、DataChannels，并消费 `tabCapture` 的 `MediaStreamTrack`。因此没有跨进程传递 DOM `MediaStreamTrack` 这条虚假边界。Agent Node 与扩展之间只传信令、动作、状态以及 fallback 的有界压缩帧，不传首选路径的 track object。

受控扩展负责：

1. Browser Runtime 通过 authenticated local runtime port 指定 Browser Session 与 target tab；
2. 扩展校验 port secret、Browser Session、tab allowlist 和 generation；
3. 通过 `chrome.tabCapture.getMediaStreamId({ targetTabId })` 获得一次性 stream ID；
4. 在 extension offscreen document 中调用 `getUserMedia()` 消费 stream ID；
5. 在同一 offscreen document 创建 peer，将 video track 加入本地 `RTCPeerConnection`；
6. tab 导航继续使用同一 capture，tab 关闭或 capture error 时上报 terminal/rebind 状态。

选择原因：

- `tabCapture` 返回真实 `MediaStream`，不是 JSON/base64 frame；
- WebRTC sender 能执行帧丢弃、码率控制、关键帧和拥塞反馈；
- extension offscreen document 明确支持 `WEB_RTC` reason；
- 页面跨 origin 不影响 tab-level capture。

Chrome 对一个 installed extension/profile 同时只允许一个 offscreen document，因此它是该 Chromium process 的 peer host，不是每 Session 任意创建的 document。Runtime 在该 document 内按 `browserSessionId + peerId` 复用多 peer，仍受全局 `maxSessions/maxPeers` 硬限制；若 platform/version 无法可靠复用，则该 process 的 Browser Session 并发上限降为 1。

实现前必须做 Linux、macOS、Windows 与 headless/headful capability matrix。Chrome 文档要求 capture 由 extension invocation/active-tab 权限触发；如果受控启动环境不能可靠满足这一约束，该平台不能宣称支持首选路径。

### 6.3 Fallback：CDP screencast → canvas track

fallback pipeline：

```text
Agent CDP Page.startScreencast (JPEG, bounded dimensions/quality)
  → immediately ack each screencastFrame
  → keep latest frame only
  → authenticated local IPC to extension offscreen endpoint
  → decode/draw latest frame to canvas
  → canvas.captureStream(0) + requestFrame()
  → same offscreen RTCPeerConnection.addTrack()
```

硬规则：

- `Page.startScreencast` 是 experimental，只能在 startup probe 成功后 advertise；
- Agent 与 offscreen endpoint 两端的 frame slot 长度都固定为 1，新帧覆盖未处理旧帧；本机 IPC 有 session/generation、字节和速率上限；
- 收到 frame 后立即 `screencastFrameAck`，不能因本机 IPC 或 WebRTC backpressure 卡住 Chromium；
- JPEG/base64 不进入 DataChannel、Server WebSocket 或 transcript；只允许在 Agent↔受控扩展的本机 fallback IPC 中短暂存在；
- decode/draw/encode 的 CPU、p95 frame age 和丢帧率必须达标，否则该平台 capability 关闭；
- fallback 不承诺 tab audio。

`canvas.captureStream()` 不能直接捕获任意远端网页。只有 Browser Runtime 已经取得并绘制 frame 后才能生成 track，因此它是 fallback 的转换层，不是首选 capture API。

### 6.4 Codec 和自适应

第一阶段：

- 必须支持 VP8；H.264 仅在 sender/receiver capability 交集和运行时编码 probe 成功时优先；
- 不要求 AV1；
- 目标 1280×720、24 fps、1.5–3 Mbps；静态页面可降到 2 fps；
- 交互 burst 时恢复目标 fps；
- 用 `RTCRtpSender.setParameters()` 设置 `maxBitrate`、`maxFramerate` 和降级偏好；
- 根据 outbound-rtp/inbound-rtp stats 的 RTT、packet loss、framesDropped、QP 和 available bitrate 调整；
- 不通过修改 SDP 字符串写死浏览器私有参数。

无音频时 UI 必须明确，不创建空 audio transceiver。

### 6.5 AI 操作路径

Yeaft Browser tool 与 Web viewer 操作同一 Browser Runtime API：

```js
browserRuntime.performAction({
  browserSessionId,
  producer: {
    kind: 'vp', sessionId, vpId, turnId,
    producerId, producerGeneration, controlSeq
  },
  pageRevision,
  actionId,
  action: { type: 'click', locator: { role: 'button', name: 'Save' } }
})
```

AI 优先用 DOM/role/locator 操作，不用视频像素坐标。用户输入用 viewport 坐标。两者可同时提交，但都进入 Agent 的唯一有界 action dispatcher，经公平 dequeue 后逐个执行；执行结果带 action revision。这里的串行化是事实一致性边界，不是用户与 AI 的排他控制权。

### 6.6 AI `observe` 与结果投影

Semantic locator 需要一个明确、受限的观察 API，不能把“可用 DOM”理解为把整页 DOM、可见文本或 secrets 塞进模型：

```js
browserRuntime.observe({
  browserSessionId,
  producer: { kind: 'vp', sessionId, vpId, turnId, producerId, producerGeneration },
  pageRevision,
  query: { roles: ['button', 'textbox'], names?: ['Save'] },
  limits: { maxNodes: 200, maxDepth: 8, maxTextChars: 12000, timeoutMs: 3000 }
})
```

观察投影只包含有界的 role/name/state/value metadata、稳定的 opaque locator handle、viewport bounds、safe URL origin/title 和 `truncated` 标记。默认排除：`input[type=password]` 值、hidden/aria-hidden subtree、cookie/storage、script/style、network body/header、token-like text、表单值和跨 origin iframe 内容。普通文本采用总字符预算和单节点预算；命中 secret/token redactor 的字段替换为 `[redacted]`。若任务确实需要读取表单值或页面正文，必须调用目的明确、字段受限的单独动作，并让 tool result 标记敏感级别。

Agent 保存完整页面事实仅限执行期间内存；进入模型上下文的是上述投影，进入 transcript/debug/memory 的副本还要经过现有 tool-output budget、folding、visibility 和敏感字段 redaction。默认持久审计只有 action type、opaque locator handle、结果码、耗时、revision 和 evidence digest，不保存 selector 原文、DOM、截图、页面正文或 form value。action result 形状固定为：

```js
{
  actionId,
  status: 'completed' | 'rejected' | 'failed',
  pageRevision,
  actionRevision,
  safeSummary,
  evidence: [{ kind: 'page_state', digest, redacted: true }],
  errorCode?
}
```

`safeSummary` 有独立字符上限且不回显输入 text/clipboard/password；raw automation/CDP error 只留 Agent-local protected diagnostics。

## 7. 并发、producer 授权与动作时序

### 7.1 多 producer、单执行边界

授权用户和一个或多个已获准的 VP turn 可以同时是 producer：

```text
Web peer producer ─┐
VP turn producer ──┼─→ Agent bounded action dispatcher ─→ Chromium page
VP turn producer ──┘
```

Agent 为每个 producer 签发 `producerId + producerGeneration`，并绑定不可变 actor scope：

- Web producer：`ownerUserId + clientId + webConnectionId + webConnectionGeneration + peerId + connectionGeneration`；
- VP producer：`ownerUserId + agentId + sessionId + vpId + turnId`；
- viewer attachment 可以收视频，但没有 Web producer authorization，因此不能发输入；
- Web reconnect/peer replacement、VP turn 结束/cancel、owner/access 变化会撤销对应 producer；同一个 producer record 若续期/重建则 generation 必须递增，旧 `(producerId, generation)` 永久失效；
- 撤销一个 producer 不阻塞其他 producer；不存在“Take Control”、control lease 或用户↔AI 控制转移；
- 导航、file chooser、permission prompt 和 JavaScript dialog 都经过同一 dispatcher。

同时提交不等于同时执行。Dispatcher 用公平 dequeue 选择下一个 producer，并在接受该动作时分配全 Session 单调 `actionRevision`；该 revision 定义实际执行顺序。每次动作开始前重新校验 producer、page revision 和 Session state。用户或 AI 如果依赖特定页面事实，必须携带观察得到的 `pageRevision`；过期就重新 observe，而不是抢占另一方。

### 7.2 动作幂等与时序

- 每个 producer 有独立的 reliable `controlSeq`；Agent 只接受 `controlSeq = lastAcceptedControlSeq + 1`。AI action 与 Web reliable control 都使用这一 gap-free sequence space；不同 producer 的 `controlSeq` 不互相阻塞；
- 每个 Web producer 另有独立的 lossy `pointerSeq` high-water。Agent 接受 `pointerSeq > lastAcceptedPointerSeq`，允许 gap；`pointerSeq <= lastAcceptedPointerSeq` 视为 stale/duplicate 丢弃；
- reliable `control` channel 的 Web producer 还必须匹配 peer 和 connection generation；
- `pointer` channel 的 move/wheel 是瞬时状态，允许丢失和乱序，只更新 `lastAcceptedPointerSeq`；它绝不能推进、阻塞或导致 `controlSeq` 被拒绝；
- `pointerDown` / `pointerUp` / click 不走不可靠 channel，而走 reliable `control` 并携带 `controlSeq`；
- `actionId` 在 `(browserSessionId, producerId, producerGeneration)` 内唯一；重复的相同 payload 返回 ledger 结果，不同 payload 返回 conflict；
- ack 只表示 Agent 已接受或执行，不表示业务页面已达到预期；
- Web 或 AI 在超时后可查询 `actionId`，但不能自动重新发送非幂等动作；
- page navigation 递增 `pageRevision`，旧 revision 的坐标或 semantic action 直接拒绝并要求重新映射/observe；
- peer/generation/producer 结束时，Agent 在 Chromium 输入层合成释放该 producer 尚未释放的 key/button，清空 pointer/button state，并拒绝队列中尚未开始的动作；已经开始且副作用未知的动作只报告 `outcome_unknown`，不自动重跑。

## 8. 控制面与信令协议

本文给出新 wire contract。实现时新类型只用现行术语，不引入 `group` / `unify` alias。

### 8.1 Capability

Agent 注册新增：

```js
capabilities: [
  'browser_runtime',
  'browser_webrtc',
  'browser_capture_tab',       // 首选 path 可用时
  'browser_capture_cdp'        // fallback probe 通过时
]
```

Server/Web 只有在 `browser_runtime + browser_webrtc + 至少一个 capture capability` 同时存在时显示入口。版本号不是 capability substitute。

### 8.2 Create

Web → Server → Agent：

```js
{
  type: 'browser_session_create',
  agentId,
  requestId,
  sourceRef,
  options: {
    initialUrl: 'about:blank',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    locale: 'zh-CN',
    capturePreference: 'auto' // auto | tab | cdp
  }
  // ownerUserId/clientId/webConnection* are not accepted from Web payload
}
```

Agent → exact requesting Web client：

```js
{
  type: 'browser_session_created',
  agentId,
  requestId,
  browserSessionId,
  revision: 1,
  state: 'ready',
  captureMode: 'tab',
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  pageRevision: 1,
  expiresAt
}
```

Create 必须支持 `requestId` 幂等：同一 Server-stamped Web connection generation 内相同 request 返回相同结果；不同 payload 返回 conflict。Server 丢弃客户端自报的 owner/client/connection 字段，向 Agent 转发时增加：

```js
serverIdentity: {
  ownerUserId,
  clientId,
  webConnectionId,
  webConnectionGeneration
}
```

Agent 把该 stamp 固化进 Browser Session owner record；缺失、变化或与 authenticated Agent route 不一致就拒绝。Server 还必须为每次 Web socket 建立随机 `webConnectionId` 和单调/随机不可复用的 `webConnectionGeneration`，不能拿前端 store 自己的 reconnect counter 代替；socket 关闭后该身份永久失效。

### 8.3 Attach bootstrap 与 offer/answer

Bootstrap 必须按以下顺序完成，不能让 offer/trickle 先于 route 或 TURN config：

1. Web 发 `browser_peer_attach`；
2. Server 校验 user→Agent 和 Browser Session owner，在单个同步临界区保留 provisional `peerId + connectionGeneration` route，绑定 exact `clientId/webConnectionId`；其他 signal 只能看到 `preparing` 并被拒绝；
3. Server 为 Web endpoint 和 Agent extension endpoint 各签发 scope 不同的 TURN credential；mint 成功后在同一临界区提交 route，失败则删除 provisional route；
4. Server 将带 `serverIdentity`、Agent-side `iceServers` 和 peer route expiry 的 `browser_peer_prepare` 转给 Agent；
5. Agent 持久到内存 peer record，并把 Agent-side ICE config 交给 offscreen endpoint；只有 `setConfiguration()`/constructor 成功后才能 `createOffer()`；
6. Agent 回复 `browser_peer_prepared`；Server 确认 route 仍有效后，把 Web-side ICE config 与后续 offer 投影给 exact Web client；
7. 任一步失败都按 `requestId + generation` 幂等清理 peer、producer、route 和临时 credential scope。

Web → Server：

```js
{
  type: 'browser_peer_attach',
  agentId,
  browserSessionId,
  requestId,
  connectionGeneration,
  role: 'interactive' | 'viewer',
  clientCapabilities: {
    codecs: ['video/VP8', 'video/H264'],
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30
  }
}
```

Server → Agent（Server-only fields）：

```js
{
  type: 'browser_peer_prepare',
  agentId,
  browserSessionId,
  peerId,
  requestId,
  connectionGeneration,
  serverIdentity: { ownerUserId, clientId, webConnectionId, webConnectionGeneration },
  routeExpiresAt,
  agentIceServers: [{ urls, username, credential, expiresAt, endpointRole: 'agent' }]
}
```

Agent 创建 peer 和 offer 后，经 Server 返回 exact Web client（`role` 取自 Server route，不接受 Agent/Web 自报变化）：

```js
{
  type: 'browser_peer_offer',
  agentId,
  browserSessionId,
  peerId,
  requestId,
  connectionGeneration,
  description: { type: 'offer', sdp },
  webIceServers: [{ urls, username, credential, expiresAt, endpointRole: 'web' }],
  producerAuthorization: role === 'interactive'
    ? { producerId, producerGeneration, expiresAt }
    : null
}
```

Web → Agent：

```js
{
  type: 'browser_peer_answer',
  agentId,
  browserSessionId,
  peerId,
  connectionGeneration,
  description: { type: 'answer', sdp }
}
```

双方 trickle ICE：

```js
{
  type: 'browser_peer_ice_candidate',
  agentId,
  browserSessionId,
  peerId,
  connectionGeneration,
  candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment }
}
```

candidate 为 `null` 表示 gathering complete。任何 generation、peer route、endpoint role 或 Server-stamped client identity 不匹配的 answer/candidate 必须丢弃。Agent 在收到 `browser_peer_prepare` 且 offscreen peer record ready 前不得发 offer/candidate；Server 在 route 原子安装完成前不得转发。SDP 和 candidate 设单消息大小上限、字段长度上限、总 candidate 数和消息速率上限。

### 8.4 Lifecycle 和 snapshot

```js
// Web → Agent
{ type: 'browser_session_get', agentId, browserSessionId, requestId }
{ type: 'browser_session_close', agentId, browserSessionId, requestId, expectedRevision }
{ type: 'browser_session_list', agentId, requestId }
{ type: 'browser_peer_detach', agentId, browserSessionId, requestId, peerId, connectionGeneration }
{ type: 'browser_peer_restart', agentId, browserSessionId, peerId, requestId, nextGeneration }

// Agent → Web
{
  type: 'browser_session_snapshot',
  agentId,
  browserSessionId,
  revision,
  state: 'starting' | 'ready' | 'closing' | 'closed' | 'failed',
  activeUrl,
  title,
  pageRevision,
  captureMode,
  viewerCount,
  interactivePeerCount,
  authorizedProducerCount,
  terminalReason,
  safeError
}
```

snapshot 是恢复依据，实时 event 只是增量。WebSocket reconnect 后不得假设旧 peer 可继续用；先 list/get snapshot，再 attach 新 `peerId`。

### 8.5 Server routing table

Server 只保留易失 metadata：

```js
browserRoutes.set(`${agentId}:${browserSessionId}`, {
  ownerUserId,
  agentId,
  revision,
  state,
  updatedAt
})

browserPeers.set(peerId, {
  ownerUserId,
  agentId,
  browserSessionId,
  clientId,
  webConnectionId,
  webConnectionGeneration,
  connectionGeneration,
  role,
  routeState: 'preparing' | 'offered' | 'connected' | 'closed',
  expiresAt
})
```

规则：

- create 前验证 user → Agent access；
- attach 时先在同步临界区保留不可转发 signal 的 `preparing` route，credential mint 成功后才提交/转发 prepare；同 request/generation 重试返回同一 record，payload 不同则 conflict；
- 后续每条消息同时验证 route owner、Agent id、Browser Session id、exact client/Web connection 和 generation；
- 发给 Agent 的 owner/client/Web connection identity 全由 Server stamp；Agent event 中的 `agentId` 由已认证 Agent socket stamp，忽略 payload 自称值；
- offer/ICE 只发给 `browserPeers[peerId].clientId + webConnectionId`，不能广播给同 owner 所有 tabs；
- Web 或 Agent endpoint 的 TURN credential 只发给对应 endpoint，不出现在 snapshot/broadcast；
- attach/restart 失败、detach、Web connection close、Agent connection close、route TTL 到期或 Session terminal 都删除 peer route并触发 Agent cleanup；
- snapshot/status 可发给同 owner、同 Agent 的 tabs，但不包含 SDP、candidate、producer secret 或 TURN credential；
- Server restart 后 Browser Session route 可由 Agent `browser_session_list` 重建；peer/producer 和旧 credential scope 一律失效并重新 attach；
- 不把 browser signal 放入通用 disconnected message buffer。

## 9. DataChannel 协议

Agent 驱动的 extension offscreen endpoint 作为 offerer 创建三个 in-band channels。第一条 DataChannel 会触发协商，因此必须在 createOffer 前创建并在 Agent 已取得 TURN config 之后协商。

| label | 配置 | 用途 |
| --- | --- | --- |
| `browser.control.v1` | `{ ordered: true }` | keyboard、button、navigation、clipboard write、action ack |
| `browser.pointer.v1` | `{ ordered: false, maxRetransmits: 0 }` | pointer move、wheel、hover viewport position |
| `browser.state.v1` | `{ ordered: true }` | Agent → Web page/producer/dialog/status 增量 |

DataChannel payload 使用有版本的 CBOR 或 MessagePack binary envelope；spike 阶段可用 JSON，但生产必须测量解析和 allocation。公共 fencing 字段保持一致，但 sequence 字段由 channel 决定，不能共享：

```js
// browser.control.v1 — reliable / ordered
{
  v: 1,
  browserSessionId,
  peerId,
  connectionGeneration,
  producerId,
  producerGeneration,
  pageRevision,
  controlSeq,
  type,
  payload
}

// browser.pointer.v1 — unreliable / unordered
{
  v: 1,
  browserSessionId,
  peerId,
  connectionGeneration,
  producerId,
  producerGeneration,
  pageRevision,
  pointerSeq,
  type,
  payload
}
```

`controlSeq` 和 `pointerSeq` 在 `(browserSessionId, producerId, producerGeneration)` 内分别从 1 开始。Agent 保存两个独立的 high-water；跨 DataChannel 的到达顺序没有协议含义。

### 9.1 Reliable control messages

```js
{ type: 'pointer_button', payload: { action: 'down' | 'up', button: 0, x: 0.42, y: 0.31, modifiers: 0, actionId } }
{ type: 'key', payload: { action: 'down' | 'up', code: 'KeyA', key: 'a', repeat: false, modifiers: 0, actionId } }
{ type: 'text_insert', payload: { text: 'hello', actionId } }
{ type: 'navigate', payload: { action: 'url' | 'back' | 'forward' | 'reload' | 'stop', url?, actionId } }
{ type: 'viewport', payload: { width, height, devicePixelRatio } }
{ type: 'dialog_response', payload: { dialogId, accept, promptText?, actionId } }
{ type: 'clipboard_write', payload: { text, actionId } }
{ type: 'action_query', payload: { actionId } }
```

坐标是 capture viewport 内的 `[0, 1]` 归一化值。Agent 用当前 page viewport 重新映射并 clamp。letterbox 区域不生成事件。

键盘规则：

- 默认发送 `KeyboardEvent.code + key + modifiers`，Agent 映射到 CDP/automation input；
- IME/composition 结束后用 `text_insert`，不试图逐键重建中文输入法；
- 浏览器保留快捷键在 Web 端做 UX allowlist/denylist，避免 `Ctrl+W` 关闭 Yeaft 页；Agent 仍独立校验允许的 key/code/modifier 组合，不能把 Web 过滤当安全边界；
- password field 仍可远程输入，但 text 不写日志、不进入 state event、不做 analytics。

### 9.2 Unreliable pointer messages

```js
{ type: 'pointer_move', payload: { x, y, buttons, modifiers } }
{ type: 'wheel', payload: { deltaX, deltaY, deltaMode, x, y, modifiers } }
```

Web 端按 animation frame 合并 move，Agent 端只保留最大的 `pointerSeq` high-water。`bufferedAmount` 超过 64 KiB 时丢弃 move/wheel，降到 16 KiB 后恢复；丢弃不会补洞，也不影响下一条 control。若 `pointerSeq=12` 先于 `pointerSeq=11` 到达，则接受 12 并丢弃 11；无论 pointer 何时到达，后续合法 `controlSeq` 都按 reliable control 自己的 high-water 判定。绝不让 pointer backlog 增加“看起来能动但落后几秒”的延迟。

### 9.3 State 与 ack

```js
{ type: 'action_ack', payload: { actionId, status: 'accepted' | 'completed' | 'rejected', code?, pageRevision, actionRevision? } }
{ type: 'page_state', payload: { url, title, canGoBack, canGoForward, loading, pageRevision } }
{ type: 'producer_state', payload: { producerId, producerGeneration, authorized, expiresAt, reason? } }
{ type: 'dialog_opened', payload: { dialogId, kind, message, hasDefaultPrompt } }
{ type: 'capture_state', payload: { width, height, fps, frozen, captureMode } }
```

State channel 不是 durable truth。断线恢复必须走 WebSocket snapshot。

## 10. 状态机与故障恢复

### 10.1 Browser Session

```text
none
  → starting
  → ready
  → closing
  → closed

starting | ready
  → failed
  → closing
  → closed
```

`closed`/`failed` terminal snapshot 至少保留一个短 TTL 供请求方读取 safe reason；Chromium context 和媒体资源必须立即回收。

### 10.2 Peer

```text
new → offering → connecting → connected
                     │             │
                     └→ failed ← disconnected
                                      │
                                      └→ restarting → connected
failed | connected → closed
```

恢复规则：

1. `disconnected` 先观察 3 秒，并结合 `getStats()` 判断是否还有 bytes/frame 前进；
2. 确认 `failed` 或持续无进展后，最多自动 ICE restart 一次；
3. restart 使用同一 Browser Session、新 `connectionGeneration` 和新的短期 TURN credential；
4. 10 秒内未恢复，关闭 peer，Web 通过控制面重新 attach；
5. Browser Session 不因单个 peer 失败立即销毁；无 viewer idle TTL 到期才回收。

### 10.3 WebSocket / Agent 控制连接断开

- WebSocket 是信令和授权生命线，不是媒体 transport；短暂断开时已建立的 WebRTC 最多继续**只读展示**；
- Server 检测 Web connection close/heartbeat timeout 后立即把 exact `clientId + webConnectionId` 的 peer revoke 转给 Agent；Agent 同步撤销 Web producer、拒绝新输入、清掉未开始动作，并合成释放该 producer 的所有 pressed keys/buttons；
- Agent 不依赖 revoke frame 必达：每个 Web producer 有短 TTL，需要现有 authenticated WebSocket 上的 Server-stamped heartbeat 连续续期；超过 TTL（目标 ≤ 5 秒）在 Agent 本地 fail closed；
- Agent↔Server 控制连接 close/heartbeat timeout 时，Agent 不等待 Server 指令，立即撤销**全部 Web producers**、释放输入状态并关闭所有 WebRTC peers。AI producer 是否继续由其本地 Yeaft turn lifecycle 决定；Server 失联本身不授予或延长任何 AI 权限；
- WebSocket 恢复后 Web 请求 snapshot，并创建新 `peerId + connectionGeneration + producerAuthorization`；旧 peer 即使媒体仍通也永远不能恢复写权限；
- 本协议不定义 `browser_peer_reauthorize`，也不接受可重放 resume ticket。未来若要避免重建 peer，必须另行定义单次 Server-signed nonce、audience、expiry、used-at ledger 和 replay tests；
- auth failure、账号 disabled、Agent ownership 变化或 Session close 立即关闭 peer；
- WebSocket/Server restart 期间不缓存或重放输入。

### 10.4 Agent 或 Chromium 失败

- Agent WSS 断开：Agent 本地先 fail closed 撤销 Web producer并关闭 peers；Server 将 Browser Sessions 标记 `agent_offline`，Web UI 停止输入并显示重连；
- Agent 进程重启：内存 Browser Sessions 视为 `closed: agent_restarted`，不伪装恢复；
- Chromium crash：Agent 发 terminal snapshot，清理 context/peer；用户可以显式创建新 Session；
- active tab 关闭：若 context 有唯一替代 page 则 rebind 并递增 `pageRevision`，否则关闭 Session；
- capture track ended：先尝试一次 capture rebind，失败则 terminal `capture_failed`；
- TURN 不可用但 direct 成功时允许连接并记录 degraded redundancy；direct 与 TURN 都失败则明确报 `ice_unreachable`。

## 11. 安全与隐私

### 11.1 授权

每个控制面入口都必须：

1. 使用 Server 已认证的 `client.userId`；
2. 通过 `resolveAgentAccessError(agentId, userId, role)`；
3. Server 向 Agent stamp `ownerUserId + clientId + webConnectionId + webConnectionGeneration`，Agent 在权威 Browser Session record 中确认 owner；
4. 对 peer-scoped signal 再校验 `peerId + exact client/Web connection + connectionGeneration + endpointRole`；
5. 对输入再校验 `producerId + producerGeneration + pageRevision`，并按入口独立校验 `controlSeq` 或 `pointerSeq`；pointer high-water 永不读取或修改 control high-water。AI producer 还校验 `sessionId + vpId + turnId` 生命周期。

管理员访问 ownerless global Agent 的既有规则不自动等于可以观看任意用户 Browser Session。Browser Session 必须始终有明确 `ownerUserId`；跨用户 support/viewer 是未来单独设计。

### 11.2 WebRTC 与 IP 隐私

DTLS-SRTP/SCTP 保护传输内容，但 direct ICE candidate 可能暴露双方网络地址。部署提供两种 policy：

- `all`：优先 direct，失败走 TURN；
- `relay`：只用 TURN，适合严格隐私或企业策略。

policy 由 Server deployment 和用户/Agent policy 的更严格者决定，客户端不能自行降级 `relay → all`。

### 11.3 SSRF 和站点访问

Browser Runtime 能访问的网络范围至少与 Agent 当前网络权限一样敏感。若运行在托管 Sandbox：

- 必须继承 Sandbox 对 cloud metadata、host management、Docker API、私网和其他 Sandbox 的阻断；
- DNS rebinding 后的实际目标 IP 仍由数据面 policy 拒绝；
- Browser UI 不得承诺访问被 Agent/Sandbox policy 禁止的地址。

本地 Agent 默认可访问本机网络，UI 首次启用 Browser Runtime 时必须明确风险。后续若需要 URL allow/deny policy，应在 Agent 执行边界实施，不能只在地址栏校验字符串。

### 11.4 数据最小化

允许记录：

- hashed/opaque Browser Session 与 peer id；
- state transition、capture mode、codec、candidate type（host/srflx/relay）、RTT、bitrate、frame/failure counters；
- action type、结果码和耗时，不记录用户键值/文本。

禁止默认记录：

- SDP、ICE candidate address、TURN credential；
- video frame、截图、页面正文；
- keyboard text、clipboard、form value、cookie、Authorization header；
-完整 URL query/fragment。Telemetry 中 URL 最多记录 scheme + eTLD+1，且遵守 owner 和 retention policy。

Debug bundle 如需包含敏感字段，必须显式用户确认、加密、限时，并在 UI 展示包含内容。

### 11.5 Web 安全

- 远端画面只渲染进 `<video>`，不把页面 HTML 注入 Yeaft origin；
- Browser Runtime state 中的 title/URL 当作不可信文本转义；
- Browser Session 页面不能取得 Yeaft JWT、localStorage 或 DOM；
- WebRTC feature 要求 HTTPS/WSS secure context，local development 只允许 loopback exception；
- Web CSP 的 `connect-src` 只显式允许 Yeaft signaling 的 HTTPS/WSS origin；它不是 STUN/TURN ICE endpoint allowlist。可用 ICE server、transport 与 `iceTransportPolicy` 只能来自 Server 下发的受信配置，Web 不接受任意 TURN/STUN URL；
- file upload/download 必须复用 owner-scoped attachment/file transfer 边界并限制大小、路径和 MIME。

## 12. 资源治理与 backpressure

### 12.1 Agent budgets

配置必须有默认值和硬上限：

```js
browserRuntime: {
  enabled: false,
  maxSessions: 2,
  maxPeersPerSession: 2,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 30,
  maxBitrate: 4_000_000,
  maxQueuedActionsPerSession: 128,
  maxQueuedActionsPerProducer: 32,
  maxActionQueueBytes: 1024 * 1024,
  maxActionRuntimeMs: 30_000,
  producerCreditBurst: 16,
  producerCreditRefillPerSecond: 8,
  noViewerIdleMs: 120_000,
  interactiveIdleMs: 2_100_000,
  maxDownloadsBytes: 512 * 1024 * 1024
}
```

资源检查至少包含 Chromium child process 数、RSS、CPU、临时目录和网络 bitrate。超过 hard limit 时拒绝新建，不随机杀已有 Session；单 Session 超预算时先降分辨率/fps，再明确终止 offender。

### 12.2 Media backpressure

- 原生 track 依赖 WebRTC sender 拥塞控制；应用层只调整 sender parameters；
- CDP fallback 保留最新 frame，不排队；
- peer 无 receiver/hidden 超过阈值时暂停或降到 1–2 fps；
- 多 viewer 第一阶段为每 viewer 一个 peer/encoder；超过 2 个拒绝，避免假装已有 SFU；
- Server WebSocket payload budget 不应看到任何 video frame。

### 12.3 DataChannel backpressure

- reliable channel `bufferedAmount` 高水位 1 MiB，达到后暂停生成非必要 state；
- pointer channel 高水位 64 KiB，直接丢瞬时 event；
- control channel 超过 1 MiB 视为 unhealthy，关闭 peer，不无限缓存键盘/点击；
- 单条 control payload 默认 ≤ 16 KiB，clipboard/write 和 text insert 有独立上限；
- WebSocket signal 每 peer 限制 candidate 数量和每秒速率，防止滥用。

### 12.4 Agent action queue 与 stuck input

RTC `bufferedAmount` 只约束网络发送缓冲，不能保护 Agent/Chromium 执行队列。Dispatcher 另有硬边界：

- 每 Browser Session 最多 128 个/1 MiB queued actions；每 producer 最多 32 个；超限返回 `queue_full`，不继续读入；
- 每 producer 使用 token-bucket credit（burst 16、每秒补 8，pointer move 在入队前合并）；AI 与 Web producer 各自计费，dispatcher 采用 round-robin/weighted-fair dequeue，并为每类保留 minimum credit；单个持续有流量的 producer 不能永久饿死其他 producer；同一轮中按 Agent 接受顺序分配 `actionRevision`；
- dispatcher 每次只启动一个动作；动作默认 30 秒 deadline，dialog/navigation/file action 可用具名上限，不能接受任意客户端 timeout；
- timeout 后先取消可取消的 automation command；无法确认副作用停止时标记 `outcome_unknown`，阻塞依赖该结果的 AI sequence，但不盲重跑；
- peer/generation/producer cancel、DataChannel close、WebSocket loss、Agent control loss、page navigation、Session close 都会清理该 producer 未开始动作，并合成 keyup/pointerup 释放 held state；
- Agent 跟踪每 producer 的 pressed key/button set，并有 5 秒 stuck-input watchdog；没有续期/对应 release 时自动释放并记录 redacted reason；
- 队列长度、等待时间、credit rejection、timeout、cleanup 和 held-input gauge 必须进入 metrics/alerts。

## 13. 可观测性与运维

### 13.1 Metrics

按 Agent 与 deployment 聚合，避免高基数 user label：

```text
browser_session_create_total{result,capture_mode}
browser_session_active{capture_mode}
browser_peer_connect_seconds{candidate_type}
browser_peer_connect_total{result,candidate_type}
browser_ice_restart_total{result}
browser_video_bitrate_bps
browser_video_fps
browser_video_frame_age_ms
browser_video_frames_dropped_total{stage}
browser_input_ack_seconds{action_type}
browser_action_queue_depth
browser_action_queue_wait_seconds
browser_action_reject_total{reason}
browser_action_timeout_total{action_type}
browser_held_inputs{kind}
browser_input_cleanup_total{reason}
browser_turn_allocations_active
browser_runtime_cpu_seconds_total
browser_runtime_rss_bytes
```

Web 和 Agent 每 5 秒采样 `getStats()`，本地 UI 可显示更细数据；上传 telemetry 采用 30–60 秒聚合，Session 结束立即 flush terminal aggregate。

### 13.2 Structured events

```js
{
  event: 'browser_peer_state',
  agentId,
  browserSessionIdHash,
  peerIdHash,
  generation,
  from,
  to,
  candidateType,
  reasonCode,
  durationMs
}
```

日志不含 SDP/candidate/credential/text/完整 URL。所有 error 用 stable code + safe message；原始 native error 只留 Agent-local protected diagnostics。

### 13.3 Alerts

- 15 分钟 ICE failure > 2%；
- TURN allocation failure > 1%；
- connected peer 首帧 p95 > 5 s；
- frozen stream > 1% active peer-minutes；
- Agent Browser Runtime crash loop；
- TURN egress 或 allocation 数异常增长；
- Server 收到带 frame/image payload 的 browser signal（协议违规）。

### 13.4 Runbook 要求

发布前必须有：

- TURN health、credential signing/rotation、端口和 firewall 检查；
- Chromium/extension digest 与 sandbox capability 检查；
- Agent CPU/RSS/child-process 泄漏排查；
- ICE candidate/codec/first-frame 诊断步骤；
- 一键 disable feature flag，不影响现有 Chat/Session/Workbench；
- 清理 orphan Browser Runtime process 和临时目录的受控命令。

## 14. 测试与验收

### 14.1 Unit

- identity key 必须包含 `agentId + browserSessionId`；
- Server 拒绝跨 user、跨 Agent、未知 Browser Session 和 peer/client mismatch；
- Server-stamped owner/client/Web connection identity，以及 peer/producer/page generation fencing；
- per-producer `controlSeq` gap-free enforcement、`pointerSeq` gap-tolerant high-water、pointer coalescing 和 DataChannel bufferedAmount thresholds；
- dropped pointer 后 reliable control 仍接受；pointer/control cross-channel reorder 不互相推进或拒绝；stale/duplicate pointer 被丢弃；
- normalized coordinate mapping、letterbox、DPR 和 viewport resize；
- action queue count/bytes/credit/deadline 与公平性；timeout/unknown outcome 不自动重放；
- peer/generation/producer/control loss 时释放 pressed key/button 并清空未开始动作；
- TURN endpoint-role credential TTL/scope/signature、attach idempotency 和 cleanup；
- bounded/redacted observe、action result、transcript/debug/memory projection；
- safe logging redaction；
- Chromium flags、download path 和 permission defaults；
- idle/resource cleanup exactly once。

### 14.2 Integration

使用真实 Agent Browser Runtime 和虚拟/loopback peer：

1. create → route installed → endpoint-scoped TURN config delivered → offer → answer → candidate → first video frame；并断言 prepare 前没有 offer/candidate；
2. pointer/keyboard → page DOM change → video reflects change；丢失 `pointerSeq=n` 后 `controlSeq=m` 仍执行；pointer/control 跨 channel 乱序不互相 gating；旧 `pointerSeq` 在新 pointer 后到达时被丢弃；
3. AI locator 与用户输入并发提交，Agent 按 action revision 串行且两方都不会被排他撤权；
4. WebSocket disconnect 后视频可短暂只读，Agent 本地 TTL 到期撤销 Web producer、清队列并释放 held input；
5. WebSocket reconnect → snapshot → 新 peer/generation/producer attach；旧 peer 不可恢复写权限；
6. forced ICE failure → one restart → 两端新 scope TURN credential → relay；
7. stale answer/candidate/action、伪造 owner/client/producer 和 replayed attach 被 fencing；
8. queue/credit/timeout overload、peer close 与 Agent control loss 均有确定 cleanup；
9. bounded observe 排除 password/form/secrets，action result 进入 transcript/debug/memory 前保持 redacted/budgeted；
10. Chromium crash/capture track end 清理全部 resource；
11. 两个同名 Browser Session ID（不同 Agent）不串路由；
12. Server restart 后旧 peer/producer 失效、Browser Session snapshot 可重建。

### 14.3 Network matrix

CI 的协议测试不能替代 staging network test。至少覆盖：

| Web | Agent | 预期 |
| --- | --- | --- |
| 公网 IPv4 | 公网 IPv4 | direct 或 srflx |
| 家庭 NAT | 云 Agent | srflx/direct，失败 TURN |
| symmetric NAT | symmetric NAT | TURN UDP |
| UDP blocked | 任意 | TURN TLS/TCP 443 |
| IPv6 only / dual stack | dual stack | IPv6 或 TURN |
| mobile network handoff | 云 Agent | ICE restart / reattach |
| corporate proxy | 云 Agent | `turns:443?transport=tcp` 或明确失败 |

### 14.4 Browser/platform matrix

Viewer：最新两个 stable 版本的 Chrome/Edge、Firefox、Safari；iOS Safari 至少做 viewer 与基础输入。Agent：Linux、macOS、Windows。每个平台分别验证 tab capture；未通过的平台只能 advertise 已通过的 fallback capability。

### 14.5 性能与 soak

- 10 分钟动态页面：fps/latency/CPU；
- 8 小时静态 page：内存、handle、timer、peer 泄漏；
- 100 次 attach/detach；
- 100 次 create/close Chromium context；
- 30 分钟 network impairment：1–10% loss、100–500 ms RTT、带宽阶梯；
- 两个 Session × 两个 peers 的 Agent resource ceiling；
- CDP fallback decode/draw/encode profile；
- TURN egress 和成本测量。

### 14.6 安全验收

- 未认证、disabled user、跨 owner、跨 Agent 访问全部 fail closed；客户端伪造 owner/client/Web connection stamp 无效；
- candidate flood、oversized SDP、DataChannel oversized payload、`controlSeq` gap/replay 和 `pointerSeq` regression/flood 被限流、丢弃或断开，且 pointer abuse 不污染 control high-water；
- Browser page 无法访问 Yeaft origin credentials；
- CDP endpoint 不可从网络访问；
- extension/capture package digest 被篡改时 capability 关闭；
- private/metadata network policy 在托管 Sandbox 中有效；
- observe/action-result fuzz fixture 证明 password、form value、token-like text、cross-origin content 不进入模型/transcript/debug/memory；
- 日志与 metrics 扫描不含 password、key text、SDP、candidate IP、TURN credential。

## 15. 渐进交付计划

### Phase 0：技术 spike（不对用户开放）

- 在三平台验证 `tabCapture` 的受控 activation、offscreen WebRTC 与导航连续性；
- 选择并审计 extension offscreen peer runtime、Chromium automation 和 TURN 方案；
- 测量原生 track 与 CDP→canvas fallback 的 CPU/延迟；
- 验证 H.264/VP8 capability；
- 输出 go/no-go matrix。未达标的平台不进入 capability。

### Phase 1：控制面与只读视频

- Agent Browser Runtime lifecycle 与 extension offscreen primary peer endpoint；
- Server-stamped identity、route-before-offer bootstrap、peer fencing 和 endpoint-scoped TURN credential；
- Web browser store、video panel、状态与 stats；
- 单 peer、单 page、VP8、无输入；
- feature flag 默认关闭。

### Phase 2：用户输入

- 三 DataChannels、输入映射、网络与 Agent action queue backpressure；
- Web producer authorization、action ack、navigation/dialog 和 stuck-input cleanup；
- keyboard/IME、viewport、移动端基础输入；
- network matrix 与安全测试通过后小比例 rollout。

### Phase 3：Yeaft 共用 Browser Runtime

- Browser tools 通过本地 API 操作同一 context；
- Web/VP 独立 producer authorization，并发提交、Agent 单点串行；
- bounded/redacted `observe`、action-result projection、AskUser 边界和 cancellation；
- 不把 raw DOM/page/video/input 写入 model context、transcript、debug 或 memory。

### Phase 4：可靠性与规模

- TURN 多区域与容量告警；
- 第二个 read-only peer；
- capture mode 自动选择；
- soak、资源治理和故障注入门禁；
- 根据 telemetry 决定是否扩大 rollout。

每个 Phase 都是独立 PR/feature flag；不做一次性跨 agent/server/web 的“大爆炸”合并。旧 Agent 无 capability 时 UI 隐藏入口，现有 wire 不变。

## 16. Rollout 与回滚

功能开关至少三层：

```text
server.browserRuntime.enabled
user entitlement / rollout percentage
Agent advertised capability
```

启用顺序：内部用户 → 1% → 10% → 50% → 100%，每级至少观察一个完整工作日和 network/cost dashboard。以下任一条件自动停止扩量：

- ICE failure、冻结率或 Agent crash 超过 SLO；
- TURN capacity/egress 超预算；
- ownership/security finding；
- Chromium process 泄漏或工作区数据边界不清。

回滚只需关闭 Server flag：

- 拒绝新 create/attach；
- 给活跃 Session 60 秒提示后由 Agent orderly close；
- 不升级、不 kill、不替换在线 Agent；
- Chat、Yeaft Session、Workbench 和 Work Center 不受影响。

## 17. 备选方案与拒绝理由

### 全部走 WebSocket

拒绝。JPEG/PNG frame 会占用 Server relay、JSON/base64 有额外开销，没有 RTP 拥塞控制和硬件解码路径，且与 Chat/Session 流量互相阻塞。WebSocket 保留为低频控制面。

### WebRTC 传 JPEG DataChannel

拒绝。这只是换 transport 壳，仍是应用层 frame queue。丢失 WebRTC 视频的 bitrate adaptation、frame dropping、keyframe/decoder pipeline 等价值。

### 只有 WebRTC、没有 WebSocket/HTTP

拒绝。WebRTC 需要外部 signaling 才能交换 SDP/ICE；断线时也需要授权、snapshot、TURN credential 和 ICE restart 协调。DataChannel 不能引导或授权它自身。

### Server 做 SFU/媒体中继

第一阶段拒绝。单用户、最多两个 viewer 不值得引入媒体 plane、codec/recording 安全面和运维复杂度。TURN 已解决 NAT relay；若未来需要多 viewer，再基于数据证明引入 SFU。

### VNC/远程桌面

拒绝。目标是一个 Agent-owned Chromium page，而非整个桌面。VNC 扩大权限面、输入语义差，AI 也无法复用 DOM/locator。

### 只用 CDP screencast

不作为首选。CDP 接口 experimental，输出压缩图片，需要二次 decode/draw/encode。但它在扩展 capture 不可用的平台可作为经过性能门禁的 fallback。

## 18. 未决策项与 spike exit criteria

以下内容不能在没有实测时拍脑袋：

1. **Extension peer implementation**：主 endpoint 已固定为受控 Chromium extension offscreen document；spike 只选择其 signaling/runtime library 与 packaging，不再把 Node addon/sidecar 当成可互换 peer。要求浏览器版本矩阵、CSP、DTLS/SRTP 安全维护和可取消资源生命周期。
2. **Chromium automation package**：复用测试用 Playwright 不等于适合 npm Agent production dependency。要评估 browser distribution、体积、升级和 licensing。
3. **tabCapture 激活约束**：自动化环境能否在用户可接受路径满足 extension invocation；不能则该平台走 fallback。
4. **TURN implementation/deployment**：coturn 或托管服务，需验证临时 credential、TLS 443、regional routing、egress cost 和 abuse controls。
5. **codec policy**：H.264 的硬件/软件 encoder 可用性、license 和画质；最低共同基线仍为 VP8。
6. **headless/headful**：不同平台对扩展和 tab capture 的支持；capability 以 probe 为准。
7. **持久 profile**：若产品需要登录态跨 Browser Session 保留，另开存储、安全和删除设计。

Phase 0 只有在以下条件全部满足后退出：

- 至少 Linux 的首选 capture path 达到延迟/CPU gate；
- UDP blocked 时 TURN TLS/443 可连接；
- Server-stamped identity、route-before-offer、endpoint credential、producer generation/page fencing，以及独立 `controlSeq`/`pointerSeq` sequence spaces 的 prototype fail closed；
- 选定 extension peer/runtime 与 automation 依赖有维护、安全、浏览器/Node 24 和发布方案；
- 资源 cleanup 在 100 次循环后无显著泄漏；
- Martin 对精确 spike/design head 完成独立 review。

## 19. 实现映射

建议新增边界，不要求文件名逐字一致：

```text
agent/browser-runtime/
  service.js              lifecycle and authoritative store
  chromium.js             executable/context/page ownership
  capture.js              tab capture + CDP fallback selection
  extension-peer.js       authenticated offscreen signaling/runtime bridge
  input.js                producer fencing + bounded action dispatcher
  observe.js              bounded/redacted semantic projection
  protocol.js             validation and limits

server/handlers/
  client-browser.js       web → server → Agent control/signaling
  agent-browser.js        Agent → exact Web client routing

web/stores/
  browser.js              Agent-scoped Browser Session + peer state

web/components/
  BrowserPanel.js         video, toolbar, connection/control state
```

新增公共边界用 JSDoc 记录输入、输出、owner 和 timeout。所有用户文案同步 `en.js`/`zh-CN.js`。Browser Runtime 不加入 `chat.js` 的 Session/VP ownership，也不复用 `claude_output` 或 `yeaft_output`。

## 20. 参考资料

- W3C WebRTC：signaling channel 由应用自行提供，通常经 WebSocket/HTTP；ICE 使用 STUN/TURN，DataChannel 传任意数据：<https://w3c.github.io/webrtc-pc/>
- Chrome `tabCapture`：tab 可生成 `MediaStream`，stream ID 有使用范围与短时效：<https://developer.chrome.com/docs/extensions/reference/api/tabCapture>
- Chrome offscreen document：支持 `WEB_RTC` reason，且 extension 同时只有一个 offscreen document 的生命周期约束：<https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- MDN `createDataChannel()`：`ordered`、`maxPacketLifeTime`、`maxRetransmits` 语义：<https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel>
- MDN `restartIce()`：ICE failed 后经原 signaling channel 重新协商：<https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce>
- Chrome DevTools Protocol `Page.startScreencast`：experimental JPEG/PNG frame 与 ack：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast>
- MDN `HTMLCanvasElement.captureStream()`：canvas 生成实时 `MediaStreamTrack`：<https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream>
