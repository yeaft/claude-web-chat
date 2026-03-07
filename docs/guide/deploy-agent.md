# Agent Setup

## Via npm (recommended)

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

## From source

For development or without npm global install:

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

## Finding the Agent Secret

You can find the Agent secret in **Settings > Security** within the web interface:

![Setup Agent](/images/setup-agent.png)

When no Agent is connected, the welcome page guides you to Settings:

![No Agent](/images/no-agent.png)
