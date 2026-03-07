# FAQ

## Agent connection failed "Invalid agent secret"

Make sure the Agent's `AGENT_SECRET` (or `--secret` flag) matches the value configured in the server's `.env` file.

## Server startup failed "SECURITY CONFIGURATION ERROR"

In production mode, the JWT secret must be changed from default:

```ini
JWT_SECRET=your-random-string-at-least-32-chars
```

Generate one with: `openssl rand -base64 32`

## 502 Bad Gateway after Docker deployment

1. Check if the container is running: `docker compose logs webchat`
2. Reload Nginx DNS cache: `docker exec nginx nginx -s reload`

## SQLite read-only error (SQLITE_READONLY)

Ensure data directory permissions are correct:

```bash
sudo chown -R root:root ./data
```

## Cannot login after TOTP setup

TOTP codes have a time window (default ±30 seconds). Make sure the server and your phone clocks are in sync.
