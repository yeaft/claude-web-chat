# Browser Runtime Phase 0 实测结果

- 日期：2026-08-08
- 状态：Linux 首选媒体链路技术验证通过；**不对用户开放**
- 设计契约：[`2026-08-07-webrtc-browser-runtime-design.md`](./2026-08-07-webrtc-browser-runtime-design.md)

## 结论

Linux headless 环境中的首选链路已经用真实 Chrome for Testing 验证：

```text
fixed MV3 extension action
  -> chrome.tabCapture
  -> extension offscreen document
  -> RTCPeerConnection VP8 sender
  -> loopback RTCPeerConnection receiver
  -> decoded video frame
```

Phase 0 只落地 Agent-local 配置、受管浏览器安装、固定扩展、startup probe、资源上限和协议序列原语。它不 advertise Browser capability，也没有 Server signaling、Web video panel、TURN 或用户输入。上述功能分别属于 Phase 1/2，不能把当前结果解释为 Browser 已可用。

## 选择

- Automation：`puppeteer-core@24.41.0`，兼容项目 Node `>=22.5.0` 边界。
- Browser distribution：显式安装并固定 Chrome for Testing `151.0.7922.71`。系统 branded Chrome 不作为隐式 fallback；它可能拒绝 unpacked extension，协议版本也可能缺失 `Extensions` CDP domain。
- Browser 下载：只在执行 `yeaft-agent browser install` 时发生，普通 Agent 安装不自动下载约 389 MiB 的 Chromium，也不在默认关闭状态启动浏览器进程。
- Extension：npm Agent 包内固定 MV3 extension；启动前校验 SHA-256 `9a947b51ced492758d977431a8956dfa14721be53eef0fd0373bc7c4bd3d99b1`。
- Capture：`chrome.tabCapture` + offscreen document。
- Codec baseline：强制协商并验证 `video/VP8`。
- Profile：每次 probe 使用临时 profile，结束或失败后删除；Phase 0 不保存用户登录态。

## Linux 实测

环境：Linux x86_64、Node `v24.15.0`、headless Chrome for Testing `151.0.7922.71`。

单次 probe：

- capture：`800×600 @ 30 fps`；
- 首个 decoded frame：约 `1.4–2.7 s`；
- 进程树最大 RSS：约 `204 MiB`；
- 2.08 秒 probe 期间平均 CPU：约 `66%` 单核；
- Server WebSocket：没有 video/frame payload。

100 次真实 create/close soak：

- 成功：`100/100`；
- 首帧/完整 probe duration：p50 `1.612 s`、p95 `2.613 s`、max `11.737 s`；
- 临时 profile：前后均为 `0`；
- Chrome 进程：前后均为 `0`。

初始 soak 曾出现 `3/100` 次 MV3 service worker attach race：target 已可见但 `chrome.storage.session` 尚未注入。修复只在同一总 deadline 内重试只读 storage 查询，不重放 extension action 或 capture 副作用；修复后为上述 `100/100`。

## 对 Agent 的压力

默认关闭时：

- 不下载 Chromium；
- 不启动 Browser/encoder；
- 不 advertise Browser capability；
- Browser Runtime service 模块实测 RSS 增量约 `3.2 MiB`，且不会加载 `puppeteer-core`。

启用并运行时：

- 主要 CPU/RSS 在独立 Chromium 进程树，不在 Agent query loop；
- startup probe 的短时成本约 `204 MiB RSS + 0.66 CPU core`；
- 实际持续 Session 的资源成本仍需 Phase 1 做 10 分钟动态页面和 8 小时 soak，不能用首帧 probe 外推；
- 配置硬上限当前是 2 Sessions、每 Session 2 peers、1920×1080、30 fps、4 Mbps，Phase 1 必须在创建 Session 和 sender parameters 上真正执行这些上限。

## Go / No-go matrix

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Linux headless tabCapture | GO | action activation、offscreen capture、VP8 decode 已实测 |
| Linux cleanup | GO | 修复 attach race 后 100 次循环无 profile/process 泄漏 |
| Node/package | GO | Node `>=22.5` 兼容；extension 已进入 npm package dry-run 清单 |
| 默认 Agent 压力 | GO | 默认关闭、无 Chromium 下载/进程、无 capability |
| macOS / Windows | NO-GO | 尚未实测，禁止 advertise |
| TURN TLS/443 | NO-GO | 尚未选择和部署 TURN，Phase 1 上线前必须完成 |
| Server-stamped identity / routing | NO-GO | Phase 1 尚未实现 |
| Web read-only viewer | NO-GO | Phase 1 尚未实现 |
| 用户输入 / DataChannels | NO-GO | Phase 2 尚未实现 |
| H.264 | 未决 | Phase 0 只确认 VP8 最低共同基线 |
| CDP screencast fallback | 未决 | 主路径已通过；fallback 仍需单独性能验证 |

## 本地验证命令

```bash
yeaft-agent browser install --name <agent-instance>
yeaft-agent browser probe --name <agent-instance>
yeaft-agent browser status --name <agent-instance>
```

`browser enable` 只允许内部开发验证 startup probe；Phase 0 即使 probe ready 也不会 advertise Browser capability。Phase 1 完成 owner-checked create/attach/signaling 后才能改变该行为。
