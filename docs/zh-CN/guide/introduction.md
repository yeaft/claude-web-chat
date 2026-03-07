# 什么是 Claude Web Chat？

Claude Web Chat 是一个用于远程访问 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 的 Web 界面 — 提供多机器管理、端到端加密和多角色协作。

![Screenshot](/images/hero.png)

## 核心功能

### Chat 聊天

ChatGPT 风格对话界面，实时工具追踪，会话管理和文件上传。

- Claude 响应实时流式输出
- 可视化显示 Read、Edit、Bash 等工具操作
- SQLite 会话持久化，支持历史恢复
- 拖放上传文件和图片
- 移动端响应式布局

![Chat](/images/chat.png)

### Crew（多角色协作）

多角色 AI 团队协作，PM、开发者、审查者、测试者等角色协同完成 Feature 开发。

- 角色间自动任务路由
- Feature 进度追踪与看板视图
- 按角色分组的消息展示与状态指示
- 多 Agent 并行执行

![Crew](/images/crew.png)

### Workbench（工作台）

集成开发环境：终端、Git 操作、文件浏览器和端口代理。

- 全功能终端模拟器 (xterm.js)，支持 PTY
- Git 状态查看、差异对比、分支管理
- 文件浏览器 + CodeMirror 代码编辑器
- 端口代理：将 Agent 本地端口转发到浏览器

![Workbench](/images/workbench.png)

## 前置要求

- **Server**: Node.js >= 18, Docker（推荐用于生产环境部署）
- **Agent**: Node.js >= 18, 需在工作机器上安装并认证 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- **Web 客户端**: 现代浏览器（Chrome, Firefox, Safari, Edge）

## 技术栈

- **Server**: Node.js, Express, ws, better-sqlite3, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Deploy**: Docker 多阶段构建
