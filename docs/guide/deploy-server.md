# Server Deployment (Docker)

## Configuration

```bash
cd server
cp .env.example .env
# Edit .env — set JWT_SECRET, AGENT_SECRET
```

## Docker Compose

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

Additional users can register directly from the login page (open registration, no invite code required).

![Login](/images/login.png)

## Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name cc.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://webchat:3456;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket long connection timeout
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```
