# Sandbox Agent 差距矩阵

本文以 `docs/notes/2026-07-17-sandbox-agent-design.md` 第 19、20、21 节为验收基线。关闭状态只表示已有代码或可重复证据入口；真实 Host 项在 qualification 报告落档前一律保持未关闭，且 `SANDBOX_ENABLED` 必须保持默认 `false`。

## 第 19 节验收组

| 验收组 | 现状证据 | 缺口 | 责任代码 / 测试 | 关闭证据 |
| --- | --- | --- | --- | --- |
| 19.1 Ownership 与容量 | 按 `user_id` 查询；容量和 reservation 在 SQLite 事务内结算；稳定错误码 | 真实并发压力需在集成动作复验 | `server/db/sandbox-db.js`；`test/server/sandbox-db.test.js` | 专项测试覆盖 owner、单实例、两 slot、不同规格、Stop/失败保留及 Remove 后释放 |
| 19.2 生命周期 | 持久 operation、generation fence、Agent Ready、reconciler、Remove recovery | Host 重启及持久目录恢复必须实测 | `server/sandbox-reconciler.js`；`test/server/sandbox-reconciler.test.js` | 自动化覆盖刷新恢复、超时、迟到 result、credential 吊销；Host qualification 待补 |
| 19.3 资源隔离 | 固定 Podman/gVisor 参数、非 root、只读 rootfs、CPU/内存/PID/IO、XFS quota | mock runner 不能证明内核 enforce、EDQUOT 和跨 Sandbox 隔离 | `agent/managed-sandbox/runtime-executor.js`；Host qualification | 未关闭：专用 Host 报告必须附命令、内核观测和隔离结果 |
| 19.4 网络 | nftables 默认拒绝入站和私网/metadata/同桥访问，允许公开 egress | DNS rebinding、工具链公网访问、带宽/连接限制需实测 | `agent/managed-sandbox/runtime-executor.js`；Host qualification | 未关闭：专用 Host 网络测试报告 |
| 19.5 Credential | 单次 bootstrap、scope 绑定、长期 credential 与 Remove 吊销 | argv/env/image/log secret redaction 需真实进程与日志扫描 | `server/db/sandbox-db.js`；`test/server/sandbox-agent-auth.test.js`；Host qualification | 自动化协议测试已覆盖；真实 redaction 报告待补 |
| 19.6 Epoch 与崩溃点 | Helper journal 使用 WAL/FULL；active epoch 与 digest durable；旧 epoch、冲突、回退、迟到 envelope 被拒绝；activation 等待执行中 operation | journal 损坏和 activation commit 前后 kill -9 要在专用 Host 注入 | `agent/managed-sandbox/helper.js`；`test/agent/managed-sandbox-helper.test.js` | 单元故障测试覆盖 durable activation/restart/fence；Host fault injection 待补 |
| 19.7 删除与账户关闭 | Remove 需要完整 absence proof 后原子释放；账户删除在 reservation 存在时拒绝 | Host 离线、主机重启、账户删除中途崩溃需实测 | `server/db/sandbox-db.js`；`test/server/sandbox-db.test.js`；Host qualification | 控制面测试已覆盖；真实 crash recovery 报告待补 |

## 第 20 节实施步骤

| 步骤 | 现状与责任 | 关闭证据 |
| --- | --- | --- |
| 1. Host qualification 与 capability | capability fail closed 已实现；qualification 入口为签名 attestation | 自动化校验签名、freshness、image 和健康项；真实 Host 未关闭 |
| 2. 数据模型、状态机与容量 | SQLite schema、事务 reservation、operation 状态机 | `test/server/sandbox-db.test.js` |
| 3. Credential 与 managed runtime | bootstrap exchange、credential scope、Agent Ready | `test/server/sandbox-agent-auth.test.js` |
| 4. Controller、Helper、signed protocol | mTLS、Ed25519、journal、durable active epoch | Controller/Helper 专项测试 |
| 5. 镜像、存储、网络与 lifecycle | 固定 digest runtime executor、XFS、nftables、reconcile | mock 自动化已完成；内核 E2E 未关闭 |
| 6. Settings Sandbox 页面 | capability/snapshot/operation 驱动；loading/empty/error/disabled/长文本和 i18n | `test/web/sandbox-settings.test.js`；视觉证据由 UX 审查动作采集 |
| 7. 故障、安全、容量 | 自动化入口存在 | 专用 Host fault injection、容量与安全报告未关闭 |

## 第 21 节上线门禁

| 门禁 | 状态 | 证据 / 关闭条件 |
| --- | --- | --- |
| 专用 Host qualification | 未关闭 | `qualify-sandbox-host` 动作生成带时间、Host epoch、镜像 digest 的报告 |
| 两个 reservation 与并发不超卖 | 代码关闭，集成复验待完成 | `maxReservedSandboxes=2`；容量专项测试 |
| Normal 资源限制实测 | 未关闭 | 专用 Host 上验证 `1 vCPU / 2 GiB / 20 GB`、PID、IO、EDQUOT |
| Stop/Start 数据恢复 | 未关闭 | 对 home/workspace 写入哨兵并在重启后核验 |
| Remove/账户删除 crash recovery | 未关闭 | 关键 commit 前后 kill -9 与主机重启故障注入 |
| 公网可用、禁止网段阻断 | 未关闭 | 公开 HTTPS/npm/pip/git/gh/Web/Search/LLM 与私网矩阵 |
| Credential 与 redaction | 部分关闭 | 协议自动化通过；真实 argv/env/image/log 扫描待完成 |
| durable epoch fence | 部分关闭 | Helper 自动化通过；commit 前后故障注入待完成 |
| UI 主题、移动端、i18n、错误状态 | 部分关闭 | 状态/i18n 自动化通过；light/dark 和桌面/移动截图待 UX 审查 |
| 运维 runbook | 关闭 | `docs/operations/sandbox-agent.md` 描述部署、禁用、吊销、Remove、恢复、回滚和账户删除 |

## 安全结论

当前实现仍是生产门禁前的垂直切片。不得把本矩阵中的“代码关闭”解释为专用 Host 已通过验收。在第 21 节所有门禁有独立证据前，保持 `SANDBOX_ENABLED=false`，不得宣称生产可用。
