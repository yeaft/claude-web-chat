# Agent CLI Reference

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
```

## Options

| Flag | Description |
|---|---|
| `--server <url>` | WebSocket server URL |
| `--name <name>` | Agent display name |
| `--secret <secret>` | Authentication secret |
| `--work-dir <dir>` | Default working directory |
| `--auto-upgrade` | Check for updates on startup |

## Environment Variables

As an alternative to command-line flags:

| Variable | Equivalent Flag |
|---|---|
| `SERVER_URL` | `--server` |
| `AGENT_NAME` | `--name` |
| `AGENT_SECRET` | `--secret` |
| `WORK_DIR` | `--work-dir` |

## Auto-upgrade

```bash
# Manual upgrade
yeaft-agent upgrade

# Check for updates on startup
yeaft-agent --auto-upgrade --server wss://...
```

The server can also push upgrade notifications by setting the `AGENT_LATEST_VERSION` environment variable.
