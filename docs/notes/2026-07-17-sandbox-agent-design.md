# Sandbox Agent 架构设计

- 状态：设计提案，作为实现与验收契约
- 日期：2026-07-17
- Owner：Linus
- 范围：用户级 Sandbox Agent 的创建、运行、停止、恢复和删除

## 1. 目标与结论

Yeaft 为有权限的用户提供一个托管 Sandbox Agent。每个用户最多拥有一个 Sandbox；每个 Sandbox 对应一个独立容器、一个 Linux 用户、一个持久化 home/workspace，以及一个只属于该 Sandbox 的 Yeaft Agent 身份。

用户在 Settings 的 Sandbox 管理页面中完成以下操作：

- 启用 Sandbox；
- 配置 Agent 名称；
- 选择 Small、Normal 或 Large 规格；
- 查看异步安装进度和运行状态；
- Stop、Start 或 Remove Sandbox；
- Stop 后再次 Start 时恢复用户数据和 Agent 身份。

当前区域的产品容量上限为两个已保留 Sandbox。容量计算包括创建中、运行中和已停止的 Sandbox，只有 Remove 完成后才释放名额。

默认 Normal 规格为：

```text
1 vCPU / 2 GiB RAM / 20 GB disk
```

Sandbox 默认允许访问公开互联网，满足下载依赖、Git 操作、包管理、网页访问和搜索等开发需求。网络层仍然阻止访问宿主机管理面、云 metadata、Docker API、私有网络和其他 Sandbox，并默认拒绝所有外部入站连接。

## 2. 范围边界

### 2.1 本期范围

- 全局功能开关、用户 entitlement 和 Host capability 三层准入；
- 一个用户最多一个未删除 Sandbox；
- 三种可配置规格及 Host 资源校验；
- 异步 Create、Stop、Start、Remove；
- 容器镜像、持久存储、磁盘硬配额和资源限制；
- Sandbox 专用 Agent bootstrap、注册、认证和吊销；
- Server、Controller 与 privileged Helper 的控制协议；
- desired/observed state reconcile 和崩溃恢复；
- 默认公开互联网出站，以及宿主和私网隔离；
- UI 状态、错误反馈、审计、容量和安全验收。

### 2.2 非目标

- 不允许用户上传或选择任意容器镜像；
- 不提供 Docker daemon、Docker socket 或 privileged container；
- 不提供公网端口映射或对外托管服务；
- 不承诺保存内存中的进程状态；
- 不把容器 rootfs 当作持久数据盘；
- 不在第一期支持一个用户创建多个 Sandbox；
- 不在第一期支持用户自定义 CPU、内存和磁盘的任意数值；
- 不把当前 mixed-use 应用宿主直接视为已通过生产安全认证的 Sandbox Host。

## 3. 产品模型与用户路径

### 3.1 三层启用条件

Sandbox 能力只有在以下条件同时满足时才对用户可用：

1. 平台配置 `sandbox.enabled=true`；
2. 用户具有 Sandbox entitlement；
3. 至少一个 Sandbox Host 通过 qualification 且有容量。

UI 中的“启用 Sandbox”动作直接创建用户的 Sandbox，不再额外保存一个容易与资源状态漂移的独立布尔值。Sandbox 记录及其 `desiredState` 是启用状态的唯一事实来源。

若平台或 Host 不可用，页面保留入口并说明原因，不发送创建请求。用户 entitlement 不应暴露其他用户或 Host 的详细资源信息。

### 3.2 首次创建

未创建 Sandbox 时，页面显示：

- Agent name；
- Size；
- 各规格 CPU、内存和磁盘；
- 当前是否有可用容量；
- `Enable Sandbox` 主按钮。

默认值：

```text
Agent name: <username>-sandbox
Size: Normal
```

Agent name 规则：

- 长度 1–64 个字符；
- 去除首尾空白；
- 允许字母、数字、空格、`-`、`_` 和 `.`；
- 只作为用户可见名称，不直接拼接为目录、容器名或 shell 参数；
- Server 始终使用内部 `sandboxId` 生成资源标识。

点击 Enable 后，Server 完成原子容量 reservation 并返回 `202 Accepted`。UI 立即进入 `Setting up`，不等待 HTTP 请求完成全部安装。

### 3.3 Setting up

页面按后端上报的阶段展示：

```text
Reserving capacity
Preparing storage
Creating sandbox
Starting Yeaft Agent
Waiting for Agent connection
Verifying health
Ready
```

用户刷新页面、关闭浏览器或重新登录后，仍能从持久化 operation 恢复进度。WebSocket 只负责实时更新，REST/数据库状态才是事实来源。

只有以下条件全部成立时，状态才从 `Setting up` 变为 `Running`：

1. 容器按指定 image digest 运行；
2. CPU、内存、PID 和磁盘 quota 已 inspect 验证；
3. Sandbox 专用 credential 完成认证；
4. Agent 回传的 `sandboxId`、`instanceId`、`generation` 和 image digest 匹配；
5. Agent 心跳正常；
6. Server 完成一次端到端健康检查。

“容器已启动”不能等价为“Sandbox 已就绪”。

### 3.4 Running

运行页面显示：

- Agent 名称和规格；
- Sandbox 与 Agent 状态；
- CPU、内存、磁盘使用量；
- 创建时间和最后就绪时间；
- 最近一次 operation；
- 可执行的 Stop 和 Remove。

资源指标是运维信息，不是计费承诺。采样失败时显示 unknown，不能把缺失值伪装成零。

### 3.5 Stop 与 Start

Stop 将 `desiredState` 改为 `stopped`。完成后：

- 容器中所有进程停止；
- `/home/yeaft` 和 `/workspace` 保留；
- Sandbox Agent credential 保留；
- `instanceId` 和容量 reservation 保留；
- 临时文件系统和内存状态不保证保留。

Start 将同一 Sandbox 收敛回 `running`。实现可以启动原容器，也可以用同一 image digest 重建容器，但必须重新挂载原持久目录并使用原 Sandbox 身份。

Stop 不释放名额。否则新用户可能占用名额，原用户将无法履行“可恢复 Start”的产品承诺。

### 3.6 Remove

Remove 是不可逆操作，UI 必须二次确认并明确说明 workspace 和 home 数据将永久删除。

删除顺序：

1. 将 `desiredState` 写为 `removed`，operation 进入 `removing`；
2. 吊销 bootstrap token 和长期 Sandbox credential；
3. 阻止 Agent 再次连接；
4. 停止并删除容器；
5. 删除持久目录、quota project 和网络身份；
6. inspect 确认运行时及磁盘资源不存在；
7. 释放 Host 资源账本和产品容量 reservation；
8. 写入 `removedAt` 和 terminal result。

任何一步失败都进入可重试的 `remove_failed`，由 reconciler 继续清理。在真实资源删除完成前不能提前释放容量。

### 3.7 失败与恢复

可重试错误展示当前阶段、稳定错误码和 Retry。不可自动恢复或状态不确定时显示 `Recovery required`，禁止继续执行破坏性操作，直到后台 inspect 或人工处理完成。

页面不能无限显示 Setting up。每个阶段都有 deadline；超时后 operation 必须进入明确错误状态，但 desired state 仍由 reconciler 持续收敛。

## 4. 规格与容量

### 4.1 规格表

| 规格 | CPU | 内存 | 磁盘 | 典型用途 |
| --- | ---: | ---: | ---: | --- |
| Small | 0.5 vCPU | 1 GiB | 10 GB | 轻量编辑、Git、简单脚本 |
| Normal | 1 vCPU | 2 GiB | 20 GB | 默认开发、依赖安装、常规测试 |
| Large | 2 vCPU | 4 GiB | 40 GB | 大仓库、构建和较重测试 |

第一期当前节点只开放 Small 和 Normal。Large 只有在 capability API 确认 Host 的 CPU、内存、磁盘和并发预算均满足时才显示为可选。

规格值由 Server 的受控 catalog 决定。客户端只提交 size ID，不能提交原始 Docker resource options。

### 4.2 当前容量

当前区域配置：

```text
maxReservedSandboxes = 2
```

计入 reservation 的状态：

```text
reserving
provisioning
starting
waiting_for_agent
running
stopping
stopped
remove_failed
recovery_required
```

`removed` 不计入；`removing` 在清理成功前仍计入。

除了实例数限制，还必须同时检查资源账本：

- 已承诺 CPU；
- 已承诺内存；
- 已承诺磁盘；
- Host 运行安全余量；
- runtime、quota、网络和 Controller 健康状态。

实际容量是产品上限与 Host capability 的较小值。即使实例数未到两个，只要目标规格无法安全放置，也必须返回 capacity unavailable。

### 4.3 原子 reservation

创建必须在同一数据库事务或等价原子条件更新中完成：

1. 验证用户没有另一个未删除 Sandbox；
2. 验证 Host 状态和规格支持；
3. 条件增加 slot 与资源 reservation；
4. 创建 Sandbox 记录；
5. 创建 provisioning operation。

禁止使用“先 count、再 insert”。并发请求必须只有一个成功。

建议约束：

- `userId` 上建立“未删除 Sandbox”的唯一条件索引；
- Host reservation 使用 version/CAS 或事务；
- Create API 接受 idempotency key；
- 相同 idempotency key 和相同 request digest 返回原 operation；
- 相同 key、不同 digest 返回 conflict。

## 5. 系统架构

```text
Browser / Settings
        |
        v
Yeaft Server control plane
  - auth / ownership / entitlement
  - desired state / operations
  - capacity reservation
  - credential authority
  - signed authorization
        |
        | outbound mTLS controller channel
        v
Sandbox Controller on qualified Host
  - runtime lifecycle / inspect
  - image verification
  - observed state
        |
        +--> rootless isolated runtime
        |      +--> one user Sandbox container
        |
        +--> local Unix socket
               v
        narrow privileged Helper
        - disk quota
        - controlled ownership
        - host firewall rules
        - durable authorization journal
```

### 5.1 Yeaft Server

Server 负责：

- 用户认证、entitlement 和 ownership；
- API 与 UI 状态；
- Sandbox、Host、operation 和 reservation 持久化；
- desired state；
- Sandbox credential 生命周期；
- 签发端到端 Ed25519 operation envelope；
- Agent Ready 校验；
- reconcile 调度和审计。

Server 不挂载 Docker socket，也不直接通过远程 shell 管理 Host。

### 5.2 Sandbox Controller

Controller 负责：

- 通过出站 mTLS 长连接连接 Server；
- 拉取并验证固定 digest 镜像；
- 创建、启动、停止、删除和 inspect Sandbox；
- 以固定 schema 调用 privileged Helper；
- 上报 observed state、资源用量和 operation result；
- 启动后扫描现有 Sandbox 并恢复 reconcile。

Controller 不接受任意 Docker JSON、镜像、mount、capability、network、runtime 或 shell command。每个动作都由 allowlisted operation schema 生成。

### 5.3 隔离运行时

生产 Host 必须使用通过 qualification 的隔离运行时，例如：

- rootless Docker/Containerd 配合 gVisor `runsc`；或
- 经过同等门禁验证的 Kata Containers。

运行契约：

- 容器内 Agent 使用非 root `yeaft` 用户；
- rootfs read-only；
- `cap-drop ALL`；
- `no-new-privileges`；
- 独立 PID、mount、network、IPC 和 user namespace；
- 固定 seccomp/AppArmor 或 SELinux policy；
- 禁止 host namespace；
- 禁止 Docker socket 和任意 hostPath；
- PID、CPU、内存和 IO hard limit；
- `/tmp`、`/run`、`/dev/shm` 使用有限大小 tmpfs；
- 不发布入站端口。

qualification 必须验证实际组合，而不是仅检查某个二进制存在。

### 5.4 Privileged Helper

Helper 只执行确实需要宿主权限的窄操作：

- 分配、设置、验证和释放 XFS project quota；
- 设置固定数据目录 ownership；
- 安装、验证和删除该 Sandbox 的 host firewall policy；
- 对中断操作执行有限 inspect/recovery。

Helper：

- 不持有 Docker socket；
- 不提供 shell 或任意命令执行；
- 不接受任意路径；
- 不访问网络；
- 路径必须位于固定 Sandbox data root；
- 使用 `openat2`/等价安全解析拒绝 symlink、`..` 和 path traversal；
- 只接受 Server 签名且 schema 完整的 operation。

本地 Unix socket 位于 root-owned `0750` 目录，权限为：

```text
0660 root:sandbox-controller
```

Helper 使用 `SO_PEERCRED` 验证固定 Controller UID/GID，并校验调用进程属于预期 systemd unit/cgroup。这个检查只限制本机调用者，最终操作授权仍来自 Server 的端到端签名。

## 6. 数据模型

字段名称是设计契约；具体数据库可在保持唯一约束和原子语义的前提下映射。

### 6.1 `sandbox_hosts`

```js
{
  hostId,
  name,
  enabled,
  qualified,
  qualificationVersion,
  maxReservedSandboxes,
  reservedSandboxes,
  supportedSizes: ['small', 'normal'],
  reservedResources: {
    cpu,
    memoryBytes,
    diskBytes
  },
  connectionEpoch,
  activeControllerId,
  lastHeartbeatAt,
  capabilities: {
    runtime,
    cgroupVersion,
    quota,
    networkPolicy,
    totalCpu,
    availableMemoryBytes,
    availableDiskBytes
  },
  disabledReason,
  version,
  createdAt,
  updatedAt
}
```

### 6.2 `sandboxes`

```js
{
  sandboxId,
  userId,
  instanceId,
  hostId,

  agentName,
  size: 'small' | 'normal' | 'large',
  resources: {
    cpu,
    memoryBytes,
    diskBytes,
    pids
  },

  desiredState: 'running' | 'stopped' | 'removed',
  observedState:
    'reserving'
    | 'provisioning'
    | 'starting'
    | 'waiting_for_agent'
    | 'running'
    | 'stopping'
    | 'stopped'
    | 'removing'
    | 'remove_failed'
    | 'failed'
    | 'recovery_required'
    | 'removed',

  generation,
  imageDigest,
  credentialId,
  quotaProjectId,
  reservationHeld,

  agentConnected,
  agentReadyAt,
  lastHeartbeatAt,
  lastError: {
    code,
    safeMessage,
    operationId,
    occurredAt
  },

  version,
  createdAt,
  updatedAt,
  removedAt
}
```

`instanceId` 在 Stop/Start 后保持不变，使现有 Agent identity 能稳定恢复。

`generation` 在以下操作中递增：

- 首次创建；
- 更换镜像重建；
- 修改规格；
- 强制 credential 轮换并重建；
- destructive recovery。

普通 Stop/Start 不增加 generation。

### 6.3 `sandbox_operations`

```js
{
  operationId,
  sandboxId,
  hostId,
  generation,
  action,
  desiredState,
  status: 'pending' | 'dispatched' | 'running' | 'succeeded' | 'failed',
  requestDigest,
  acceptedEpoch,
  attempts,
  deadlineAt,
  result,
  createdAt,
  startedAt,
  completedAt
}
```

operation 按 `operationId + requestDigest` 幂等。相同 ID、不同 digest 必须拒绝。

### 6.4 `sandbox_credentials`

```js
{
  credentialId,
  sandboxId,
  userId,
  instanceId,
  generation,
  secretHash,
  status: 'active' | 'revoked',
  issuedAt,
  lastUsedAt,
  expiresAt,
  revokedAt
}
```

数据库只保存 secret hash。明文 credential 只在签发时出现一次。

## 7. 状态机与 reconcile

### 7.1 主状态机

```text
none
  -> reserving
  -> provisioning
  -> starting
  -> waiting_for_agent
  -> running

running
  -> stopping
  -> stopped

stopped
  -> starting
  -> waiting_for_agent
  -> running

running | stopped | failed | recovery_required
  -> removing
  -> removed
```

异常路径：

```text
transitional state
  -> failed
  -> retrying/reconcile
  -> target state or recovery_required
```

### 7.2 Desired 与 observed

- Server 持久化 `desiredState`；
- Controller/Agent 上报 `observedState`；
- reconciler 比较两者并生成幂等 operation；
- 一次 WebSocket 请求或内存 Promise 不是生命周期事实来源；
- Server、Controller、Helper 或 Host 重启后，都从持久状态恢复。

同一 Sandbox 的 destructive operations 必须串行。operation 携带 `generation` 和 record version，旧 generation 的结果不能覆盖新状态。

### 7.3 Result 结算

Server 仅在以下条件全部满足时接受 result：

- operationId 存在；
- hostId 和 sandboxId 匹配；
- request digest 匹配；
- generation 匹配该 operation；
- accepted epoch 符合该 operation 的授权记录；
- terminal result 尚未以不同内容结算。

迟到的旧 result 可写入历史审计，但不能改变当前 generation 的 observed state、credential 或 reservation。

## 8. 镜像设计

### 8.1 基础镜像

```text
node:22-bookworm-slim@sha256:<pinned-digest>
```

选择 Debian slim 而不是 Alpine，避免 musl 对 npm 原生模块、预编译二进制和第三方 CLI 的兼容成本。

镜像预装：

- Node.js 22、npm、npx；
- Python 3、pip、venv；
- Git、Git LFS、GitHub CLI；
- bash、zsh、OpenSSH client；
- curl、wget、CA certificates、GPG；
- jq、ripgrep、findutils、procps；
- iproute2、dnsutils；
- tar、gzip、xz、zip、unzip；
- gcc、g++、make、pkg-config 和常用 native build 基础；
- tini；
- 固定版本的 Yeaft Agent。

不包含：

- Docker daemon/socket；
- systemd；
- 桌面、VNC 或浏览器；
- 数据库服务；
- Java、Go、Rust 等未声明的大型 SDK；
- 用户 credential；
- 构建缓存和 apt package lists。

预计体积：

```text
Registry 压缩下载：约 250–400 MB
Host 解压占用：约 700 MB–1.2 GB
```

最终值必须由 CI 构建产物测量。镜像层在同一 Host 共享，不重复计入每个用户的 10/20/40 GB quota。

### 8.2 构建与供应链

- 基础镜像固定 digest；
- apt 和 Agent 版本固定并由 Renovate/受控流程升级；
- 使用 multi-stage build，清除 apt/npm/pip cache；
- 生成 SBOM；
- 镜像签名并在 Controller 拉取后验证；
- production 只接受配置中的 digest，不接受 mutable tag；
- 定期重建以获取安全更新；
- 镜像升级通过新 generation 重建，不允许 managed Agent 自升级。

### 8.3 进程入口

使用 `tini` 作为 PID 1，由非 root `yeaft` 用户运行：

```bash
yeaft-agent container-run \
  --config /run/yeaft/bootstrap.json \
  --credential-file /home/yeaft/.yeaft/managed-agent-credential
```

`container-run` 是托管容器入口。它复用 Yeaft Agent 的注册和连接能力，但不在容器内安装 systemd service，也不要求 privileged install。

## 9. Agent 安装、secret 与注册

### 9.1 不复用用户通用 Agent secret

Sandbox 必须归属当前用户并连接该用户的 Yeaft Server，但不能把用户的通用 Agent secret 复制进容器。通用 secret 一旦泄露，可能获得注册其他 Agent 的权限，也无法在 Remove 时只吊销一个 Sandbox。

安全实现采用由用户身份授权、Server 签发的单用途 bootstrap token。它在产品语义上完成“使用用户身份安装并连接”，但权限只覆盖一个确定的 `sandboxId + instanceId + generation`。

UI 不要求用户再次输入 secret。Server 根据已认证用户创建 scoped bootstrap token。

### 9.2 Bootstrap token

Server 生成 256-bit 随机 token，数据库只保存 hash，并绑定：

```text
userId
sandboxId
instanceId
generation
imageDigest
expiresAt
singleUse = true
```

Controller 将 token 写入容器内受控 tmpfs secret file：

- 权限 `0600`；
- owner 为 `yeaft`；
- 不进入 argv、环境变量、镜像层或日志；
- 完成兑换或超时后立即删除。

### 9.3 长期 Sandbox credential

Agent 首次连接时原子消费 bootstrap token，换取仅属于该 Sandbox 的长期 credential，绑定：

```text
userId + sandboxId + instanceId + generation
```

credential 以 `0600` 文件保存在 quota-backed `/home/yeaft/.yeaft/`。Stop/Start 后继续使用；Remove 时立即吊销。

认证 frame 必须包含：

- sandboxId；
- instanceId；
- generation；
- image digest；
- Agent version。

Server 只接受完全匹配的记录。旧 generation 即使文件仍存在也必须拒绝。

### 9.4 Ready 判定

Agent authenticated 不等于 Ready。Server 还要发起一次健康检查，确认：

- Agent 能处理 request/response；
- workDir 可读写；
- 资源身份与当前 generation 一致；
- 心跳进入正常周期。

健康检查成功后才写 `agentReadyAt` 并向 UI 推送 Running。

## 10. 持久存储与数据恢复

### 10.1 存储布局

Sandbox Host 使用独立 XFS 数据盘，并启用：

```text
ftype=1,pquota
```

每个 Sandbox 使用固定内部目录和 project ID：

```text
/var/lib/yeaft-sandboxes/<sandboxId>/home
/var/lib/yeaft-sandboxes/<sandboxId>/workspace
```

分别挂载到：

```text
/home/yeaft
/workspace
```

两个目录属于同一个 quota project，防止通过不同挂载点绕过总磁盘额度。

不能依赖 Docker 可写层或产品数据库中的“20 GB”字段模拟磁盘限制。Helper 必须设置真实 hard quota，并在 provisioning 完成前验证。

### 10.2 持久内容

Stop/Start 和容器重建后保留：

- workspace 和 Git 仓库；
- `/home/yeaft` 用户文件；
- `.yeaft` 配置和 Sandbox credential；
- npm cache、Python venv 和用户安装内容；
- Agent 的持久状态。

不保留：

- 正在运行的进程；
- RAM；
- `/tmp`、`/run`、`/dev/shm`；
- rootfs 修改，因为 rootfs 为 read-only。

“恢复 Sandbox 数据”指重新挂载上述持久目录，不是恢复进程快照。

### 10.3 Quota 验证

进入 `storage_ready` 前必须验证：

- project inherit flag；
- hard quota 精确匹配规格；
- UID/GID ownership；
- 非 root `yeaft` 用户可读写；
- 超限写入返回 `EDQUOT`；
- Stop/Start 后文件仍存在；
- Remove 后 project ID 和目录均已清理。

## 11. 网络设计

### 11.1 默认公开互联网访问

Sandbox 默认允许访问公开互联网，不使用逐域名 allowlist。以下开发行为应无需用户额外配置即可工作：

- `curl`、`wget` 和普通 HTTP/HTTPS 下载；
- npm、pip、apt 等包管理；
- Git HTTPS/SSH；
- GitHub CLI 和公开 API；
- LLM provider API；
- 网页访问、搜索和 DNS 查询；
- Agent 到 Yeaft Server 的 HTTPS/WSS 连接。

网络策略在 Host network namespace/veth 边界实施透明出站 NAT，不要求每个 CLI 正确读取 `HTTP_PROXY`。应用层代理可用于可观测或缓存，但不能成为基本联网能力的唯一实现。

### 11.2 必须阻断的目标

正常联网不意味着可访问宿主和控制面。每个 Sandbox 默认拒绝：

- Host gateway 和 Host 自身的非公开管理地址；
- RFC1918 IPv4 私网；
- IPv4 loopback、link-local、carrier-grade NAT、benchmark 和保留网段；
- IPv6 loopback、link-local、ULA、multicast 和保留网段；
- 云 metadata，包括 `169.254.169.254` 及云厂商 IPv6 等价地址；
- Docker/Container runtime API；
- 数据库、Controller、Helper 和内部管理端口；
- 其他 Sandbox 的地址和 bridge network；
- DNS 响应最终指向上述地址的连接。

Yeaft Server 若只提供私有地址，必须由 Host policy 建立到“精确目的 IP + 端口”的专用例外，只允许公开 Agent 接入端点，不能放开整个控制面网段。

### 11.3 网络规则

默认规则：

- 出站到公开 IPv4/IPv6：允许；
- established/related 返回流量：允许；
- 外部发起入站：拒绝；
- Sandbox 之间横向流量：拒绝；
- 端口映射：不提供；
- DNS：使用受控 resolver，并在数据面再次按目的 IP 拒绝私网，避免 DNS rebinding；
- redirect、CNAME 或重新解析后落入禁止网段：仍由数据面拒绝。

为防止滥用，平台可统一阻断高风险出站端口，例如 SMTP 25，并应用连接数、带宽和 DNS query rate limit。这些限制不得破坏常规下载、搜索、Git 和包管理。

### 11.4 网络可观测与隐私

记录最小必要 metadata：

- sandboxId；
- 时间；
- 目的 IP/端口；
- 允许或拒绝；
- 字节数和规则 ID。

默认不记录 TLS 明文、HTTP body、Authorization header、源代码或下载内容。日志遵守用户 ownership 和保留期限。

## 12. API 与事件

### 12.1 REST API

```text
GET    /api/sandbox/capability
GET    /api/sandbox
POST   /api/sandbox
POST   /api/sandbox/:sandboxId/start
POST   /api/sandbox/:sandboxId/stop
DELETE /api/sandbox/:sandboxId
GET    /api/sandbox/:sandboxId/operations/:operationId
```

所有资源操作都验证当前登录用户是 owner。客户端提交的 userId、hostId、resources 或 credential 字段一律忽略或拒绝。

Create 请求：

```json
{
  "agentName": "alice-sandbox",
  "size": "normal"
}
```

返回：

```http
202 Accepted
```

```json
{
  "sandboxId": "...",
  "operationId": "...",
  "status": "setting_up"
}
```

容量不足：

```http
409 Conflict
```

```json
{
  "code": "sandbox_capacity_unavailable",
  "message": "All sandbox slots are currently reserved."
}
```

冲突中的 operation 返回已有 operation，不能重复执行生命周期动作。

### 12.2 Capability 响应

Capability API 至少返回：

```js
{
  enabled,
  entitled,
  available,
  unavailableReason,
  sizes,
  defaultSize: 'normal',
  capacity: {
    canCreate
  }
}
```

不要返回其他用户数量、Host 内网地址或精确安全配置。

### 12.3 实时事件

Server 通过现有 authenticated WebSocket 向 owner 推送：

- sandbox snapshot；
- operation phase；
- observed state；
- safe error；
- resource usage；
- Agent connected/ready 状态。

事件包含 `sandboxId`、`operationId`、`generation` 和单调 version。客户端忽略旧 version。断线重连后先重新 GET snapshot，再消费新事件。

## 13. Signed operation 与 Helper 防重放

### 13.1 Operation envelope

Server 对 canonical payload 进行 Ed25519 签名：

```js
{
  schemaVersion,
  keyId,
  action,
  hostId,
  sandboxId,
  operationId,
  generation,
  connectionEpoch,
  issuedAt,
  expiresAt,
  nonce,
  requestDigest,
  params
}
```

Helper 内置受信公钥集合，独立验证签名。Controller 无权自行扩大、修改或重新签发操作。

要求：

- canonical serialization 固定；
- action 与 params 使用严格 schema；
- TTL 短且 Host 时间受监控；
- nonce 至少 128-bit 随机；
- key rotation 有明确 overlap 和 revoke 流程；
- operation journal durable；
- 相同 operationId、相同 digest 幂等；
- 相同 operationId、不同 digest 拒绝。

### 13.2 Durable `connectionEpoch` fence

Server 为每个 Host 使用数据库原子递增分配 `connectionEpoch`。新 Controller connection 建立后，Server 必须先签发独立控制记录：

```js
{
  action: 'ACTIVATE_EPOCH',
  schemaVersion,
  keyId,
  hostId,
  connectionEpoch,
  issuedAt,
  expiresAt,
  nonce
}
```

只有收到 Helper 的 durable activation ack 后，Server 才把该 connection 标记为可调度。

### 13.3 Helper epoch 持久化

Helper 使用 root-only durable journal，例如：

```text
SQLite WAL
synchronous=FULL
目录与数据库权限 0700 root
```

持久保存：

- active epoch；
- activation nonce 和 digest；
- operation journal；
- terminal results。

Helper 重启时从 journal 恢复。journal 丢失、损坏或无法证明状态时必须 fail closed，不能相信 Controller 声明的 epoch。

激活规则：

```text
newEpoch < activeEpoch  -> reject
newEpoch = activeEpoch  -> idempotent only when digest matches
newEpoch > activeEpoch  -> activate
```

写入 active epoch 和 activation journal 必须在同一个 FULL-sync transaction 中完成。事务 commit 是 epoch 激活的线性化点。

### 13.4 普通 operation 规则

`ACTIVATE_EPOCH` 和普通 privileged operation 共用 per-host exclusive lane。

普通 operation 必须满足：

```text
operation.connectionEpoch === durable activeEpoch
```

执行顺序：

1. 验证 Server Ed25519 签名；
2. 验证 host、action、TTL、nonce、digest 和严格 params schema；
3. 验证 epoch 与 durable active epoch 严格相等；
4. FULL-sync 写入 `IN_PROGRESS`；
5. 执行幂等 allowlisted action；
6. FULL-sync 写入 terminal result；
7. 释放 exclusive lane。

`IN_PROGRESS` commit 是 operation 获准执行的线性化点。

新 epoch activation 必须等待旧 epoch 已进入执行阶段的 operation 完成。activation commit 后，任何旧 epoch envelope，即使此前从未到达、nonce 未使用且仍在 TTL 内，也必须拒绝。

### 13.5 Crash recovery

Helper 启动时先恢复所有 `IN_PROGRESS` operation，再开放 socket。操作必须能根据以下键 inspect 或幂等重放：

```text
hostId
sandboxId
generation
operationId
requestDigest
```

无法安全判断结果时写 `RECOVERY_REQUIRED`，Host 随即 fail closed，禁止新 epoch 和新 privileged operation，直到人工修复。

旧 operation 已在 epoch activation 前越过 `IN_PROGRESS` 线性化点时，允许其完成并持久化历史 result；新 epoch 激活必须等待它完成。该 result 只能结算原 operation，不能覆盖更新 generation 的状态。

## 14. Host qualification 与部署边界

### 14.1 当前部署边界

Yeaft Server 控制面可以继续运行在当前服务上，但当前同时承载 Web、数据库、Registry 等工作的 mixed-use 宿主默认：

```text
sandbox.host.enabled = false
```

它不能在未经升级和 qualification 的情况下承载生产用户代码。开发环境可显式启用内部测试，但不得把内部测试结果视为生产隔离证明。

生产执行面使用专用 Sandbox Host/VM，并满足：

- 仍在安全支持期的 OS 和 kernel；
- cgroup v2；
- 通过测试的 rootless isolation runtime；
- 独立 XFS quota 数据盘；
- 足够 CPU、内存、磁盘和安全余量；
- 受控出站网络与 host firewall；
- 不与数据库、Registry、控制面 secret 共置；
- Controller/Helper 版本与 Server 协议兼容。

### 14.2 Qualification checks

Host 注册和每次升级后至少验证：

- kernel、cgroup v2 和 user namespace；
- runtime isolation；
- seccomp/LSM profile；
- rootless container create/start/stop/remove；
- CPU、内存、PID 和 IO limit；
- XFS project quota 及 `EDQUOT`；
- read-only rootfs 和 mount 边界；
- 公开互联网可访问；
- Host、私网、metadata 和 Sandbox 横向访问被阻止；
- Agent 能连接 Yeaft Server；
- Helper socket、`SO_PEERCRED` 和 signed operation；
- epoch activation 和 crash recovery；
- image digest/signature 验证。

任何关键项失败都设置 `qualified=false` 并停止新调度。已有 Sandbox 保持 desired state，但进入明确 degraded 状态，不能静默迁移或删除。

## 15. 安全、审计与 secret 处理

### 15.1 Trust boundary

Sandbox 内代码、依赖、仓库和网络响应均视为不受信任。不能因为一个容器只属于一个用户，就假设它不会攻击 Host、其他用户或控制面。

### 15.2 Secret 规则

- 通用用户 Agent secret 不进入 Sandbox；
- bootstrap token 单次、短期、scoped；
- 长期 credential 只属于一个 Sandbox generation；
- secret 不进入 argv、环境变量、镜像、operation result 或日志；
- Remove 和账户删除先吊销 credential；
- 日志和错误统一做 secret redaction；
- Controller 与 Server 使用独立 mTLS identity；
- Helper 只信 Server operation signing key。

用户自己的项目 secret 若未来需要注入，必须设计独立的 secret store 和显式授权，不在本期范围内。

### 15.3 审计事件

至少记录：

- 创建、启动、停止、删除请求及 actor；
- entitlement 和容量拒绝；
- reservation 获取与释放；
- credential 签发、兑换、认证和吊销；
- Controller connect/disconnect、epoch activation；
- signed operation 接受、拒绝和 result；
- qualification 变化；
- private/metadata network deny；
- recovery_required 和人工恢复。

审计日志包含 ID 和安全 metadata，不包含 secret、源码或原始 tool output。

## 16. 账户删除

账户删除使用两阶段流程：

1. 立即禁止登录、吊销用户和 Sandbox credential，并将 Sandbox desired state 写为 removed；
2. 等待 runtime、persistent data、quota 和网络资源确认删除，再完成用户数据清理。

若 Host 离线，账户保持 `deletion_pending` 并持续 reconcile。不能因为用户记录先被物理删除而失去 Sandbox ownership 和清理依据。

## 17. 可观测与运维

### 17.1 指标

- Sandbox 各状态数量；
- Host reservation、CPU、内存和磁盘余量；
- operation duration、retry 和 failure；
- provisioning 各阶段耗时；
- Agent Ready time；
- Stop/Start/Remove 成功率；
- Helper journal 和 epoch 错误；
- quota 使用率和 `EDQUOT`；
- egress bytes、connection count 和 deny；
- Controller/Agent heartbeat age。

### 17.2 告警

- Host qualification 失败；
- reservation 与实际资源漂移；
- Setting up 超时；
- removal 长时间未完成；
- Helper journal 损坏；
- epoch 回退或签名验证失败；
- Sandbox 可访问禁止网段；
- 磁盘逼近 Host 安全水位；
- 同一用户或 Sandbox 异常重试/网络滥用。

### 17.3 日志边界

operation log 和 Controller log 使用结构化 ID 串联。面向用户只返回稳定错误码和安全信息；详细宿主路径、内网地址、签名内容和 stack trace 只进入受限运维日志。

## 18. UI 设计约束

Sandbox 管理页位于用户 Settings，复用现有固定尺寸 Settings 外壳：

- header 和 footer 固定；
- body 独立滚动；
- 切换 tab 时外壳不跳动；
- 按钮复用 `.btn-primary`、`.btn-secondary`、`.btn-ghost`；
- input/select 复用全局控件；
- 所有颜色和间距使用 design tokens；
- light/dark 均验证；
- 文案同步 en 和 zh-CN i18n；
- 移动端保持明确的主要操作和删除确认。

状态名称必须可理解，不能只显示内部 enum。对于长时间 operation，展示阶段和最后更新时间，而不是没有上下文的 spinner。

Stop、Start 和 Remove 在请求发出后立即禁用冲突操作。重复点击复用相同 operation，不产生并发 lifecycle 操作。

## 19. 验收测试

### 19.1 Ownership 与容量

- 用户只能读取和操作自己的 Sandbox；
- 一个用户不能创建第二个未删除 Sandbox；
- 两个 slot 已保留时第三个创建原子失败；
- 并发创建不会超卖；
- 不同规格同时创建仍遵守资源账本；
- Stop 不释放 slot；
- Remove 完成后才释放；
- disabled、unentitled、unqualified 和 no-capacity 返回不同稳定错误码。

### 19.2 生命周期

- 创建直到 Agent 真正 Ready 才显示 Running；
- 页面刷新后恢复 provisioning；
- Stop/Start 保留 workspace、home、credential 和 instance identity；
- 临时进程不会被错误宣称为恢复；
- Server、Controller、Helper 和 Host 重启后自动 reconcile；
- Remove 中途崩溃后继续；
- credential 吊销后旧容器无法重连；
- 旧 generation 不能覆盖新状态；
- deadline 超时后 UI 得到明确错误。

### 19.3 资源隔离

- CPU、内存、PID 和 IO hard limit 实测生效；
- 磁盘超限得到 `EDQUOT`；
- read-only rootfs 不能绕过 quota；
- 容器内不是 root；
- 无 Docker socket、host namespace、任意 hostPath 或额外 capability；
- 两个 Sandbox 不能互相访问或读取数据。

### 19.4 网络

- 任意公开 HTTPS 下载成功；
- npm、pip、apt、Git HTTPS/SSH 和 GitHub CLI 成功；
- Web/Search 和 LLM provider 请求成功；
- Agent HTTPS/WSS 连接成功；
- Host gateway、loopback、RFC1918、link-local、metadata 和其他 Sandbox 访问失败；
- DNS rebinding 到私网仍失败；
- 外部无法主动连接 Sandbox；
- 全局带宽/连接限制不破坏正常开发；
- 网络日志不包含 credential 和请求 body。

### 19.5 Credential

- bootstrap token 只能兑换一次；
- 过期、错误 Sandbox、错误 generation 和错误 digest 均拒绝；
- token 不出现在 argv、环境、镜像和日志；
- Remove 后长期 credential 立即失效；
- 用户通用 Agent secret 从未进入 Sandbox。

### 19.6 Epoch 与崩溃点

- epoch 回退被拒绝；
- 相同 epoch、相同 digest 幂等 activation；
- 相同 epoch、不同 digest 冲突；
- activation durable ack 前禁止调度；
- 新 epoch 激活后，旧 envelope 首次迟到也拒绝；
- 旧 operation 正在执行时 activation 等待；
- `IN_PROGRESS` commit 前后 crash 均可恢复；
- activation commit 前后 crash 均可恢复；
- Helper 重启恢复 active epoch；
- journal 损坏时 fail closed；
- 迟到旧 result 不覆盖当前 observed state；
- operationId 相同、digest 不同拒绝。

### 19.7 删除与账户关闭

- Running、Stopped、Failed 状态均可 Remove；
- 容器、目录、quota、network identity 全部确认清理；
- Host 离线时保持 deletion pending；
- 删除完成前不释放 reservation；
- 账户删除先吊销 credential，后完成物理清理。

## 20. 实施顺序

1. **Host qualification 与 capability API**：先证明 runtime、quota、网络和资源限制可用；失败时页面显示 unavailable。
2. **数据模型、状态机与容量 reservation**：在不调用容器 runtime 的情况下完成并发、幂等和 crash-safe 控制面测试。
3. **Sandbox credential 与 managed Agent runtime**：实现 scoped bootstrap、长期 credential、`container-run` 和 Ready attestation。
4. **Controller、Helper 与 signed operation protocol**：实现 mTLS、Ed25519 envelope、durable journal、epoch fence 和 recovery。
5. **镜像、存储、网络与 lifecycle reconcile**：完成 Create、Stop、Start、Remove、quota、公开互联网和隔离验证。
6. **Settings Sandbox 管理页面**：UI 完全由 capability、snapshot 和 operation 驱动，不模拟成功状态。
7. **故障注入、安全测试和容量测试**：所有验收门禁通过后，才将 `sandbox.enabled` 对生产用户开放。

## 21. 上线门禁

生产启用前必须同时满足：

- 专用 Sandbox Host qualification 通过；
- 当前容量明确配置为两个 reservation；
- 创建并发测试证明不会超卖；
- Normal `1 vCPU / 2 GiB / 20 GB` 资源限制实测；
- Stop/Start 数据恢复实测；
- Remove 和账户删除的 crash recovery 实测；
- 默认公开互联网可用，禁止网段全部阻断；
- scoped credential 和 secret redaction 通过安全测试；
- Helper durable epoch fence 通过故障注入；
- UI light/dark、移动端、i18n 和错误状态通过测试；
- 运维具备禁用 Host、吊销 credential、强制 Remove 和处理 recovery_required 的 runbook。

任何一项未满足时，保持 `sandbox.enabled=false` 或仅开放给内部测试用户。