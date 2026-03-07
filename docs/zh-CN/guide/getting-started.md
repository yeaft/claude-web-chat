# 快速开始

## 方式 A：npm 安装（仅 Agent）

如果你已经有一个运行中的服务器，只需安装 Agent：

```bash
# 全局安装 Agent
npm install -g @yeaft/webchat-agent

# 连接到服务器
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# 升级到最新版
yeaft-agent upgrade
```

## 方式 B：完整开发环境

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# 安装所有依赖
npm install

# 启动服务器 + Agent（开发模式，无需认证）
npm run dev
```

然后浏览器打开 `http://localhost:3456`

## 下一步

- [部署服务器 (Docker)](/zh-CN/guide/deploy-server) — 生产环境部署指南
- [安装 Agent](/zh-CN/guide/deploy-agent) — 连接工作机器
- [Chat 聊天](/zh-CN/guide/features-chat) — 开始使用聊天界面
- [Crew 多角色协作](/zh-CN/guide/features-crew) — 多 Agent 协作
