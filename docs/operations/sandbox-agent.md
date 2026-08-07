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
yeaft-agent container create \
  --server wss://your-yeaft-server.example \
  --name worker-1 \
  --secret-file /secure/path/agent-secret \
  --image ghcr.io/yeaft/yeaft-web-code-agent-agent:dev

yeaft-agent container status --name worker-1
yeaft-agent container stop --name worker-1
yeaft-agent container start --name worker-1
yeaft-agent container logs --name worker-1
yeaft-agent container remove --name worker-1
```

`remove` 默认删除容器及其两个持久卷；传 `--keep-volumes` 可保留数据。手动容器和 Server 管理容器必须使用不同名称，避免生命周期所有权冲突。

## 发布与版本

Dev tag 发布 `ghcr.io/yeaft/yeaft-web-code-agent-agent:dev`。生产 release 同时发布版本 tag 与 `latest`。Docker build 的 `BUILD_VERSION` 会写入容器内 `agent/package.json`，因此以下命令应返回构建版本：

```bash
docker run --rm \
  --mount type=bind,src=/secure/path/agent-secret,dst=/run/yeaft-host-secret,readonly \
  ghcr.io/yeaft/yeaft-web-code-agent-agent:<tag> --version
```

## 删除与旧数据兼容

删除账户前，Server 先删除该用户的 Docker Agent 和卷；Docker 删除失败时账户删除失败，不会留下失去所有者的容器。旧版本创建的 `sandboxes` 数据库行仅作为迁移兼容数据保留，账户最终删除事务会先清理这些旧行，避免旧 `ON DELETE RESTRICT` 外键阻塞用户删除。

## 故障排查

- `SANDBOX_DOCKER_UNAVAILABLE`：Docker CLI、daemon、socket 或 Server 服务账号权限不可用。
- `CONTAINER_AGENT_DOCKER_FAILED`：Docker 生命周期命令失败；检查 daemon 日志、镜像、Server URL 和状态目录权限。
- 容器 restart loop：运行 `docker logs yeaft-agent-<name>`，重点检查 secret 文件读取和 Server 连接错误。
- 删除失败：先解决 Docker daemon 或卷引用问题，再重试；不要直接删除用户数据库行。
