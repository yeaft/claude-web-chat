# Getting Started

## Option A: npm (Agent only)

If you already have a server running, just install the agent:

```bash
# Install the agent globally
npm install -g @yeaft/webchat-agent

# Connect to a server
yeaft-agent --server wss://your-server.com --name my-worker --secret your-secret

# Upgrade to latest
yeaft-agent upgrade
```

## Option B: Full development setup

```bash
git clone https://github.com/yeaft/claude-web-chat.git
cd claude-web-chat

# Install all dependencies
npm install

# Start server + agent in dev mode (no auth)
npm run dev
```

Then open `http://localhost:3456` in your browser.

## Next Steps

- [Deploy the Server (Docker)](/guide/deploy-server) — Production deployment guide
- [Set up an Agent](/guide/deploy-agent) — Connect a worker machine
- [Chat](/guide/features-chat) — Start using the chat interface
- [Crew](/guide/features-crew) — Multi-agent collaboration
