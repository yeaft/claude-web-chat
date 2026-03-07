# 常见问题

## Agent 连接失败 "Invalid agent secret"

确保 Agent 的 `AGENT_SECRET`（或 `--secret` 参数）与服务器 `.env` 中配置一致。

## 服务器启动失败 "SECURITY CONFIGURATION ERROR"

生产模式下必须修改默认 JWT 密钥：

```ini
JWT_SECRET=随机字符串（至少32位）
```

可用命令生成：`openssl rand -base64 32`

## Docker 部署后 502 Bad Gateway

1. 检查容器是否运行：`docker compose logs webchat`
2. 刷新 nginx DNS 缓存：`docker exec nginx nginx -s reload`

## SQLite 只读错误 (SQLITE_READONLY)

确保数据目录权限正确：

```bash
sudo chown -R root:root ./data
```

## TOTP 设置后无法登录

TOTP 码有时间窗口限制（默认 ±30 秒），确保服务器和手机时间同步。
