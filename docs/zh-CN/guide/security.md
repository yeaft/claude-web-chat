# 安全

## 认证流程

1. **用户名 + 密码**（bcrypt 哈希）
2. **TOTP 双因素认证**（可选，支持 Google/Microsoft Authenticator）
3. **邮箱验证码**（可选，需配置 SMTP）

## 生产模式要求

服务器在生产模式（`SKIP_AUTH=false`）下会检查：
- `JWT_SECRET` 必须修改为非默认值

如果未配置用户，服务器会启动但输出警告 — 通过 `docker compose exec` 创建首个用户即可。

## Agent 认证

- Agent 通过 WebSocket 消息认证（密钥不在 URL 中传输）
- **用户级 Agent 密钥**：Agent 绑定到特定用户，仅该用户可见
- **全局 AGENT_SECRET**：环境变量方式，仅 admin 可见
- 每个连接生成独立会话密钥用于加密

## 角色与权限

所有注册用户默认为 **Pro** 角色。通过 CLI 创建的第一个用户为 **Admin**。

| 功能 | `pro` | `admin` |
|---|:---:|:---:|
| 聊天 | ✓ | ✓ |
| 自有 Agent（用户级密钥） | ✓ | ✓ |
| 全局 Agent（AGENT_SECRET） | - | ✓ |
| 工作台（终端、Git、文件） | ✓ | ✓ |
| 端口代理 | ✓ | ✓ |
| 邀请码管理 | - | ✓ |
