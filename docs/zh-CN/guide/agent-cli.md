# Agent CLI 命令参考

```
yeaft-agent [选项]                  前台运行
yeaft-agent install [选项]          安装为系统服务 (Linux/macOS/Windows)
yeaft-agent uninstall               卸载系统服务
yeaft-agent start                   启动服务
yeaft-agent stop                    停止服务
yeaft-agent restart                 重启服务
yeaft-agent status                  查看服务状态
yeaft-agent logs                    查看服务日志
yeaft-agent upgrade                 升级到最新版本
yeaft-agent --version               显示版本号
```

## 选项

| 参数 | 说明 |
|---|---|
| `--server <url>` | WebSocket 服务器地址 |
| `--name <name>` | Agent 显示名称 |
| `--secret <secret>` | 认证密钥 |
| `--work-dir <dir>` | 默认工作目录 |
| `--auto-upgrade` | 启动时检查更新 |

## 环境变量

作为命令行参数的替代：

| 变量 | 对应参数 |
|---|---|
| `SERVER_URL` | `--server` |
| `AGENT_NAME` | `--name` |
| `AGENT_SECRET` | `--secret` |
| `WORK_DIR` | `--work-dir` |

## 自动升级

```bash
# 手动升级
yeaft-agent upgrade

# 启动时自动检查
yeaft-agent --auto-upgrade --server wss://...
```

服务器也可通过设置 `AGENT_LATEST_VERSION` 环境变量，在 Agent 连接时推送升级通知。
