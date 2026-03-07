# 架构

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

## CI/CD

内置 GitHub Actions 工作流：

- **CI** (`ci.yml`): 每次 push/PR 在 Node 18/20/22 上运行测试 + 构建前端
- **Release** (`release.yml`): 推送 `v*` tag 时自动发布 npm 包 + Docker 镜像 + GitHub Release
