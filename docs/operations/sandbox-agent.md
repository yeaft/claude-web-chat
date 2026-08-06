# Sandbox Agent 运维门禁

Sandbox Agent 默认关闭。当前 mixed-use Server Host 不得注册为 Sandbox Host，也不得设置 `SANDBOX_ENABLED=true`。

生产启用前必须由专用 Host 的 Controller 持久上报 qualification，并逐项通过：固定 image digest、受限 Helper、隔离运行时、CPU/内存/PID/IO enforce 与 inspect、XFS hard quota、默认拒绝入站、阻断宿主/私网/metadata/控制面/其他 Sandbox 的网络策略，以及 Controller/Helper/runtime/quota/network 健康检查。

只有上述门禁全部通过，且用户 entitlement 与原子容量账本均允许时，`GET /api/sandbox/capability` 才返回可用。Host qualification attestation 必须携带签名覆盖的实时 `memoryAvailableMiB`；Server 使用 `SANDBOX_HOST_MEMORY_RESERVE_MIB`（默认 2048 MiB）保留控制面/宿主安全余量，并要求 `memoryAvailableMiB - reserve >= Sandbox memory limit`。Create reservation 与每次 Create/Start/Retry 分发都在数据库事务内重复检查，Helper runtime 又在调用容器 `create`/`start` 前基于实时 Host 可用内存执行同一门禁。采样缺失、陈旧、数值不可信、并发 operation 已被领取或容量不足均 fail closed，并只向用户返回稳定的不可用原因，不披露 Host 或其他用户信息。

当前垂直切片开放控制面 reservation、持久 snapshot、生命周期 operation、不可变的用户操作、Controller 结算、运行态 recovery 与 credential 签发/吊销审计事件、Host epoch/freshness fence、超时恢复、scoped credential、周期 reconciler，以及仅在完整 absence proof 后执行的 Remove 原子结算。专用 Controller 必须通过 `POST /api/sandbox/hosts/attest` 提交由独立 `SANDBOX_HOST_ATTESTATION_KEY` 签名的单次 nonce qualification attestation；Server 校验固定 `SANDBOX_IMAGE_DIGEST`、Host 绑定、时钟窗口、资源正整数和全部健康检查后，才原子更新 Host qualification，并持久记录接受或拒绝审计。Create/Start/Retry 分发会生成单次短期 bootstrap envelope；managed runtime 通过 `POST /api/sandbox/bootstrap/exchange` 兑换可单独吊销的长期 credential，全程不使用用户通用 Agent secret。Controller 的 inspect 结果不能单独推进 Running；结果必须包含该 Sandbox 的 CPU、内存、PID、IO、quota 和网络隔离检查证明，Server 还会验证同一 `sandboxId`、`instanceId`、`generation` 和 image digest 的 managed Agent 已认证、存活并完成端到端同步。它不会在 Server Host 上创建容器。`agent/managed-sandbox/runtime-executor.js` 提供专用 Host 的固定 Podman/gVisor 数据面执行器：只把 Helper 已验证的 operation 映射为固定 digest 容器、只读 rootfs、非 root/user namespace、cap-drop、no-new-privileges、CPU/内存/PID/IO hard limit、持久 home/workspace、XFS hard quota 和 nftables 网络隔离操作，并在返回前重新 inspect。执行器要求 `dedicatedHost=true` 和绝对工具/数据路径；不得配置或启动在 mixed-use Server Host。真实 Host 仍必须完成 14.2 所列 qualification 与内核级 E2E 验收；这些门禁全部通过前必须保持 `SANDBOX_ENABLED=false`。Server 现要求 Controller result 内嵌由独立 Helper Ed25519 身份签署的 operation-scoped attestation，并通过 `SANDBOX_HELPER_ATTESTATION_PUBLIC_KEY` 验证；Controller 自己声明的布尔 proof 不再被信任。除布尔健康项外，Helper 必须逐项证明 inspect 到的 CPU、内存和磁盘值与 reservation 精确一致，PID/IO 限制为正值，XFS hard quota 已生效，且网络策略为 `public-egress-isolated`；缺失或不匹配均拒绝结算。该协议门禁只建立可验证的数据面合同，不代表运行时或隔离策略已经部署并通过 Host 验收。`agent/managed-sandbox/helper.js` 提供了专用 Host 的最小受限 Helper 授权边界：只接受绑定 `hostId`、固定 image digest、短 TTL 且经 Server Ed25519 签名的 allowlist 操作；operation ID 与请求 digest 持久幂等，发现中断的 privileged operation 后会按 Sandbox 持久进入 recovery fence，拒绝 Create/Start/Stop/Retry，但仍允许同一 Sandbox 的签名 Remove 进入受限 executor，并且只有完整 absence proof 才能完成清理，避免形成不可释放的容量终态。无法归属到 Sandbox 的旧 journal 记录仍保持全局 fail closed，必须人工恢复。Helper 只会为 executor 返回且通过本地结构校验的精确资源 inspect 或完整 Remove absence proof 生成 Ed25519 attestation；缺失 CPU/内存/磁盘、PID、IO、XFS hard quota、网络策略或 credential absence 时只签发失败结果，不能被 Controller 包装成成功证明。`agent/managed-sandbox/controller.js` 提供专用 Host 的最小 HTTPS Controller 边界：强制客户端证书认证和固定 bearer endpoint identity，只接受 `/v1/operations`，先绑定目标 `hostId`，再把原始 Server 签名 envelope 交给 Helper，并使用独立 Ed25519 私钥签署绑定 operation/generation/Host epoch/request nonce 的 Controller result。Controller 不持有运行时或 quota 权限，也不能改写 Helper attestation。Controller 与 Helper 工厂目前不提供 mixed-use Host 自动启动路径；专用 Host 部署必须显式把 `createSandboxRuntimeExecutor()` 注入 Helper，并使用 root-owned systemd unit/socket 与专用数据盘。未完成 Host qualification 和内核级验收时生产开关继续保持关闭。

Reconciler 仅在 `SANDBOX_ENABLED=true` 且 `SANDBOX_CONTROLLER_URL` 为 HTTPS，并同时配置 `SANDBOX_CONTROLLER_TOKEN`、`SANDBOX_CONTROLLER_CLIENT_CERT`、`SANDBOX_CONTROLLER_CLIENT_KEY`、`SANDBOX_CONTROLLER_CA_CERT`、`SANDBOX_CONTROLLER_ATTESTATION_FINGERPRINT`、`SANDBOX_OPERATION_SIGNING_PRIVATE_KEY`、`SANDBOX_CONTROLLER_RESULT_PUBLIC_KEY`、`SANDBOX_HELPER_ATTESTATION_PUBLIC_KEY`、`SANDBOX_CONTROLLER_HOST_ID` 与独立的 `SANDBOX_BOOTSTRAP_SIGNING_KEY` 时启动。Host qualification 上报必须由 TLS 层验证并匹配该固定 SHA-256 客户端证书指纹，再验证 attestation payload 签名；共享 HMAC 不能单独作为 Controller 身份。Controller 请求使用专用客户端证书和显式 CA 信任执行双向 TLS；系统 CA、Bearer token 或 HTTPS 本身均不能替代该身份门禁。Server 使用独立 Ed25519 私钥签名 Controller operation envelope，专用 Host 只持有对应公钥；Controller 使用另一把私钥签名 result，Server 只持有 `SANDBOX_CONTROLLER_RESULT_PUBLIC_KEY`。两类消息均包含版本、签发/过期时间或时钟窗口与单次 nonce；Controller result 必须回绑 operation、generation、Host epoch 和请求 nonce，重放、迟到或未签名结果不会进入状态结算。Bearer token 仅作为传输端点认证，不能替代消息完整性与防重放校验。私钥必须由 secret manager 注入、不得复用用户或通用 Agent secret，并需在 Server 重启后保持稳定；任一密钥缺失时 fail closed。它从持久化 operation 恢复并只向指定专用 Host 分发 allowlisted operation；网络失败不会伪造状态，后续 tick 会使用同一 operation 的持久 credential 记录重建相同 bootstrap envelope，不会撤销既有 token 或长期 credential。每个 tick 还会巡检所有仍持有 reservation 的 Sandbox：Host epoch 变化、qualification/健康/freshness 丢失，或超过 `SANDBOX_AGENT_RECOVERY_GRACE_MS` 后 Running Agent 仍未通过 authenticated liveness 检查，都会持久进入 `recovery_required`、吊销 credential 并保留 reservation；该状态不会自动跳回 Running，必须经受控 Remove 或恢复流程处理。Controller 回报必须携带 `operationId`、`generation` 与 `hostEpoch`。Server 在结算结果时会重新验证 Host epoch、qualification、freshness 以及 Controller/Helper/runtime/quota/network 健康状态；任一门禁丢失都拒绝推进状态。Host epoch 改变会持久进入 `recovery_required`、吊销该 Sandbox 的 credential 并继续保留 reservation。用户仍可发起 Remove；新的 Remove operation 优先绑定同一 Host 当前持久 epoch，Host 记录缺失时保留 Sandbox 已持久化的最后 fenced epoch。Controller 分发仍只面向配置绑定的专用 Host；Remove 结果结算不依赖 Host 恢复 qualification，而依赖 operation/generation/epoch fence 和完整资源 absence proof，避免失格 Host 制造无法释放的 reservation 终态。Create、Start 和其他推进运行态的结果仍要求 Host 通过全部 qualification 与健康门禁。Remove 成功回报必须逐项证明 container、storage、quota、network 与 credential 均不存在；缺少任一证明时 reservation 继续保留。超时 operation 会进入稳定失败态，仍由 Retry 或 Remove 恢复，禁止人工直接清除 reservation。

账户删除同样遵守 reservation 边界：只要用户仍持有 Sandbox reservation，删除请求返回稳定的 `SANDBOX_REMOVE_REQUIRED` 冲突，用户和 Sandbox 数据均不改变。只有 Remove 已完成真实资源 absence proof 和原子结算后，账户删除事务才会清理已释放的 Sandbox 历史并删除用户，避免外键错误或绕过容量结算。
用户 entitlement 只能由已认证管理员通过 `PUT /api/admin/sandbox/entitlements/:userId` 显式设置；请求只接受布尔 `enabled`，目标用户必须存在。每次变更与执行者用户名会写入 `sandbox_entitlement_audit_events`。该接口不修改平台开关、Host qualification 或容量账本，因此 entitlement 本身不能绕过任何创建门禁。

## 部署与 Host qualification

1. 在专用 Host 安装固定版本 Podman、gVisor、XFS quota 和 nftables，把 Controller 与 Helper 配置为 root-owned systemd service/socket；Server Host 不得复用这些权限。
2. 将数据盘以 XFS project quota 挂载到 `SANDBOX_DATA_ROOT`，预拉取并验证 `SANDBOX_IMAGE_DIGEST`。
3. 在普通 Docker 开发/CI 主机可运行 `SANDBOX_DOCKER_TEST_IMAGE=<固定测试镜像> npm run test:sandbox:docker`。该验收会真实创建容器，验证 ready 标记、home/workspace 哨兵 Stop/Start 恢复、Remove 无残留、Docker memory/PID hard limit、内存压力 OOM，以及受控低可用内存和并发竞争下 `docker create` 调用数保持为零。Docker 不可用或镜像不存在时命令明确失败，不会跳过或假通过。此命令不执行生产 Podman/gVisor、XFS quota、nftables 或专用 Host 安全拓扑，因此只能作为开发验收证据。
4. 在仍保持 `SANDBOX_ENABLED=false` 时运行 `node scripts/qualify-sandbox-host.mjs <report.json>`。该脚本只做静态能力采集；随后必须按 `docs/operations/sandbox-gap-matrix.md` 执行资源、网络、Credential、重启和故障注入矩阵，并把结果与 report 一起留档。当前非专用执行环境的脱敏拒绝证据和专用 Host 关闭条件记录在 `docs/operations/sandbox-host-gate-evidence.md`。
5. 只有第 21 节全部证据经过独立审查后，才可对批准范围设置 `SANDBOX_ENABLED=true`。Docker E2E、单独的 attestation、qualification 脚本成功或单元测试成功都不是生产放行。

## 监控与告警

持续监控 Host qualification freshness、reservation 与实际资源漂移、operation deadline、Agent heartbeat、Helper journal/epoch 错误、quota 使用、egress deny 和 removal age。qualification 失败、epoch 回退、签名失败、禁止网段可达、reservation 漂移、磁盘安全水位或长期 `recovery_required` 必须告警。

## 故障恢复

- Controller/Server 重启：从持久 operation 恢复，禁止手工改状态或释放 reservation。
- Helper 中断：保持 recovery fence；核验 journal、容器、目录、quota、network 和 credential 后，使用受控 Remove 收敛。不得删除 journal 来“修复”。
- Host 重启或 epoch 变化：先禁用 Host，吊销受影响 credential，激活并持久确认新 epoch，再 reconcile；旧 envelope 和迟到 result 必须拒绝。
- 强制 Remove：只能走签名 Remove operation，且必须取得五项 absence proof。Host 离线时保持 deletion pending。

## 回滚

1. 立即设置 `SANDBOX_ENABLED=false` 并重启 Server，使新 capability fail closed。
2. 禁用 Host qualification/Controller 分发，吊销 bootstrap 和长期 credential。
3. 保留数据库、Helper journal、Host 数据盘与审计日志；不要直接删除 reservation。
4. 对现存实例逐个执行受控 Remove，取得完整 absence proof 后再释放容量。
5. 验证无残留容器、目录、quota、network identity 和 credential 后，才回滚二进制或镜像。

## 账户删除

账户仍持有 reservation 时删除返回 `SANDBOX_REMOVE_REQUIRED`。运维先吊销 credential，再发起 Remove；只有 Controller/Helper 证明运行时与持久资源完全不存在并完成原子结算后，才重试账户物理删除。Host 离线或证据不完整时保持 pending，不得绕过。