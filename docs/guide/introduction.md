# What is Claude Web Chat?

Claude Web Chat is a web interface for remotely accessing [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — providing multi-machine management, end-to-end encryption, and multi-role collaboration.

![Screenshot](/images/hero.jpg)

## Key Features

### Chat

ChatGPT-style conversational interface with real-time tool tracking, session management, and file uploads.

- Real-time streaming of Claude responses
- Visual display of Read, Edit, Bash, and other tool executions
- Slash commands (`/model`, `/memory`, `/skills`, etc.) with autocomplete
- Session persistence with SQLite-backed history
- Drag-and-drop file/image attachments
- Mobile-responsive layout

![Chat](/images/chat.jpg)

### Expert Panel

AI expert teams that assist your conversations — select a team (e.g. Writing, Trading) and get multi-perspective advice in a side panel.

- Multiple pre-built expert teams with specialized roles
- Expert responses appear in a collapsible side panel
- Team selection via chip-style tabs
- Works alongside normal chat without interrupting the flow

### Crew (Multi-Agent Collaboration)

Multi-role AI team collaboration with PM, Developer, Reviewer, and Tester roles working together on features.

- Automated task routing between roles via ROUTE protocol
- Feature progress tracking panel with real-time status (streaming pulse animation)
- Role-based message grouping with decision-maker messages in main stream
- Parallel multi-agent execution across multiple worktrees
- Feature completion detection with auto-reactivation on new activity

![Crew Features](/images/crew-features.jpg)

![Crew Feature Detail](/images/crew-feature-detail.jpg)

### Workbench

Integrated development environment with terminal, Git operations, file browser, and port proxy.

- Full terminal emulator (xterm.js) with PTY support
- Git status, diff viewer, and branch management
- File browser with CodeMirror editor
- Port proxy: forward agent local ports to your browser

![Workbench](/images/workbench.jpg)

### Admin Dashboard

Usage statistics and system monitoring for administrators.

- User activity metrics with time-based filtering (today/week/month)
- Per-user usage breakdown (messages, sessions, requests, traffic)
- Connected agent status and latency monitoring
- Mobile-responsive card layout

![Dashboard](/images/dashboard.jpg)

## Prerequisites

- **Server**: Node.js >= 18, Docker (recommended for production)
- **Agent**: Node.js >= 18, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- **Web Client**: Modern browser (Chrome, Firefox, Safari, Edge)

## Tech Stack

- **Server**: Node.js, Express, ws, better-sqlite3, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild (frontend bundling)
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Deploy**: Docker multi-stage build
