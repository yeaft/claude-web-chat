# Security

## Authentication

1. **Username + Password** (bcrypt hashed)
2. **TOTP 2FA** (optional, Google/Microsoft Authenticator)
3. **Email verification** (optional, requires SMTP)

## Production Requirements

The server **refuses to start** in production mode if:
- `JWT_SECRET` is left at default

If no users are configured, the server starts with a warning — create the first user via `docker compose exec`.

## Agent Authentication

- Agents authenticate via WebSocket message (secret never in URL)
- **Per-user agent secret**: Agent bound to a specific user (only that user can see it)
- **Global AGENT_SECRET**: Env var fallback, only visible to admin users
- Each connection gets a unique session key for encryption

## Roles & Permissions

All registered users are **Pro** by default. The first user created via CLI is **Admin**.

| Feature | `pro` | `admin` |
|---|:---:|:---:|
| Chat | yes | yes |
| Own agents (per-user secret) | yes | yes |
| Global agents (AGENT_SECRET) | - | yes |
| Workbench (Terminal, Git, Files) | yes | yes |
| Port Proxy | yes | yes |
| Manage invitations | - | yes |
