# WebRTC Browser Runtime 设计

- 状态：设计提案，作为实现拆分与验收契约
- 日期：2026-08-07
- Owner：Linus
- 范围：从 Web UI 低延迟观看和控制 Agent 本地 Chromium，并允许用户与 Yeaft 共用同一个浏览器上下文

## 1. 决策摘要

Browser Runtime 的实时数据面采用 WebRTC，但系统不做成“只有 WebRTC”：

- **WebRTC VideoTrack** 承载 Chromium 页面画面；
- **WebRTC DataChannel** 承载用户实时输入和轻量运行状态；
- **现有 authenticated WebSocket / HTTP** 继续承载鉴权、Agent 选择、Browser Session 生命周期、SDP/ICE 信令、TURN 临时凭证、重连和错误恢复；
- **Yeaft Engine 与 Chromium 同在 Agent**，AI 操作直接调用本地 Browser Runtime，不绕 WebRTC，也不经 Server 中转；
- **Server 只做 owner-checked 控制面 relay**，不解码媒体、不持久化 SDP/ICE、不成为 SFU；
- **TURN 是生产必需能力**，不能把“多数情况下能 P2P”当作可用性保证；
- **一个 Browser Session 同时最多一个写控制者**。用户或一个 VP 持有 control lease，其他参与者只读；所有实际动作由 Agent 串行化；
- 第一阶段只支持一个可见 page、无音频、无录屏持久化、无多人共同编辑。

推荐的媒体源是**受控 Chromium 扩展的 `tabCapture` + offscreen WebRTC peer**。它能把 tab 直接变成 `MediaStreamTrack`，让 WebRTC 使用原生媒体编码、拥塞控制和解码。CDP `Page.startScreencast` 只作为受能力探测约束的 fallback：该接口是 experimental，输出 JPEG/PNG 帧，必须先解码/绘制再从 canvas 生成 track，成本和延迟都更差。

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

当前仓库**没有 Browser Runtime、`browserSessionId` 或 WebRTC wire**，Agent production dependencies 也没有 Chromium automation 或 Node WebRTC endpoint。因此本文定义的是未来协议和组件边界，不描述已交付功能。

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
- 不在本文选择具体 Node WebRTC、TURN 或 Chromium automation package；这些必须经过 spike 与供应链 review。

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
| `controlLeaseEpoch` | 当前写控制权 fencing token；每次转移递增 |
| `pageRevision` | 顶层导航或 active page 变化后递增，用于丢弃旧坐标事件 |
| `actionId` | 一次需要 ack 的用户或 AI 动作 ID |

权威身份是：

```text
(ownerUserId, agentId, browserSessionId)
```

`peerId`、`connectionGeneration`、`controlLeaseEpoch` 和 `pageRevision` 都是其下的临时 fencing 字段。不要将 Browser Session 复用为 Yeaft Session，也不要把 `conversationId` 当作 Browser Session owner。创建请求可以带来源引用：

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
Agent Browser Media Peer
  RTCPeerConnection (offerer)
       │
       ├── controlled Chromium extension offscreen document
       │     └── tabCapture MediaStreamTrack
       └── Browser Runtime
             ├── Playwright/CDP page control
             ├── input arbiter + control lease
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
- 只在持有 control lease 且连接 generation 匹配时发输入；
- WebSocket reconnect 后重新取 authoritative snapshot，再 attach 新 peer；
- 显示 direct/relay、延迟、只读、重连、Agent 离线和 Session 已销毁状态。

#### Server

- 验证 Web 用户身份、角色/entitlement 和目标 Agent ownership；
- 为 lifecycle request 提供 request correlation 与 safe error；
- 维护**易失**的 Browser Session route metadata，或从 Agent snapshot 重建；
- 将 Web 发来的 signal 只转给 session owner Agent；
- 将 Agent signal 只转给发起 attachment 的确切 `clientId`；
- 签发/代理短期 TURN credential；
- 实施每 user、每 Agent 的创建/attach rate limit；
- 不读取 SDP 内容做业务逻辑，不保存媒体，不缓存实时输入。

#### Agent

- 是 Browser Session、Chromium context、page、lease 和 action ledger 的权威 owner；
- 启动固定版本、受控参数的 Chromium，不连接用户日常浏览器；
- 生成 offer、处理 answer/trickle ICE、创建 DataChannels 和 VideoTrack；
- 串行执行用户与 AI 动作，校验 generation/lease/page revision；
- 采集有界状态与指标并通过控制面上报；
- Agent 重启时关闭内存态 Browser Sessions，并向重连客户端返回明确 terminal reason。

#### TURN

- 部署 UDP + TCP + TLS 入口，至少支持 `turn:` UDP 和 `turns:` TCP/443；
- 使用 5–10 分钟 TTL 的临时 credential，用户名绑定 owner、Agent、Browser Session 和 expiry；
- 有带宽、allocation、并发、日志脱敏和滥用限制；
- credential 只在 authenticated create/attach/restart 流程中返回；
- Server 不持久化明文 TURN secret。

## 6. Chromium、媒体与 AI 控制

### 6.1 BrowserContext 所有权

每个 `browserSessionId` 拥有一个隔离的 Chromium `BrowserContext` 和一个 active page：

```text
BrowserSession
  ├── BrowserContext (cookies/storage/cache isolated from other sessions)
  ├── active Page
  ├── capture target
  ├── one control lease
  ├── one or more read-only peers (phase 1 default max: 2)
  └── bounded action ledger
```

默认使用临时 profile。若以后支持持久 profile，必须单独设计 owner、加密、删除和迁移语义；第一阶段不能偷偷写入普通 Session 数据目录。

Chromium 启动约束：

- executable/version 固定并做 capability probe；
- remote debugging 只监听 loopback 或 private pipe，不暴露 TCP 到网络；
- 扩展固定 digest，禁止从任意路径加载；
- 不使用 `--no-sandbox` 作为生产默认；容器环境若无法满足 Chromium sandbox，capability 必须 fail closed；
- 默认拒绝 geolocation、notifications、camera、microphone、clipboard-read 等站点权限；
- 下载进入 Browser Session 专用临时目录，必须经显式用户动作才能转入 workDir；
- upload 只能引用当前 owner 已授权的 Agent-local 文件 handle，不能接收浏览器提供的任意绝对路径。

### 6.2 首选捕获：`tabCapture`

受控扩展负责：

1. 由 Browser Runtime 激活目标 tab；
2. 通过 `chrome.tabCapture.getMediaStreamId({ targetTabId })` 获得一次性 stream ID；
3. 在 extension offscreen document 中调用 `getUserMedia()` 消费 stream ID；
4. 将 video track 添加到 Agent 的 `RTCPeerConnection`；
5. tab 导航继续使用同一 capture，tab 关闭或 capture error 时上报 terminal/rebind 状态。

选择原因：

- `tabCapture` 返回真实 `MediaStream`，不是 JSON/base64 frame；
- WebRTC sender 能执行帧丢弃、码率控制、关键帧和拥塞反馈；
- extension offscreen document 明确支持 `WEB_RTC` reason；
- 页面跨 origin 不影响 tab-level capture。

实现前必须做 Linux、macOS、Windows 与 headless/headful capability matrix。Chrome 文档要求 capture 由 extension invocation/active-tab 权限触发；如果受控启动环境不能可靠满足这一约束，该平台不能宣称支持首选路径。

### 6.3 Fallback：CDP screencast → canvas track

fallback pipeline：

```text
CDP Page.startScreencast (JPEG, bounded dimensions/quality)
  → immediately ack each screencastFrame
  → decode latest frame only
  → draw to canvas
  → canvas.captureStream(0)
  → requestFrame() when a new frame is drawn
  → RTCPeerConnection.addTrack()
```

硬规则：

- `Page.startScreencast` 是 experimental，只能在 startup probe 成功后 advertise；
- frame queue 长度固定为 1，新帧覆盖未处理旧帧；
- 收到 frame 后立即 `screencastFrameAck`，不能因 WebRTC backpressure 卡住 Chromium；
- JPEG/base64 不进入 DataChannel、WebSocket 或 transcript；
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
  actor: { kind: 'vp', sessionId, vpId, turnId },
  controlLeaseEpoch,
  actionId,
  action: { type: 'click', locator: { role: 'button', name: 'Save' } }
})
```

AI 优先用 DOM/role/locator 操作，不用视频像素坐标。用户输入用 viewport 坐标。两者在 Agent 的单一 action queue 中提交，执行结果带 action revision。这样页面事实只有一个 owner，不会出现用户点击和 AI click 同时修改页面的竞态。

## 7. 控制权与并发

### 7.1 单写者 lease

一个 Browser Session 同时只有一个 controller：

```text
none → user(peerId) → vp(sessionId, vpId, turnId) → user(peerId) → none
```

Agent 是 lease authority。每次 grant/revoke/transfer 都递增 `controlLeaseEpoch`。所有写动作必须携带当前 epoch；旧 epoch 一律拒绝。

默认策略：

- 用户 attach 后获得 control；
- AI 请求 control 时，若用户最近 5 秒有输入，则等待或向用户请求；
- 用户在 AI 控制期间点击“Take control”会撤销 AI lease；
- AI tool 收到 `control_revoked`，在安全边界停止，不能继续重放剩余动作；
- 只读 viewer 不接收 keyboard/pointer channel 的发送权限；
- 导航、file chooser、permission prompt 和 JavaScript dialog 都经过 action queue。

### 7.2 动作幂等与时序

- reliable `control` channel 上每条消息有单调 `seq`；Agent 只接受 `seq = lastAccepted + 1`；
- `pointer` channel 的 move/wheel 是瞬时状态，允许丢失和乱序，以最新 `seq` 为准；
- `pointerDown` / `pointerUp` / click 不走不可靠 channel，而走 reliable `control`；
- ack 只表示 Agent 已接受或执行，不表示业务页面已达到预期；
- Web 在超时后可查询 `actionId`，但不能自动重新发送非幂等动作；
- page navigation 递增 `pageRevision`，旧 revision 的坐标输入直接拒绝并要求客户端重映射。

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

Create 必须支持 `requestId` 幂等：同一 Web connection generation 内相同 request 返回相同结果；不同 payload 返回 conflict。Server 不能用 client 提交的 `ownerUserId`。

### 8.3 Attach 与 offer/answer

Web → Server → Agent：

```js
{
  type: 'browser_peer_attach',
  agentId,
  browserSessionId,
  requestId,
  connectionGeneration,
  role: 'controller' | 'viewer',
  clientCapabilities: {
    codecs: ['video/VP8', 'video/H264'],
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30
  }
}
```

Agent 创建 peer 和 offer 后返回：

```js
{
  type: 'browser_peer_offer',
  agentId,
  browserSessionId,
  peerId,
  requestId,
  connectionGeneration,
  description: { type: 'offer', sdp },
  iceServers: [{
    urls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:443?transport=tcp'],
    username,
    credential,
    expiresAt
  }]
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

candidate 为 `null` 表示 gathering complete。任何 generation 不匹配的 answer/candidate 必须丢弃。SDP 和 candidate 设单消息大小上限、字段长度上限和消息速率上限。

### 8.4 Lifecycle 和 snapshot

```js
// Web → Agent
{ type: 'browser_session_get', agentId, browserSessionId, requestId }
{ type: 'browser_session_close', agentId, browserSessionId, requestId, expectedRevision }
{ type: 'browser_session_list', agentId, requestId }
{ type: 'browser_control_request', agentId, browserSessionId, requestId, peerId }
{ type: 'browser_control_release', agentId, browserSessionId, requestId, peerId, controlLeaseEpoch }
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
  controller,
  controlLeaseEpoch,
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
  connectionGeneration,
  expiresAt
})
```

规则：

- create 前验证 user → Agent access；
- 后续每条消息同时验证 route owner、Agent id、Browser Session id；
- Agent event 中的 `agentId` 由已认证 socket stamping，忽略 payload 自称值；
- offer/ICE 只发给 `browserPeers[peerId].clientId`，不能广播给同 owner 所有 tabs；
- snapshot/status 可发给同 owner、同 Agent 的 tabs，但不包含 SDP、candidate、TURN credential；
- Server restart 后 route table 可由 Agent `browser_session_list` 重建；旧 peer 一律失效并重新 attach；
- 不把 browser signal 放入通用 disconnected message buffer。

## 9. DataChannel 协议

Agent 作为 offerer 创建三个 in-band channels。第一条 DataChannel 会触发协商，因此必须在 createOffer 前创建。

| label | 配置 | 用途 |
| --- | --- | --- |
| `browser.control.v1` | `{ ordered: true }` | keyboard、button、navigation、clipboard write、lease、ack |
| `browser.pointer.v1` | `{ ordered: false, maxRetransmits: 0 }` | pointer move、wheel、hover viewport position |
| `browser.state.v1` | `{ ordered: true }` | Agent → Web page/lease/dialog/status 增量 |

DataChannel payload 使用有版本的 CBOR 或 MessagePack binary envelope；spike 阶段可用 JSON，但生产必须测量解析和 allocation。无论编码，逻辑 schema 保持：

```js
{
  v: 1,
  browserSessionId,
  peerId,
  connectionGeneration,
  controlLeaseEpoch,
  pageRevision,
  seq,
  type,
  payload
}
```

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
- 浏览器保留快捷键必须在 Web 端明确 allowlist/denylist，避免 `Ctrl+W` 关闭 Yeaft 页；
- password field 仍可远程输入，但 text 不写日志、不进入 state event、不做 analytics。

### 9.2 Unreliable pointer messages

```js
{ type: 'pointer_move', payload: { x, y, buttons, modifiers } }
{ type: 'wheel', payload: { deltaX, deltaY, deltaMode, x, y, modifiers } }
```

Web 端按 animation frame 合并 move，Agent 端只保留最新 seq。`bufferedAmount` 超过 64 KiB 时丢弃 move/wheel，降到 16 KiB 后恢复。绝不让 pointer backlog 增加“看起来能动但落后几秒”的延迟。

### 9.3 State 与 ack

```js
{ type: 'action_ack', payload: { actionId, status: 'accepted' | 'completed' | 'rejected', code?, pageRevision } }
{ type: 'page_state', payload: { url, title, canGoBack, canGoForward, loading, pageRevision } }
{ type: 'lease_state', payload: { controlLeaseEpoch, controller, expiresAt } }
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

### 10.3 WebSocket 断开

- WebSocket 是信令和授权生命线，不是媒体 transport；短暂断开时已建立的 WebRTC 可以继续展示；
- 断线后立即冻结写控制：DataChannel 输入最多有 5 秒 grace，超过后 Agent revoke lease；
- WebSocket 恢复后 Web 请求 snapshot；Server/Agent 校验 browser session 仍属于该 user；
- 若同一 peer 仍健康，可显式 `browser_peer_reauthorize` 恢复 lease；否则创建新 peer；
- auth failure、账号 disabled、Agent ownership 变化或 session close 立即关闭 peer，不等 grace；
- WebSocket/Server restart 期间不缓存或重放输入。

### 10.4 Agent 或 Chromium 失败

- Agent WSS 断开：Server 将 Browser Sessions 标记 `agent_offline`；Web UI 停止输入并显示只读/重连；
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
3. 在 Agent 权威 snapshot 中确认 `browserSessionId` 属于该 owner；
4. 对 peer-scoped signal 再校验 `peerId + clientId + generation`；
5. 对输入再校验 `controlLeaseEpoch + pageRevision`。

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
- CSP 的 `connect-src` 需显式允许配置中的 STUN/TURN scheme/host，不使用 `*`；
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

### 12.3 Data backpressure

- reliable channel `bufferedAmount` 高水位 1 MiB，达到后暂停生成非必要 state；
- pointer channel 高水位 64 KiB，直接丢瞬时 event；
- control channel 超过 1 MiB 视为 unhealthy，关闭 peer，不无限缓存键盘/点击；
- 单条 control payload 默认 ≤ 16 KiB，clipboard/write 和 text insert 有独立上限；
- WebSocket signal 每 peer 限制 candidate 数量和每秒速率，防止滥用。

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
browser_control_reject_total{reason}
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
- generation、lease epoch、page revision fencing；
- control seq、pointer coalescing、bufferedAmount thresholds；
- normalized coordinate mapping、letterbox、DPR 和 viewport resize；
- action timeout 不自动重放；
- TURN credential TTL/scope/signature；
- safe logging redaction；
- Chromium flags、download path 和 permission defaults；
- idle/resource cleanup exactly once。

### 14.2 Integration

使用真实 Agent Browser Runtime 和虚拟/loopback peer：

1. create → offer → answer → candidate → first video frame；
2. pointer/keyboard → page DOM change → video reflects change；
3. AI locator action与用户 control transfer 串行；
4. WebSocket disconnect，WebRTC 暂时继续，grace 后写 lease revoke；
5. WebSocket reconnect → snapshot → reauthorize 或 reattach；
6. forced ICE failure → one restart → TURN relay；
7. stale answer/candidate/action 被 fencing；
8. Chromium crash/capture track end 清理全部 resource；
9. 两个同名 Browser Session ID（不同 Agent）不串路由；
10. Server restart 后旧 peer 失效、Session snapshot 可重建。

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

- 未认证、disabled user、跨 owner、跨 Agent 访问全部 fail closed；
- candidate flood、oversized SDP、DataChannel oversized payload、seq abuse 被限流/断开；
- Browser page 无法访问 Yeaft origin credentials；
- CDP endpoint 不可从网络访问；
- extension/capture package digest 被篡改时 capability 关闭；
- private/metadata network policy 在托管 Sandbox 中有效；
- 日志与 metrics 扫描不含 password、key text、SDP、candidate IP、TURN credential。

## 15. 渐进交付计划

### Phase 0：技术 spike（不对用户开放）

- 在三平台验证 `tabCapture` 的受控 activation、offscreen WebRTC 与导航连续性；
- 选择并审计 Node WebRTC endpoint、Chromium automation 和 TURN 方案；
- 测量原生 track 与 CDP→canvas fallback 的 CPU/延迟；
- 验证 H.264/VP8 capability；
- 输出 go/no-go matrix。未达标的平台不进入 capability。

### Phase 1：控制面与只读视频

- Agent Browser Runtime lifecycle；
- Server owner-scoped wire、route/peer fencing 和 TURN credential；
- Web browser store、video panel、状态与 stats；
- 单 peer、单 page、VP8、无输入；
- feature flag 默认关闭。

### Phase 2：用户输入

- 三 DataChannels、输入映射、backpressure；
- lease、action ack、navigation/dialog；
- keyboard/IME、viewport、移动端基础输入；
- network matrix 与安全测试通过后小比例 rollout。

### Phase 3：Yeaft 共用 Browser Runtime

- Browser tools 通过本地 API 操作同一 context；
- user/VP control transfer；
- audit metadata、AskUser 边界和 cancellation；
- 不把 raw page/video/input 写入 transcript 或 memory。

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

1. **Agent WebRTC endpoint**：原生 addon、独立 sidecar 还是受控 Chromium extension peer。要求 Node 24 支持、三平台预编译/供应链、DTLS/SRTP 安全维护和可取消资源生命周期。
2. **Chromium automation package**：复用测试用 Playwright 不等于适合 npm Agent production dependency。要评估 browser distribution、体积、升级和 licensing。
3. **tabCapture 激活约束**：自动化环境能否在用户可接受路径满足 extension invocation；不能则该平台走 fallback。
4. **TURN implementation/deployment**：coturn 或托管服务，需验证临时 credential、TLS 443、regional routing、egress cost 和 abuse controls。
5. **codec policy**：H.264 的硬件/软件 encoder 可用性、license 和画质；最低共同基线仍为 VP8。
6. **headless/headful**：不同平台对扩展和 tab capture 的支持；capability 以 probe 为准。
7. **持久 profile**：若产品需要登录态跨 Browser Session 保留，另开存储、安全和删除设计。

Phase 0 只有在以下条件全部满足后退出：

- 至少 Linux 的首选 capture path 达到延迟/CPU gate；
- UDP blocked 时 TURN TLS/443 可连接；
- ownership、generation 和 lease prototype fail closed；
- 选定依赖有维护、安全、Node 24 和发布方案；
- 资源 cleanup 在 100 次循环后无显著泄漏；
- Martin 对精确 spike/design head 完成独立 review。

## 19. 实现映射

建议新增边界，不要求文件名逐字一致：

```text
agent/browser-runtime/
  service.js              lifecycle and authoritative store
  chromium.js             executable/context/page ownership
  capture.js              tab capture + CDP fallback selection
  peer.js                 RTCPeerConnection and channels
  input.js                lease/fencing/action queue
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
