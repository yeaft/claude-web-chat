# Claude Web Chat

![CI](https://github.com/yeaft/claude-web-chat/actions/workflows/ci.yml/badge.svg)
[![npm](https://img.shields.io/npm/v/@yeaft/webchat-agent)](https://www.npmjs.com/package/@yeaft/webchat-agent)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://ghcr.io/yeaft/claude-web-chat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)

[English](README.md) | [中文](README.zh-CN.md)

> A web interface for remotely accessing Claude Code CLI — multi-machine management, end-to-end encryption, multi-role collaboration

![Screenshot](docs/images/hero.png)

## Features

### Chat

ChatGPT-style conversational interface with real-time tool tracking, session management, and file uploads.

- Real-time streaming of Claude responses
- Visual display of Read, Edit, Bash, and other tool executions
- Session persistence with SQLite-backed history
- Drag-and-drop file/image attachments
- Mobile-responsive layout

![Chat](docs/images/chat.png)

### Crew (Multi-Agent Collaboration)

Multi-role AI team collaboration with PM, Developer, Reviewer, and Tester roles working together on features.

- Automated task routing between roles
- Feature progress tracking with Kanban board
- Role-based message grouping and status indicators
- Parallel multi-agent execution

![Crew](docs/images/crew.png)

### Workbench

Integrated development environment with terminal, Git operations, file browser, and port proxy.

- Full terminal emulator (xterm.js) with PTY support
- Git status, diff viewer, and branch management
- File browser with CodeMirror editor
- Port proxy: forward agent local ports to your browser

![Workbench](docs/images/workbench.png)

## Prerequisites

- **Server**: Node.js >= 18, Docker (recommended for production)
- **Agent**: Node.js >= 18, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- **Web Client**: Modern browser (Chrome, Firefox, Safari, Edge)

## Architecture

```
┌──────────────────────────────────────────┐
│          Server  (@yeaft/webchat-server)  │
│         Express + WebSocket Hub          │
│   - Agent/web client management          │
│   - Multi-layer authentication           │
│   - End-to-end encryption (TweetNaCl)    │
│   - Message routing & queue              │
│   - SQLite session persistence           │
└──────────────────┬───────────────────────┘
                   │ Encrypted WebSocket
        ┌──────────┴──────────┐
        │                     │
┌───────▼───────┐      ┌──────▼──────────┐
│    Agent      │      │   Web Client    │
│ @yeaft/       │      │    (web/)       │
│ webchat-agent │      │                 │
│               │      │ - Vue 3 + Pinia │
│ - Manages     │      │ - ChatGPT-style │
│   Claude CLI  │      │   3-column UI   │
│ - Terminal    │      │ - E2E encrypted │
│ - Git / Files │      │ - File upload   │
└───────────────┘      └─────────────────┘
```

## Quick Start

### Option A: npm (Agent only)

```bash
# Install the agent globally
npm install -g @yeaft/webchat-agent

# Connect to a server
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# Upgrade to latest
yeaft-agent upgrade
```

### Option B: Full development setup

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# Install all dependencies
npm install

# Start server + agent in dev mode (no auth)
npm run dev
```

Then open `http://localhost:3456` in your browser.

## Production Deployment

### Server (Docker)

```bash
cd server
cp .env.example .env
# Edit .env — set JWT_SECRET, AGENT_SECRET
```

```yaml
# docker-compose.yaml
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
# Start the server (data/ and SQLite DB are auto-created on first run)
docker compose up -d --build webchat

# Create the first admin user
docker compose exec webchat node server/create-user.js admin your-password admin@example.com
```

Additional users can register via invitation codes (admin creates them in Settings).

![Login](docs/images/login.png)

### Agent

**Via npm** (recommended):

```bash
npm install -g @yeaft/webchat-agent

# Run once (foreground)
yeaft-agent --server wss://your-server.com --name worker-1 --secret your-secret

# Or install as system service (auto-start on boot, auto-restart on crash)
yeaft-agent install --server wss://your-server.com --name worker-1 --secret your-secret

# Manage installed service
yeaft-agent status                 # check if running
yeaft-agent logs                   # view logs (follow mode)
yeaft-agent restart                # restart
yeaft-agent uninstall              # remove service
```

**From source** (for development or without npm global install):

```bash
cd agent
cp .env.example .env
# Edit .env — set SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR

# Run in foreground
node index.js

# Or install as system service (reads config from .env)
node cli.js install

# Manage installed service
node cli.js status
node cli.js logs
node cli.js uninstall
```

You can find the Agent secret in **Settings > Security** within the web interface:

![Setup Agent](docs/images/setup-agent.png)

When no Agent is connected, the welcome page guides you to Settings:

![No Agent](docs/images/no-agent.png)

### Agent CLI

```
yeaft-agent [options]              Run agent in foreground
yeaft-agent install [options]      Install as system service (Linux/macOS/Windows)
yeaft-agent uninstall              Remove system service
yeaft-agent start                  Start installed service
yeaft-agent stop                   Stop installed service
yeaft-agent restart                Restart installed service
yeaft-agent status                 Show service status
yeaft-agent logs                   View service logs
yeaft-agent upgrade                Upgrade to latest version
yeaft-agent --version              Show version

Options:
  --server <url>      WebSocket server URL
  --name <name>       Agent display name
  --secret <secret>   Authentication secret
  --work-dir <dir>    Default working directory
  --auto-upgrade      Check for updates on startup

Environment variables (alternative to flags):
  SERVER_URL, AGENT_NAME, AGENT_SECRET, WORK_DIR
```

## Security

### Authentication

1. **Username + Password** (bcrypt hashed)
2. **TOTP 2FA** (optional, Google/Microsoft Authenticator)
3. **Email verification** (optional, requires SMTP)

### Production Requirements

The server **refuses to start** in production mode if:
- `JWT_SECRET` is left at default

If no users are configured, the server starts with a warning — create the first user via `docker compose exec`.

### Agent Authentication

- Agents authenticate via WebSocket message (secret never in URL)
- **Per-user agent secret**: Agent bound to a specific user (only that user can see it)
- **Global AGENT_SECRET**: Env var fallback, only visible to admin users
- Each connection gets a unique session key for encryption

### Roles & Permissions

| Feature | `user` | `pro` | `admin` |
|---|:---:|:---:|:---:|
| Chat | yes | yes | yes |
| Own agents (per-user secret) | yes | yes | yes |
| Global agents (AGENT_SECRET) | - | - | yes |
| Workbench (Terminal, Git, Files) | - | yes | yes |
| Port Proxy | - | yes | yes |
| Manage invitations | - | - | yes |

## Project Structure

```
claude-web-chat/
├── server/           # Central WebSocket hub (Express + ws)
│   ├── index.js      # Entry point
│   ├── ws-agent.js   # Agent connection & message handling
│   ├── ws-client.js  # Web client connection & message handling
│   ├── ws-utils.js   # Shared WS utilities & ownership checks
│   ├── api.js        # REST endpoints (auth, sessions, users)
│   ├── proxy.js      # Port proxy forwarding
│   ├── database.js   # SQLite storage
│   └── auth.js       # JWT + TOTP + email verification
├── agent/            # Worker machine agent
│   ├── cli.js        # CLI entry point (yeaft-agent command)
│   ├── index.js      # Agent startup & capability detection
│   ├── connection.js # WebSocket connection & auth
│   ├── claude.js     # Claude CLI process management
│   ├── conversation.js # Session lifecycle
│   ├── terminal.js   # PTY terminal (node-pty)
│   ├── workbench.js  # Git + file operations
│   └── sdk/          # Claude CLI stream-json SDK
├── web/              # Vue 3 frontend
│   ├── app.js        # Vue app entry
│   ├── build.js      # Production build (esbuild)
│   ├── components/   # Vue components
│   ├── stores/       # Pinia stores + helpers
│   └── vendor/       # Third-party libs (local, no CDN)
├── Dockerfile        # Multi-stage production build
└── LICENSE           # MIT
```

## Tech Stack

- **Server**: Node.js, Express, ws, better-sqlite3, compression
- **Frontend**: Vue 3, Pinia, xterm.js, CodeMirror 5, marked, highlight.js
- **Build**: esbuild (frontend bundling)
- **Encryption**: TweetNaCl (XSalsa20-Poly1305)
- **Auth**: JWT, bcrypt, speakeasy (TOTP), nodemailer
- **Deploy**: Docker multi-stage build

## CI/CD

GitHub Actions workflows included:

- **CI** (`ci.yml`): Tests on Node 18/20/22 + frontend build on every push/PR
- **Release** (`release.yml`): On tag `v*` — publishes `@yeaft/webchat-agent` to npm, builds Docker image to GHCR, creates GitHub Release

### Publishing a release

```bash
# Tag and push
git tag v1.0.0
git push origin v1.0.0
# GitHub Actions handles the rest
```

## FAQ

See [README.zh-CN.md](README.zh-CN.md#%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98) for detailed troubleshooting (in Chinese).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
