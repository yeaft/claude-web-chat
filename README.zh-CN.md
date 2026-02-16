# Claude Web Chat

[English](README.md) | [中文](README.zh-CN.md)

远程访问 [Claude Code](https://claude.ai/code) CLI 的 Web 界面，支持多台工作机器的统一管理。采用中心辐射架构：中央 WebSocket 服务器 + 分布式 Agent + Vue.js 前端。

## 前置要求

- **Server**: Node.js >= 18, Docker（推荐用于生产环境部署）
- **Agent**: Node.js >= 18, 需在工作机器上安装并认证 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- **Web 客户端**: 现代浏览器（Chrome, Firefox, Safari, Edge）

## 架构

```
┌──────────────────────────────────────────┐
│        Server  (@yeaft/webchat-server)   │
│         Express + WebSocket Hub          │
│   - Agent / Web 客户端管理               │
│   - 多层认证（密码 + TOTP + 邮箱）      │
│   - 端到端加密 (TweetNaCl)              │
│   - 消息路由与队列                       │
│   - SQLite 会话持久化                    │
└──────────────────┬───────────────────────┘
                   │ 加密 WebSocket
        ┌──────────┴──────────┐
        │                     │
┌───────▼───────┐      ┌──────▼──────────┐
│    Agent      │      │   Web 客户端    │
│ @yeaft/       │      │    (web/)       │
│ webchat-agent │      │                 │
│               │      │ - Vue 3 + Pinia │
│ - 管理 Claude │      │ - ChatGPT 风格  │
│   CLI 进程    │      │   三栏布局      │
│ - 终端 / Git  │      │ - 端到端加密    │
│ - 文件管理    │      │ - 文件上传      │
└───────────────┘      └─────────────────┘
```

## 快速开始

### 方式 A：npm 安装（仅 Agent）

```bash
# 全局安装 Agent
npm install -g @yeaft/webchat-agent

# 连接到服务器
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# 升级到最新版
yeaft-agent upgrade
```

### 方式 B：完整开发环境

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# 安装所有依赖
npm install

# 启动服务器 + Agent（开发模式，无需认证）
npm run dev
```

然后浏览器打开 `http://localhost:3456`

## 生产环境部署

### 服务器（Docker）

```bash
cd server
cp .env.example .env
```

编辑 `.env` 文件：

```env
PORT=3456

# 必须修改！使用随机字符串
JWT_SECRET=your-very-long-random-secret-key-here
AGENT_SECRET=your-agent-shared-secret-here

# 可选：邮箱验证
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=WebChat <noreply@example.com>

# 可选：TOTP 双因素认证
TOTP_ENABLED=true
```

Docker Compose 配置：

```yaml
services:
  webchat:
    build:
      context: .
      dockerfile: Dockerfile
    expose:
      - "3456"
    env_file:
      - server/.env
    environment:
      - NODE_ENV=production
      - SKIP_AUTH=false
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
# 启动服务器（首次运行会自动创建 data/ 目录和 SQLite 数据库）
docker-compose up -d --build webchat

# 创建第一个 admin 用户
docker exec webchat node server/create-user.js admin your-password admin@example.com
```

后续用户可通过邀请码注册（admin 在设置页面创建邀请码）。

### Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name cc.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://webchat:3456;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 长连接超时
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### 部署 Agent

**npm 安装**（推荐）：

```bash
npm install -g @yeaft/webchat-agent

# 前台运行
yeaft-agent --server wss://your-server.com --name worker-1 --secret your-secret

# 或安装为系统服务（开机自启、崩溃自重启）
yeaft-agent install --server wss://your-server.com --name worker-1 --secret your-secret

# 管理已安装的服务
yeaft-agent status                 # 查看运行状态
yeaft-agent logs                   # 查看日志（跟踪模式）
yeaft-agent restart                # 重启
yeaft-agent uninstall              # 卸载服务
```

**从源码运行**（开发环境或不使用 npm 全局安装）：

```bash
cd agent
cp .env.example .env
# 编辑 .env — 设置 SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR

# 前台运行
node index.js

# 或安装为系统服务（自动读取 .env 配置）
node cli.js install

# 管理已安装的服务
node cli.js status
node cli.js logs
node cli.js uninstall
```

### Agent CLI 命令

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

选项：
  --server <url>      WebSocket 服务器地址
  --name <name>       Agent 显示名称
  --secret <secret>   认证密钥
  --work-dir <dir>    默认工作目录
  --auto-upgrade      启动时检查更新

环境变量（替代命令行参数）：
  SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR
```

## 功能特性

- **多 Agent 管理**：同时连接多台工作机器
- **会话持久化**：SQLite 存储会话历史，支持 `--resume` 恢复
- **实时工具追踪**：可视化显示 Read、Edit、Bash 等操作
- **工作台**：集成终端 (xterm.js)、Git 状态/差异、文件浏览器 + CodeMirror 编辑器
- **端口代理**：将 Agent 本地端口通过服务器转发到浏览器
- **文件上传**：拖放上传文件和图片
- **交互式问答**：Claude 的 AskUserQuestion 渲染为交互式卡片
- **角色权限**：`admin`、`pro`、`user` 三级权限，服务端强制校验
- **端到端加密**：TweetNaCl secretbox (XSalsa20-Poly1305)
- **自动升级**：`yeaft-agent upgrade` 自更新 + 服务端推送升级通知
- **移动端适配**：响应式三栏布局

## 安全

### 认证流程

1. **用户名 + 密码**（bcrypt 哈希）
2. **TOTP 双因素认证**（可选，支持 Google/Microsoft Authenticator）
3. **邮箱验证码**（可选，需配置 SMTP）

### 生产模式要求

服务器在生产模式（`SKIP_AUTH=false`）下会检查：
- `JWT_SECRET` 必须修改为非默认值

如果未配置用户，服务器会启动但输出警告 — 通过 `docker exec` 创建首个用户即可。

### Agent 认证

- Agent 通过 WebSocket 消息认证（密钥不在 URL 中传输）
- **用户级 Agent 密钥**：Agent 绑定到特定用户，仅该用户可见
- **全局 AGENT_SECRET**：环境变量方式，仅 admin 可见
- 每个连接生成独立会话密钥用于加密

### 角色与权限

| 功能 | `user` | `pro` | `admin` |
|---|:---:|:---:|:---:|
| 聊天 | ✓ | ✓ | ✓ |
| 自有 Agent（用户级密钥） | ✓ | ✓ | ✓ |
| 全局 Agent（AGENT_SECRET） | - | - | ✓ |
| 工作台（终端、Git、文件） | - | ✓ | ✓ |
| 端口代理 | - | ✓ | ✓ |
| 邀请码管理 | - | - | ✓ |

## 前端构建

前端资源在 Docker 构建时自动打包：

```bash
# 手动构建（开发测试用）
npm run build
```

构建输出：
- `web/dist/vendor.bundle.js` — 第三方库（Vue、Pinia、TweetNaCl 等）
- `web/dist/app.bundle.js` — 应用代码
- `web/dist/style.bundle.css` — 样式
- 所有文件同时生成 `.gz` 压缩版本

## 项目结构

```
claude-web-chat/
├── server/           # 中央 WebSocket 服务器
│   ├── index.js      # 入口
│   ├── ws-agent.js   # Agent 连接与消息处理
│   ├── ws-client.js  # Web 客户端连接与消息处理
│   ├── ws-utils.js   # 共享 WS 工具与权限校验
│   ├── api.js        # REST 接口（认证、会话、用户）
│   ├── proxy.js      # 端口代理转发
│   ├── database.js   # SQLite 存储
│   └── auth.js       # JWT + TOTP + 邮箱验证
├── agent/            # 工作机器 Agent
│   ├── cli.js        # CLI 入口（yeaft-agent 命令）
│   ├── index.js      # 启动与能力检测
│   ├── connection.js # WebSocket 连接与认证
│   ├── claude.js     # Claude CLI 进程管理
│   ├── conversation.js # 会话生命周期
│   ├── terminal.js   # PTY 终端 (node-pty)
│   ├── workbench.js  # Git + 文件操作
│   └── sdk/          # Claude CLI stream-json SDK
├── web/              # Vue 3 前端
│   ├── app.js        # Vue 应用入口
│   ├── build.js      # 生产构建脚本（esbuild）
│   ├── components/   # Vue 组件
│   ├── stores/       # Pinia 状态管理 + helpers
│   └── vendor/       # 第三方库（本地加载，无 CDN）
├── Dockerfile        # 多阶段生产构建
└── LICENSE           # MIT
```

## 技术栈

- **Server**: Node.js, Express, ws, better-sqlite3, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Deploy**: Docker 多阶段构建

## CI/CD

内置 GitHub Actions 工作流：

- **CI** (`ci.yml`): 每次 push/PR 在 Node 18/20/22 上运行测试 + 构建前端
- **Release** (`release.yml`): 推送 `v*` tag 时自动发布 npm 包 + Docker 镜像 + GitHub Release

### 发布新版本

```bash
git tag v1.0.0
git push origin v1.0.0
# GitHub Actions 自动完成后续工作
```

## 常见问题

### Agent 连接失败 "Invalid agent secret"

确保 Agent 的 `AGENT_SECRET`（或 `--secret` 参数）与服务器 `.env` 中配置一致。

### 服务器启动失败 "SECURITY CONFIGURATION ERROR"

生产模式下必须修改默认 JWT 密钥：
```env
JWT_SECRET=随机字符串（至少32位）
```

可用命令生成：`openssl rand -base64 32`

### Docker 部署后 502 Bad Gateway

1. 检查容器是否运行：`docker-compose logs webchat`
2. 刷新 nginx DNS 缓存：`docker exec nginx nginx -s reload`

### SQLite 只读错误 (SQLITE_READONLY)

确保数据目录权限正确：
```bash
sudo chown -R root:root ./data
```

### TOTP 设置后无法登录

TOTP 码有时间窗口限制（默认 ±30 秒），确保服务器和手机时间同步。

### Agent 自动升级

```bash
# 手动升级
yeaft-agent upgrade

# 启动时自动检查
yeaft-agent --auto-upgrade --server wss://...
```

服务器也可通过设置 `AGENT_LATEST_VERSION` 环境变量，在 Agent 连接时推送升级通知。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建和贡献规范。

## License

[MIT](LICENSE)
