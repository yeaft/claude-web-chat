# Agent 安装

## npm 安装（推荐）

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

## 从源码运行

开发环境或不使用 npm 全局安装：

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

## 查找 Agent Secret

Agent Secret 可在 Web 界面的 **设置 > 安全** 中找到：

![设置 Agent](/images/setup-agent.png)

当没有 Agent 连接时，首页会引导你前往设置页面：

![无 Agent](/images/no-agent.png)
