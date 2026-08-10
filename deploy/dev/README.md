# Yeaft dev 自动部署

`dev-release.yml` 在版本 tag 发布成功后推送两个兼容镜像标签：

- `ghcr.io/yeaft/yeaft-web-code-agent:dev`
- `ghcr.io/yeaft/claude-web-chat:dev`

本目录负责主机侧的 dev 蓝绿部署。它只支持 dev；生产发布不复用这套脚本。

## 为什么不是 Watchtower

dev 蓝绿服务故意不交给 Watchtower。Watchtower 会原地替换容器，无法保证 standby 健康、nginx 切换和连接 drain 的事务边界。这里使用 cron 每分钟执行一次部署器；没有新镜像时静默退出。

部署器比较 active 容器的 image ID 与拉取后 dev tag 的 image ID。即使上一轮已经 pull 成功、但 standby 启动或 nginx 切换失败，下一轮仍会继续重试。

## 安装

1. 将本目录复制或 checkout 到主机上的稳定路径。
2. 复制 `deployer.env.example` 为 `deployer.env`，填写主机路径和 Docker network。dev 默认设置 `BROWSER_RUNTIME_ENABLED=true`，只开放 Browser setup/viewer 协议；它不会把 Chrome 加入 Server/Agent 镜像，也不会触发下载。Chrome 仍由用户在所选 Agent 的 Workbench 中明确确认后按 instance 安装。可将该值设为 `false` 关闭整个 dev rollout。
3. 确认 nginx 已只读挂载 `UPSTREAM_FILE` 所在目录，且包含对应 upstream 配置。
4. 执行：

```bash
./install-cron.sh
```

先运行 `./deploy-blue-green.sh --check` 验证配置、Docker network、nginx 容器和 Compose 渲染。安装器获取固定的 `$HOME/.local/state/yeaft/dev-blue-green.lock` 后读取 crontab；除明确的“尚无 crontab”外，任何读取错误都会在首次写入前失败。安装器用同一套命令 token 规则确认并删除 `LEGACY_DEPLOY_COMMAND dev` scheduler，停用旧、新 scheduler，再等待 legacy 事务退出并保持静默。提交新 scheduler 或失败回滚前会重读并比较 disabled 快照；若其他进程并发修改了 crontab，安装器会保留外部修改而不是用旧快照覆盖。新 cron 会显式携带安装器预检过的绝对配置路径，不会退回另一份默认配置；配置与脚本路径可包含空格，但不能包含换行、`%` 或单引号。主机 secret 只存在 `WEBCHAT_ENV_FILE`，不得写入仓库。

## 安全边界

- 所有 Compose 调用都显式指定本目录的 `docker-compose.yaml` 和 project name。
- 使用不可配置、与 checkout 无关的 `$HOME/.local/state/yeaft/dev-blue-green.lock` + `flock` 原子排除重叠部署；安装交接也获取同一把锁。
- nginx upstream 通过同目录临时文件 + `mv` 原子替换。
- 只有 `nginx -t` 和 `nginx -s reload` 都成功后才停止旧容器。
- 切换失败时恢复旧 upstream 并再次验证 reload；若无法验证恢复，两侧容器都保持运行。
- nginx 已成功切换但 state 写入失败时，两侧容器同样保持运行；下一轮从 upstream 的 `# Active side` marker 恢复真实状态。
- `state/dev.log` 超过 `LOG_MAX_BYTES` 时保留一个 `.1` 文件；cron stdout/stderr 进入 syslog tag `yeaft-dev-deployer`，轮转由宿主 journald/syslog 管理。
- 失败会递增 `state/dev.failure` 并写入 syslog tag `yeaft-dev-deployer`；成功会清除连续失败状态。生产监控应对该 tag 或 failure 文件设置告警。

## 手工验证

```bash
bash -n deploy-blue-green.sh install-cron.sh
./deploy-blue-green.sh --check
./deploy-blue-green.sh --force
curl -fsS https://dev-cc.yeaft.com/api/auth/mode
```

不要在运行中的部署事务旁边执行 `--force`；`flock` 会阻止普通重叠，但手工验证仍应在维护窗口进行。
