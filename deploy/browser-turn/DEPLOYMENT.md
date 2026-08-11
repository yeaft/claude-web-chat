# Browser TURN 完整部署流程

本文是 `deploy/browser-turn/` 的主机部署 runbook。它覆盖单机 NAT 场景：Yeaft Server 与 coturn 可位于同一主机，coturn 使用 host network，公网 IPv4 映射到主机私网 IPv4，Yeaft Server 通过现有发布流程滚动替换。

本文中的域名、地址、路径和 project name 都是示例。不要把真实 secret 写进仓库、终端历史、工单、日志或命令行参数。

## 1. 先理解 secret

`BROWSER_TURN_SECRET` 是 **Yeaft Server 与 coturn 共享的 HMAC 密钥**：

1. Yeaft Server 用它为每次 Browser peer attach 派生短期 TURN username/password；
2. coturn 用同一密钥验证短期凭证；
3. Web 和 Agent 只得到有 TTL 的派生凭证，不得到 shared secret；
4. 它不是用户密码、Agent secret、JWT secret 或 TLS private key。

两端内容必须逐字节一致。默认凭证 TTL 是 600 秒，可用 `BROWSER_TURN_TTL_SECONDS` 调整到 60–3600 秒。

## 2. 部署前信息和变更窗口

先准备以下值：

| 变量 | 含义 | 示例 |
| --- | --- | --- |
| `TURN_HOST` | TURN 公网 DNS 名称 | `turn.example.com` |
| `TURN_EXTERNAL_IP` | DNS 指向的公网 IPv4 | `203.0.113.10` |
| `TURN_RELAY_IP` | TURN 主机网卡实际绑定的私网或公网 IPv4 | `10.0.0.10` |
| `TURN_DEPLOY_DIR` | 主机稳定部署目录，不要使用临时 worktree | `/opt/yeaft/browser-turn` |
| `TURN_SECRET_FILE` | shared secret 文件 | `/etc/yeaft/browser-turn.secret` |
| `TURN_SECRET_GID` | 只用于读取 secret 的宿主 numeric GID | `10001` |
| `SERVER_ENV_FILE` | Yeaft Server 的 secret env 文件 | 由实际部署决定 |

部署前检查：

```bash
getent ahostsv4 "$TURN_HOST"
ip -4 -brief address
ss -lntup | grep -E ':(3478)\b' || true
docker version
docker compose version
```

要求：

- `TURN_HOST` 的 A 记录精确指向 `TURN_EXTERNAL_IP`；
- `TURN_RELAY_IP` 必须是主机实际绑定地址，不能填 Docker bridge 地址；
- `3478/tcp`、`3478/udp` 和 `49160-49200/udp` 没有被其他服务占用；
- 已确认 Yeaft Server 的 env 文件、发布命令、健康检查 URL 和回滚方法；
- 为首次部署或密钥轮换安排维护窗口。重启 coturn 会终止已有 allocation。

如果主机已有临时 smoke coturn，先识别它的 Compose project 和端口。不要仅按镜像名删除未知容器。

## 3. DNS、防火墙和云安全组

创建或确认：

```text
turn.example.com. A 203.0.113.10
```

入站规则必须同时允许：

```text
3478/TCP
3478/UDP
49160-49200/UDP
```

`3478` 只建立 TURN/STUN 控制路径。媒体 relay 使用 `49160-49200/udp`；只验证 `3478` 不能证明远程 Browser Viewer 可用。

规则要在两层检查：

1. 云侧 NSG/security group/firewall；
2. 主机侧 nftables/iptables/ufw/firewalld。

若当前账号无权读取云规则，必须把它记录为未验证项并由有权限的管理员确认。不能因为本机 hairpin NAT 测试成功就声称公网客户端一定可达。

## 4. 安装稳定部署文件

从已发布或已审查的 checkout 复制模板到稳定目录。不要让长期服务依赖 `/tmp` 或会被删除的 Git worktree。

```bash
TURN_DEPLOY_DIR=/opt/yeaft/browser-turn
SOURCE_DIR=/path/to/yeaft-web-code-agent/deploy/browser-turn

sudo install -d -o root -g root -m 0755 "$TURN_DEPLOY_DIR"
for file in Dockerfile docker-compose.yaml start-turn.sh healthcheck.sh; do
  sudo install -o root -g root -m 0644 \
    "$SOURCE_DIR/$file" "$TURN_DEPLOY_DIR/$file"
done
sudo chmod 0555 \
  "$TURN_DEPLOY_DIR/start-turn.sh" \
  "$TURN_DEPLOY_DIR/healthcheck.sh"
```

## 5. 生成 shared secret

首次部署只生成一次：

```bash
TURN_SECRET_FILE=/etc/yeaft/browser-turn.secret
TURN_SECRET_GID=10001

sudo install -d -o root -g "$TURN_SECRET_GID" -m 0750 /etc/yeaft
if ! sudo test -s "$TURN_SECRET_FILE"; then
  umask 077
  openssl rand -hex 32 \
    | sudo install -o root -g "$TURN_SECRET_GID" -m 0640 \
      /dev/stdin "$TURN_SECRET_FILE"
fi
sudo stat -c '%A %U:%G %s %n' "$TURN_SECRET_FILE"
```

期望文件是 64 个 hex 字符加换行，通常为 65 bytes。不要执行 `cat`、`echo` 或 `docker inspect` 后拼接输出 secret。需要比较两端时，在受控脚本内比较值或摘要，只输出 `match`/`mismatch`。

## 6. 创建 coturn 环境文件

在稳定目录创建 root-only `.env`：

```dotenv
BROWSER_TURN_CONTAINER=yeaft-browser-turn
BROWSER_TURN_EXTERNAL_IP=203.0.113.10
BROWSER_TURN_RELAY_IP=10.0.0.10
BROWSER_TURN_REALM=turn.example.com
BROWSER_TURN_SECRET_FILE=/etc/yeaft/browser-turn.secret
BROWSER_TURN_SECRET_GID=10001
BROWSER_TURN_LISTEN_PORT=3478
BROWSER_TURN_MIN_PORT=49160
BROWSER_TURN_MAX_PORT=49200
BROWSER_TURN_USER_QUOTA=8
BROWSER_TURN_TOTAL_QUOTA=128
BROWSER_TURN_MAX_BPS=8000000
BROWSER_TURN_BPS_CAPACITY=64000000
```

```bash
sudo chown root:root "$TURN_DEPLOY_DIR/.env"
sudo chmod 0600 "$TURN_DEPLOY_DIR/.env"
```

`BROWSER_TURN_EXTERNAL_IP` 是对外公布的地址，`BROWSER_TURN_RELAY_IP` 是本机 socket 绑定地址。NAT 主机通常两者不同。

## 7. 校验并启动 coturn

所有 Compose 调用显式指定固定 project name，避免误操作同目录或同主机上的其他服务：

```bash
cd "$TURN_DEPLOY_DIR"
sudo docker compose \
  --project-name yeaft-browser-turn \
  --env-file .env \
  config --quiet
sudo docker compose \
  --project-name yeaft-browser-turn \
  --env-file .env \
  up -d --build
sudo docker compose \
  --project-name yeaft-browser-turn \
  --env-file .env \
  ps
```

等待 `healthy`，然后检查：

```bash
docker inspect yeaft-browser-turn --format \
  'status={{.State.Status}} health={{.State.Health.Status}} user={{.Config.User}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}} restart={{.HostConfig.RestartPolicy.Name}}'
sudo ss -lntup | grep -E ':(3478)\b'
docker logs --tail 100 yeaft-browser-turn
```

期望：

- 容器 `running`、`healthy`、`restart=unless-stopped`；
- 用户为 `10001:10001`；
- `network=host`、root filesystem 只读；
- TCP/UDP `3478` 都在监听；
- 启动日志没有地址绑定、secret 读取或配置解析错误。

## 8. 配置 Yeaft Server

在 Server 的 **secret env 文件**中原子更新以下键，不要修改仓库内的 `.env.example`：

```dotenv
BROWSER_RUNTIME_ENABLED=true
BROWSER_STUN_URLS=stun:turn.example.com:3478
BROWSER_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
BROWSER_TURN_SECRET=<与 browser-turn.secret 完全一致的单行值>
BROWSER_TURN_TTL_SECONDS=600
BROWSER_ICE_TRANSPORT_POLICY=relay
```

推荐流程：

1. 以保留权限的方式备份现有 env；
2. 在同目录临时文件中删除旧 `BROWSER_*` 键并写入新值；
3. 将临时文件权限设为 `0600`；
4. 用同文件系统上的原子 `mv` 替换；
5. 运行部署器的配置检查；
6. 用现有蓝绿/滚动发布流程替换 Server；
7. 只有 standby 健康且入口代理成功切换后才停止旧实例。

不要用 `docker restart` 绕过现有发布事务，也不要把 secret 作为 `docker run` 命令行参数。Server 进程必须重新创建或重启才会读取新环境变量。

强制 `relay` 会禁止 direct ICE candidate，适合要求所有媒体经过 TURN 的部署。若希望 TURN 只做 direct ICE 失败后的 fallback，使用 `BROWSER_ICE_TRANSPORT_POLICY=all`。

## 9. 分层验证

### 9.1 容器和 Server 配置

检查 Server 容器只显示 key 是否存在，不输出 secret：

```bash
docker inspect <active-server-container> --format \
  '{{range .Config.Env}}{{println .}}{{end}}' \
  | awk -F= '/^BROWSER_/{print $1"=<configured>"}' \
  | sort
```

检查 Yeaft HTTPS 入口和应用健康端点。健康端点因部署而异；不要把任意 `404` 当作健康。

### 9.2 secret 一致性

以下示例只输出比较结果，并去掉 secret 文件末尾换行：

```bash
secret=$(sudo cat "$TURN_SECRET_FILE" | tr -d '\r\n')
env_secret=$(sudo awk -F= '
  /^BROWSER_TURN_SECRET=/{sub(/^[^=]*=/, ""); print; exit}
' "$SERVER_ENV_FILE")
if [ -n "$secret" ] && [ "$secret" = "$env_secret" ]; then
  unset secret env_secret
  printf '%s\n' 'Yeaft and coturn secrets match.'
else
  unset secret env_secret
  printf '%s\n' 'Yeaft and coturn secrets do not match.' >&2
  exit 1
fi
```

### 9.3 TURN REST 正负向鉴权

仓库 smoke 验证固定镜像、错误 secret 被拒绝、正确 secret 可 allocation，以及 UID/capability/secret isolation：

```bash
npm run smoke:browser-turn
```

不要在生产主机调用 `turnutils_uclient -W "$secret"`。即使关闭 shell tracing，shell 展开后的长期 shared secret 仍会进入 host 或 container process argv。生产实例应通过 Yeaft 的真实 owner-scoped Browser attach 签发短期凭证并完成 authenticated allocation；验证时只观察 coturn 的成功/拒绝结果，不记录完整派生 username/password。错误 secret 的负向合同由隔离的仓库 smoke 使用非生产 secret 验证。

### 9.4 公网协议和 relay

至少从 **TURN 主机之外** 的两类网络验证：

1. Web 浏览器所在网络；
2. Agent 所在网络。

验证项：

- DNS 解析正确；
- `3478/tcp` 可连接；
- `3478/udp` 收到 STUN response；
- authenticated TURN allocation 成功；
- allocation 获得的 relay candidate 能实际传输 UDP 媒体。

最后打开 Workbench → Browser，建立远程 Viewer，确认状态显示 `WebRTC`，视频持续传输，并在 coturn 日志中观察到对应 allocation。单纯在 TURN 主机上访问它自己的公网 IP 只验证 NAT hairpin 路径，不替代外部客户端验证。

### 9.5 进程安全边界

```bash
container_pid=$(docker inspect -f '{{.State.Pid}}' yeaft-browser-turn)
sudo grep -E \
  '^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):' \
  "/proc/$container_pid/status"
```

期望 UID/GID 为 `10001`、所有 capability sets 为零、`NoNewPrivs: 1`。同时确认 secret 不出现在容器可检查配置中：

```bash
docker inspect yeaft-browser-turn > /tmp/turn-inspect.json
# 在不打印匹配内容的脚本中检查文件不包含 secret，然后删除临时文件。
rm -f /tmp/turn-inspect.json
```

## 10. 故障排查

| 现象 | 优先检查 |
| --- | --- |
| coturn 无法启动 | secret 文件可读性、numeric GID、external/relay IP、端口占用 |
| STUN 成功但 Viewer 失败 | relay UDP range 的云/主机防火墙、external/relay IP 映射 |
| 日志提示找不到 credential | 两端 secret 不一致、Server 未重建、凭证过期、系统时钟偏差 |
| TCP 成功、UDP 失败 | `3478/udp` 安全组、防火墙或运营商网络 |
| Browser 显示 ICE/TURN 错误 | Server 下发 URL、Agent/Web 两侧可达性、coturn allocation 日志 |
| 强制 relay 后所有连接失败 | TURN URL/secret/relay range 任一未完成，不要用 UI 重试掩盖部署错误 |

检查日志时只取有界尾部，并对任何凭证字段做脱敏：

```bash
docker logs --tail 100 yeaft-browser-turn
```

## 11. 回滚

### 11.1 Server 配置回滚

恢复变更前备份的 `SERVER_ENV_FILE`，保持 `0600`，再走同一蓝绿/滚动流程。若只想临时恢复 direct ICE，可将 policy 改回 `all`；若完全移除 TURN，必须同时删除 `BROWSER_TURN_URLS` 和 `BROWSER_TURN_SECRET`，否则不要留下半配置状态。

### 11.2 coturn 回滚

若新 coturn 配置或镜像失败：

1. 恢复之前的稳定部署文件、`.env` 和 secret；
2. 运行 `docker compose ... config --quiet`；
3. `up -d --build` 重建；
4. 重新执行 REST 鉴权和外部 relay 验证。

若决定停用：

```bash
cd "$TURN_DEPLOY_DIR"
sudo docker compose \
  --project-name yeaft-browser-turn \
  --env-file .env \
  down
```

不要使用 `docker compose down -v`，也不要删除未知 project 的容器。确认 Server 已不再下发该 TURN URL 后再关闭网络规则和 DNS。

## 12. shared secret 轮换

当前模板只有一个 `static-auth-secret`，不支持无缝同时接受新旧两个 secret。轮换会使旧短期凭证失效，并且 coturn 重启会终止已有 allocation，因此必须在维护窗口执行：

1. 备份旧 secret 和 Server env，权限保持受限；
2. 生成新的 32-byte 随机 hex secret 到临时文件；
3. 原子替换 `TURN_SECRET_FILE`；
4. 立即重建 coturn；
5. 原子更新 Server env，并立即滚动替换 Server；
6. 验证两端一致、错误 secret 被拒绝、新 secret allocation 成功；
7. 从外部 Web/Agent 网络重新建立 Browser Viewer；
8. 验证完成后安全删除旧备份。

步骤 4–5 之间新旧凭证存在短暂不一致，必须尽量连续执行。失败时两端一起恢复旧 secret；只回滚一端会继续产生认证错误。

## 13. 完成标准

只有以下项目全部有证据时，部署才算完成：

- coturn `healthy`，重启策略和安全边界正确；
- Server 已加载全部 `BROWSER_*` 配置；
- 两端 shared secret 一致但未被输出；
- 错误 secret 被拒绝，正确 secret 可完成 allocation；
- 外部网络验证 `3478/tcp`、`3478/udp` 和 relay UDP 数据传输；
- 真实 Workbench Browser Viewer 显示 `WebRTC` 并持续传输；
- 云安全组和主机防火墙规则已由有权限的操作者确认；
- 回滚材料和部署证据已记录，记录中不含 secret。
