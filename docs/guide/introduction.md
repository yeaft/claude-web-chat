# What is Claude Web Chat?

Claude Web Chat is a web interface for remotely accessing [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — providing multi-machine management, end-to-end encryption, and multi-role collaboration.

![Screenshot](/images/hero.png)

## Key Features

### Chat

ChatGPT-style conversational interface with real-time tool tracking, session management, and file uploads.

- Real-time streaming of Claude responses
- Visual display of Read, Edit, Bash, and other tool executions
- Session persistence with SQLite-backed history
- Drag-and-drop file/image attachments
- Mobile-responsive layout

![Chat](/images/chat.png)

### Crew (Multi-Agent Collaboration)

Multi-role AI team collaboration with PM, Developer, Reviewer, and Tester roles working together on features.

- Automated task routing between roles
- Feature progress tracking with Kanban board
- Role-based message grouping and status indicators
- Parallel multi-agent execution

![Crew](/images/crew.png)

### Workbench

Integrated development environment with terminal, Git operations, file browser, and port proxy.

- Full terminal emulator (xterm.js) with PTY support
- Git status, diff viewer, and branch management
- File browser with CodeMirror editor
- Port proxy: forward agent local ports to your browser

![Workbench](/images/workbench.png)

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
