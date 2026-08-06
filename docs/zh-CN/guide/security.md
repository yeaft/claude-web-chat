# 安全

Yeaft 有三层彼此独立的凭证：

1. **Web 用户认证** —— 真人如何登录 Web UI。
2. **Agent 认证** —— Agent 如何证明自己可以连接，以及哪个 owner 可以使用它。
3. **原生 Yeaft provider credential** —— Agent 如何调用第三方 LLM API。

它们不共享 secret，也不会互相 fallback。

## Web 用户认证

- bcrypt password hash；
- 可选 TOTP；
- 配置 SMTP 后可选邮件验证；
- 后续 REST 与 WebSocket authorization 使用 JWT；
- 部署启用时可使用配置的 SSO provider。

Production startup 会拒绝默认 `JWT_SECRET`。如果尚无用户，Server 会告警，operator 必须创建第一个管理员。

## Agent 认证与所有权

- Agent 在 WebSocket message 中认证，secret 不放在 URL。
- 用户级 Agent secret 将 Agent 绑定给一个 owner，并对该用户优先生效。
- 全局 `AGENT_SECRET` 是 administrative fallback。
- Server 在中继 Browser request 或 Agent output 前执行 owner/access check。

Authentication 与 authorization 本身不提供 transport confidentiality；它们证明身份并限制路由。

## WebSocket transport confidentiality

当前 Web 和 Agent peer 会明确协商 **plaintext JSON WebSocket payload**：

- Web client 发送 `client_hello { plaintextOk: true }`；
- 当前 Agent 声明 `plaintext-ok` capability；
- Server 随后对这个 peer 关闭 per-frame TweetNaCl payload encryption。

因此 production deployment 必须在 Server 或可信 reverse proxy 终止 **HTTPS/WSS**。Plain `ws://` 只适用于 loopback 或已经受保护的可信 transport。

TweetNaCl XSalsa20-Poly1305 payload encryption 只作为 **legacy-peer compatibility fallback** 保留：旧 peer 未协商 plaintext 时才使用。它不是当前 Web + Server + Agent 组合的默认保密层。不要把当前 relay 描述为端到端加密：WSS endpoint 之后，Server 路由普通 plaintext JSON，并能读取 message body。

| 路径 | 当前 confidentiality boundary |
| --- | --- |
| Browser ↔ Server | Production 使用 HTTPS/WSS TLS；application payload 在该 transport 内是 plaintext JSON |
| Agent ↔ Server | Production 使用 WSS TLS；application payload 在该 transport 内是 plaintext JSON |
| Legacy peer fallback | Peer 未声明 plaintext capability 时使用 TweetNaCl per-frame payload encryption |
| Agent ↔ LLM provider | Provider HTTPS/TLS |

## 原生 Yeaft provider credential

原生 Yeaft 从 Agent 直接调用配置的 LLM provider。Config path 属于 Agent instance：

- default service instance：`~/.yeaft/config.json`；
- named instance `<name>`：默认 `~/.yeaft/instances/<name>/config.json`，除非通过 `YEAFT_DIR` / `--yeaft-dir` override。

Provider entry 使用以下两种 credential mode 之一：

| 模式 | 字段 | 行为 |
| --- | --- | --- |
| Static API key | `apiKey` | 保存在 instance config，重复用于 request |
| Dynamic credential | `credentialProvider: "github-copilot"` | 从本机 GitHub credential flow 获取短期 Copilot API credential |

安全后果：

- 静态 `apiKey` 以明文保存在 Agent 磁盘；限制文件权限，绝不能 commit config；
- dynamic provider token 留在进程内并按需 refresh；
- Server 不代理原生 LLM request，也不拥有 provider credential；
- raw provider trace、prompt、tool input/output、attachment、memory 和 project file 都是敏感 Agent 数据。

## 角色与权限

所有注册用户当前默认为 Pro；通过 CLI 创建的第一个用户是 Admin。

| 功能 | `pro` | `admin` |
| --- | :---: | :---: |
| Conversation 与自有 Agent | 是 | 是 |
| 全局 secret Agent | - | 是 |
| Workbench 与 port proxy | 是 | 是 |
| Invitation administration | - | 是 |
| Admin dashboard | - | 是 |

## Threat model：Yeaft 不防什么

- **Agent 机器被攻陷：** 有足够本机权限的攻击者可以读取 instance config、project file、memory、trace 和 process data。
- **恶意或被攻陷的 Server：** 当前 Server 可以在 TLS termination 后看到中继的 plaintext message body，也能提供被修改的 Web JavaScript。不要把它当成看不到正文的 encrypted relay。
- **缺少 TLS：** 公网 `ws://` 上的 authentication 不保护 message confidentiality，必须使用 WSS。
- **Browser 侧 compromise/XSS：** 被攻陷的 client 能读取该用户可见的一切内容。
- **不安全的 Agent tool：** Authentication 不会 sandbox shell、Git、file、provider 或 external side effect；tool/repository policy 仍是安全边界的一部分。
