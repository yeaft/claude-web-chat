# Browser TURN Relay

Yeaft Browser 的 Agent 本地探测只验证 Chrome、tab capture、VP8 和本机 WebRTC。Web Viewer 与远程 Agent 之间仍需要可达的 ICE 路径。跨 NAT 或受限网络部署应配置 TURN；仅下载 Chrome 不会自动创建网络 relay。

此目录提供独立于 Server 蓝绿发布的 coturn 服务。它使用固定版本和 manifest digest 的镜像、host network、TURN REST API 短期凭证、私网 peer 拒绝、allocation/带宽上限、只读根文件系统和健康检查。它不提供 TLS；模板同时开放 `turn:` UDP/TCP 3478。需要 `turns:` 443 时应使用独立 IP/主机和证书，不能与现有 HTTPS nginx 抢占同一地址端口。

## 1. 准备 DNS、网络和 secret

1. 将 TURN 域名的 A 记录指向 TURN 主机公网 IPv4。
2. 在云安全组和主机防火墙开放：
   - `3478/udp` 和 `3478/tcp`；
   - `49160-49200/udp` relay 端口范围。
3. 为 TURN 选择一个专用宿主 GID（示例为 `10001`），生成只包含 hex 的共享 secret，并只授权 root 与该组读取：

```bash
install -d -o root -g 10001 -m 750 /etc/yeaft
openssl rand -hex 32 | install -o root -g 10001 -m 640 /dev/stdin /etc/yeaft/browser-turn.secret
```

将 `.env` 的 `BROWSER_TURN_SECRET_GID` 设为该数字 GID。Compose 只把这个组作为 supplementary group 加给固定的非 root UID/GID `10001:10001`；服务和 Docker healthcheck 都以该用户、空 capability sets 和 `no-new-privileges` 运行。同一 secret 必须配置给 coturn 和 Yeaft Server。不要提交 secret，不要把它写入命令行参数。

## 2. 启动 TURN

```bash
cd deploy/browser-turn
cp .env.example .env
# 编辑公网 IPv4、主机 relay IPv4、realm、secret 绝对路径和 secret 文件 GID
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=100 browser-turn
```

`network_mode: host` 是有意选择：TURN 需要保持 relay UDP 端口的一一映射，Docker 大范围端口代理会增加开销并容易破坏外部地址映射。`BROWSER_TURN_RELAY_IP` 填 TURN 主机实际绑定的 IPv4；主机在 NAT 后时，`BROWSER_TURN_EXTERNAL_IP` 填公网 IPv4。

## 3. 配置 Yeaft Server

在 Server 的 secret 环境文件中加入以下值；`BROWSER_TURN_SECRET` 内容必须与 secret 文件完全一致：

```dotenv
BROWSER_RUNTIME_ENABLED=true
BROWSER_STUN_URLS=stun:turn.example.com:3478
BROWSER_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
BROWSER_TURN_SECRET=<browser-turn.secret 的单行内容>
BROWSER_ICE_TRANSPORT_POLICY=relay
```

然后按部署流程重启或滚动替换 Server。Server 只在每次 owner-scoped peer attach 时签发短期 HMAC credential；Web 和 Agent 得到不同 username，shared secret 不下发给客户端。

## 4. 验证

提交或发布模板改动前，在仓库根目录运行 `npm run smoke:browser-turn`。该 smoke 会构建固定 digest 的派生镜像，在隔离端口启动临时 coturn，验证 REST-authenticated allocation、服务与 Docker healthcheck 自身的 UID/GID 和全部 capability sets，以及 secret 不进入容器配置，然后自动清理。

- `docker compose --env-file .env ps` 必须显示 `healthy`。
- 从 Web 浏览器和 Agent 所在网络分别确认 TURN 域名的 `3478/tcp` 可达；UDP 和 relay range 还必须在云安全组/防火墙开放。
- 打开 Workbench → Browser。连接成功后状态显示 `WebRTC`。
- 若 UI 显示 ICE/TURN 连通性错误，检查 coturn 日志、Server 的 `BROWSER_TURN_*` 值和公网/relay IP 映射。反复点击“重试”不能修复缺失的 TURN 配置。
