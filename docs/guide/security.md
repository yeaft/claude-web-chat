# Security

Yeaft has three independent credential layers:

1. **Web user authentication** — how a human logs into the Web UI.
2. **Agent authentication** — how an Agent proves that it may connect and which owner may use it.
3. **Native Yeaft provider credentials** — how the Agent calls third-party LLM APIs.

They do not share secrets or fall back to one another.

## Web user authentication

- username/password with bcrypt hashes;
- optional TOTP;
- optional email verification when SMTP is configured;
- JWTs for subsequent REST and WebSocket authorization;
- configurable SSO providers where enabled by the deployment.

Production startup rejects a default `JWT_SECRET`. If no user exists, the Server warns and the operator must create the first administrator.

## Agent authentication and ownership

- Agents authenticate in a WebSocket message; the secret is not placed in the URL.
- A per-user Agent secret binds an Agent to one owner and takes precedence for that user.
- A global `AGENT_SECRET` is the administrative fallback.
- The Server performs owner/access checks before relaying browser requests or Agent output.

Authentication and authorization do not by themselves provide transport confidentiality. They prove identity and constrain routing.

## WebSocket transport confidentiality

Current Web and Agent peers explicitly negotiate **plaintext JSON WebSocket payloads**:

- the Web client sends `client_hello { plaintextOk: true }`;
- a current Agent advertises the `plaintext-ok` capability;
- the Server then disables per-frame TweetNaCl payload encryption for that peer.

Therefore, a production deployment must terminate **HTTPS/WSS** at the Server or a trusted reverse proxy. Plain `ws://` is appropriate only on loopback or another already protected trusted transport.

TweetNaCl XSalsa20-Poly1305 payload encryption remains in the code as a **legacy-peer compatibility fallback** when an older peer does not negotiate plaintext. It is not the default confidentiality layer for a current Web + Server + Agent combination. Do not describe the current relay as end-to-end encrypted: the Server routes normal plaintext JSON after the WSS endpoint and can inspect message bodies.

| Path | Current confidentiality boundary |
| --- | --- |
| Browser ↔ Server | TLS from HTTPS/WSS in production; current application payload is plaintext JSON inside that transport |
| Agent ↔ Server | TLS from WSS in production; current application payload is plaintext JSON inside that transport |
| Legacy peer fallback | TweetNaCl per-frame payload encryption when plaintext capability is absent |
| Agent ↔ LLM provider | Provider HTTPS/TLS |

## Native Yeaft provider credentials

Native Yeaft calls configured LLM providers directly from the Agent. The config path belongs to the Agent instance:

- default service instance: `~/.yeaft/config.json`;
- named instance `<name>`: `~/.yeaft/instances/<name>/config.json` unless `YEAFT_DIR` / `--yeaft-dir` overrides it.

Provider entries use one of two credential modes:

| Mode | Field | Behavior |
| --- | --- | --- |
| Static API key | `apiKey` | Stored in the instance config and reused for requests |
| Dynamic credential | `credentialProvider: "github-copilot"` | Obtains short-lived Copilot API credentials from the local GitHub credential flow |

Security consequences:

- static `apiKey` values are plaintext on the Agent disk; restrict file permissions and never commit the config;
- dynamic provider tokens remain process-local and refresh as required;
- the Server does not proxy native LLM requests or own provider credentials;
- raw provider traces, prompts, tool inputs/outputs, attachments, memory, and project files are sensitive Agent data.

## Roles and permissions

All registered users are currently Pro by default; the first CLI-created user is Admin.

| Feature | `pro` | `admin` |
| --- | :---: | :---: |
| Conversations and owned Agents | yes | yes |
| Global-secret Agents | - | yes |
| Workbench and port proxy | yes | yes |
| Invitation administration | - | yes |
| Admin dashboard | - | yes |

## Threat model: what Yeaft does not protect against

- **Compromised Agent machine:** an attacker with sufficient local access can read instance config, project files, memory, traces, and process data.
- **Malicious or compromised Server:** the current Server can see relayed plaintext message bodies after TLS termination and can serve modified Web JavaScript. Do not treat it as an oblivious encrypted relay.
- **Missing TLS:** authentication over public `ws://` does not protect message confidentiality. Use WSS.
- **Browser-side compromise/XSS:** a compromised client can read everything visible to that user.
- **Unsafe Agent tools:** authentication does not sandbox shell, Git, file, provider, or external side effects. Tool and repository policies remain part of the security boundary.
