# Sandbox Host 门禁证据

本文记录 2026-07-27 对当前执行环境的脱敏复核。它只回答“当前环境能否作为获批专用 Sandbox Host”，不把协议单元测试、mock runner 或 Docker 开发验收解释为 Podman/gVisor、XFS、nftables 和内核故障注入的生产证据。

## 结论

当前执行环境不是获批专用 Sandbox Host，静态 qualification 被可靠拒绝，生产门禁保持未关闭。`SANDBOX_ENABLED` 在执行环境中未设置，`server/config.js` 的默认解析结果为 `false`；本次复核没有启用 Sandbox，也没有修改任何运行时开关。

## 2026-07-27 脱敏复核

在保持 Sandbox 关闭时执行 `node scripts/qualify-sandbox-host.mjs <临时报告路径>`，脚本以退出码 `1` 结束且报告 `passed=false`。临时 JSON 报告在提取下列非敏感结论后删除：

- `dedicatedHost=false`，没有专用 Host 声明。
- Host epoch 缺失，固定镜像 digest 缺失。
- Podman 和 nftables 工具缺失。
- `yeaft-sandbox-controller.service` 与 `yeaft-sandbox-helper.socket` 均未处于 active 状态。
- `xfs_quota` 检查命令本身成功，但单项成功不能证明数据盘启用了 XFS project hard quota，也不能关闭 EDQUOT、跨 Sandbox 隔离或持久化恢复门禁。
- 环境中的 `SANDBOX_ENABLED`、`SANDBOX_DEDICATED_HOST`、`SANDBOX_HOST_EPOCH` 和 `SANDBOX_IMAGE_DIGEST` 均未设置；配置加载复核确认 Sandbox 默认关闭。

qualification 的拒绝是预期的 fail-closed 行为，不是 Host 验收通过，也不是测试环境故障需要绕过。

## 证据层级

| 证据层级 | 当前结论 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 协议与行为测试 | 已复核 | qualification 签名、freshness、镜像绑定、健康项、容量 admission、reconcile fence 和 runtime inspect 缺失时会拒绝推进 | Linux 内核、Podman/gVisor、XFS 或 nftables 实际 enforce |
| mock runner | 已覆盖 | 固定命令参数、inspect 合同和 fail-closed 分支 | 容器逃逸边界、真实资源压力、EDQUOT、真实网络拓扑 |
| Docker 开发验收 | 已有独立开发证据入口 | Docker 的基础生命周期、持久哨兵、memory/PID hard limit 和低内存 admission | 生产 Podman/gVisor、XFS quota、nftables、专用 Host 拓扑；不得作为生产放行证据 |
| 当前环境静态 qualification | 明确失败 | 非专用、依赖缺失或身份材料缺失时可靠拒绝 | 获批专用 Host 的任何内核级能力 |
| 获批专用 Host E2E | 未执行、未关闭 | 只有完成后才能证明生产运行边界 | 当前不得宣称生产可用 |

## 仍未关闭的内核级与故障注入门禁

以下项目需要在获批专用 Host 上执行，当前环境不具备安全前提，因此本次没有尝试伪造、降级或跳过：

- 固定 digest 镜像在 Podman/gVisor 下运行，并复核非 root、只读 rootfs、user namespace、cap-drop、no-new-privileges 和挂载边界。
- `1 vCPU / 2 GiB / 20 GB`、PID、IO 和 XFS project hard quota 的真实 enforce，包括内存压力、PID 耗尽、IO 限制、EDQUOT 与跨 Sandbox 隔离。
- 默认拒绝入站，以及 IPv4/IPv6 私网、metadata、宿主、控制面、同桥和其他 Sandbox 阻断；同时验证公开 HTTPS、npm、pip、git、gh、Web/Search/LLM 的允许路径、DNS rebinding、带宽和连接限制。
- Controller、Helper、runtime、Host 重启和 epoch 切换；在关键持久化边界前后执行 kill -9，验证迟到结果拒绝、generation/epoch fence、reservation 保留和恢复。
- Stop/Start 与 Host 重启后的 home/workspace 恢复。
- Remove 与账户删除的崩溃恢复，并逐项取得 container、storage、quota、network 和 credential absence proof 后才释放 reservation。
- 使用真实进程和日志扫描验证 bootstrap、长期 credential、argv、environment、image metadata、Controller/Helper journal 与 Server 日志无 secret 泄漏。

## 关闭条件

生产门禁只能在以下条件全部满足后关闭：

1. 获批的专用 Host 使用专用数据盘和 root-owned Controller/Helper systemd 单元，安装固定版本 Podman、gVisor、XFS quota 与 nftables；mixed-use Server Host 不得复用这些权限。
2. 在仍保持 `SANDBOX_ENABLED=false` 时配置真实 Host epoch 和固定 `sha256` 镜像 digest，静态 qualification 报告通过并安全留档。
3. Controller 提交签名、fresh、Host/image scoped 的 qualification attestation，Server 接受并记录审计事件；签名、nonce、epoch、镜像、资源或任一健康项不匹配时仍能证明 fail closed。
4. 完成上述资源、网络、credential、重启、故障注入和 Remove absence proof 矩阵，保留命令、时间、Host epoch、镜像 digest、预期结果和脱敏实际结果。
5. 独立安全、架构与运维审查确认全部第 21 节门禁关闭后，才可另行批准受控启用。代码合并就绪不等于生产启用就绪。

在这些条件满足前，`SANDBOX_ENABLED=false` 是唯一允许的生产姿态。
