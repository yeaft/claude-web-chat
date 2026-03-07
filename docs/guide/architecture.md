# Architecture

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

## CI/CD

GitHub Actions workflows included:

- **CI** (`ci.yml`): Tests on Node 18/20/22 + frontend build on every push/PR
- **Release** (`release.yml`): On tag `v*` — publishes `@yeaft/webchat-agent` to npm, builds Docker image to GHCR, creates GitHub Release
