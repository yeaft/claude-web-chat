# Docker 化 Yeaft Agent 运维说明

Sandbox 页面现在管理的是一个普通的 Docker 化 Yeaft Agent，不再使用专用 Sandbox Host、Controller、Helper、attestation、Podman/gVisor 或容量账本。容器内运行与本机安装相同的 `yeaft-agent`，通过现有 WebSocket 协议连接 Server；Server 仅管理该容器的创建、启动、停止、状态查询和删除，不参与 Agent 内部执行。

## 启用 Server 管理

Server Host 必须已安装 Docker，并允许 Server 进程执行 `docker`。设置：

```bash
SANDBOX_ENABLED=true
SANDBOX_SERVER_URL=wss://your-yeaft-server.example
SANDBOX_AGENT_IMAGE=ghcr.io/yeaft/yeaft-web-code-agent-agent:dev
SANDBOX_STATE_DIR=/var/lib/yeaft/container-agents
```

`SANDBOX_SERVER_URL` 必须是容器能访问的 `ws://` 或 `wss://` 地址，不能使用仅在 Host 内有效的回环地址。生产环境应固定具体镜像 tag 或 digest，而不是长期跟随 `:dev`。

官方 Server 镜像已经包含 Docker CLI，但默认 `docker-compose.yml` 不授予 Docker socket；Sandbox 因此保持关闭。确认宿主机安全边界后，使用显式 override 启动：

```bash
cp server/.env.example server/.env
# 编辑 server/.env：设置 SANDBOX_SERVER_URL、SANDBOX_STATE_DIR，并固定 SANDBOX_AGENT_IMAGE tag 或 digest。
docker compose --env-file server/.env \
  -f docker-compose.yml -f docker-compose.sandbox.yml up -d webchat
```

`server/.env` 是 Server 容器和 Compose 插值的统一配置源，因此每次运行 Sandbox override 都必须传 `--env-file server/.env`。`docker-compose.sandbox.yml` 会把 `/var/run/docker.sock` 和 `SANDBOX_STATE_DIR` 挂进 Server 容器。Docker socket 等价于宿主机 root 权限，只能授予可信 Server；不要把它加入默认部署。状态目录必须在 Host 与 Server 容器内使用相同绝对路径，因为子容器的 bind source 由 Host Docker daemon 解析。

每个用户只映射到一个固定名称的容器，Server 使用认证用户 ID 派生名称，用户不能指定或操作其他用户的容器。容器使用独立的 Yeaft 数据卷和 workspace 卷，并采用 `unless-stopped` restart policy。

## 凭证边界

Server 从现有用户 Agent secret 生成 Host 端 `0600` 文件。Docker 将其只读绑定到容器；root entrypoint 把内容复制为 UID 10001 可读的容器内 `0600` 临时文件，然后以非 root 用户运行 Agent。secret 不出现在 Docker argv、容器环境变量值或镜像层中。

`SANDBOX_STATE_DIR` 应位于仅 Server 服务账号和 root 可访问的持久目录。不要把它放入仓库、共享 workspace 或备份公开目录。

## 手动运行

同一套 JavaScript lifecycle manager 也由 Agent CLI 复用：

```bash
yeaft-agent container install \
  --server wss://your-yeaft-server.example \
  --name worker-1 \
  --secret <your-secret> \
  --image ghcr.io/yeaft/yeaft-web-code-agent-agent:dev

yeaft-agent container status --name worker-1
yeaft-agent container stop --name worker-1
yeaft-agent container start --name worker-1
yeaft-agent container logs --name worker-1
yeaft-agent container remove --name worker-1
```

secret 通过参数传递，与 `yeaft-agent install` 一致。CLI 会先把 secret 持久化为本机 `0600` 文件（`~/.yeaft/container-agents/<name>/agent-secret`），再创建容器；不再支持 `--secret-file <path>` 指定路径。`remove` 默认删除容器及其两个持久卷；传 `--keep-volumes` 可保留数据。手动容器和 Server 管理容器必须使用不同名称，避免生命周期所有权冲突。

## 资源限制（共享 cgroup slice）

容器默认**不限制** CPU/内存，单个容器可以吃满宿主资源。为防止失控容器拖垮机器，CLI 提供共享 cgroup slice 机制：所有 Yeaft 容器挂到同一个父 slice 下，**合计**消耗被宿主资源百分比封顶，而不是逐容器单独配额。

先以 root 初始化一次（动态按当前机器计算）：

```bash
sudo yeaft-agent container setup-limits
# 默认：CPU 上限 = 90% × 逻辑核数；内存硬上限 = 70% × 宿主内存（无 swap 逃逸）；pids 上限 = 4096
# 可覆盖：--cpu-percent 90 --memory-percent 70 --pids 4096
```

随后 `container install` 默认把容器挂到 `yeaft.slice`（`--cgroup-parent` 可指定其他 slice，`--no-slice` 显式放弃保护）：

```bash
yeaft-agent container install \
  --server wss://your-yeaft-server.example \
  --name worker-1 \
  --secret <your-secret>
```

语义：

- slice 的 `memory.max` 是包含所有后代的硬上限：容器合计超过 70% 宿主内存时，内核回收后仍超限则 OOM 杀死**容器内**进程（容器按 restart policy 重启），宿主内存始终安全。`memory.swap.max=0` 禁止容器借 swap 逃逸。
- slice 的 `cpu.max` 限制所有 Yeaft 容器合计最多 90% 逻辑核；单个容器可突发吃满 slice 配额，但不会挤占宿主其余 10% CPU。
- 未初始化 slice 时 `install` 会拒绝创建容器（防止"看似受保护、实际裸奔"），需要先跑 `setup-limits` 或显式 `--no-slice`。
- cgroup v2 无法限制磁盘容量。如需磁盘配额，`install` 支持 `--disk-size <size>`（如 `20G` 或 `80%`，按 Docker data-root 所在文件系统计算）；它给数据卷和 workspace 卷各设一个容量上限，要求 Docker overlay2 且 data-root 位于 xfs（project quota），不支持的文件系统会在 `docker create` 时失败。size 只在 volume **首次创建**时生效；volume 已存在时 Docker 会忽略该选项，因此复用旧卷重建（`remove --keep-volumes` + 重新 `install`）不会获得磁盘配额。

**已存在容器不受 slice 影响**：`--cgroup-parent` 是创建时参数，`docker update` 无法修改 cgroup 归属。要保护已部署的容器，用 `remove --keep-volumes` 保留数据卷后重新 `install`（卷名固定为 `<name>-data` / `<name>-workspace`，数据自动复用）。

Server 管理的 sandbox 容器同样支持：设置 `SANDBOX_CGROUP_PARENT=yeaft.slice` 后，Server 创建的所有用户容器都挂入共享 slice（宿主机需先跑过 `setup-limits`）。

## 发布与版本

Dev tag 发布 `ghcr.io/yeaft/yeaft-web-code-agent-agent:dev`。生产 release 同时发布版本 tag 与 `latest`。Docker build 的 `BUILD_VERSION` 会写入容器内 `agent/package.json`，因此以下命令应返回构建版本：

```bash
docker run --rm \
  --mount type=bind,src=$HOME/.yeaft/container-agents/worker-1/agent-secret,dst=/run/yeaft-host-secret,readonly \
  ghcr.io/yeaft/yeaft-web-code-agent-agent:<tag> --version
```

`agent-secret` 文件由 `container install` 自动创建；此处的 bind 仅演示容器内 secret 文件入口。

## 删除与旧数据兼容

删除账户前，Server 先删除该用户的 Docker Agent 和卷；Docker 删除失败时账户删除失败，不会留下失去所有者的容器。旧版本创建的 `sandboxes` 数据库行仅作为迁移兼容数据保留，账户最终删除事务会先清理这些旧行，避免旧 `ON DELETE RESTRICT` 外键阻塞用户删除。

## 故障排查

- `SANDBOX_DOCKER_UNAVAILABLE`：Docker CLI、daemon、socket 或 Server 服务账号权限不可用。
- `CONTAINER_AGENT_DOCKER_FAILED`：Docker 生命周期命令失败；检查 daemon 日志、镜像、Server URL 和状态目录权限。
- 容器 restart loop：运行 `docker logs yeaft-agent-<name>`，重点检查 secret 文件读取和 Server 连接错误。
- 删除失败：先解决 Docker daemon 或卷引用问题，再重试；不要直接删除用户数据库行。
