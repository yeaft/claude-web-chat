# Agent and Native CLI Reference

The npm package installs separate commands for two different responsibilities:

- `yeaft-agent` runs or manages the Web-connected Agent. Its `llm` subcommand edits an explicit `--config` path, or `~/.yeaft/config.json` by default; it does not infer a named instance.
- `yeaft` runs the native Yeaft engine directly from a terminal.

Do not treat them as aliases. `yeaft-agent` is service/control-plane integration; `yeaft` is a code-agent query interface.

## `yeaft-agent`

```text
yeaft-agent [options]              Run Agent in foreground
yeaft-agent local [options]        Run local Web UI, Server, and Agent
yeaft-agent local install [options] Install local mode as a managed service
yeaft-agent install [options]      Install a managed service
yeaft-agent uninstall [options]    Remove a managed service
yeaft-agent start [options]        Start a managed service
yeaft-agent stop [options]         Stop a managed service
yeaft-agent restart [options]      Restart a managed service
yeaft-agent status [options]       Show service status
yeaft-agent logs [options]         Follow service logs
yeaft-agent doctor                 Diagnose service configuration
yeaft-agent llm <command>          Configure native LLM providers/models
yeaft-agent upgrade [--name <id>]  Upgrade the package; restart explicitly on Unix
yeaft-agent --version              Show package version
```

### Runtime options

| Flag | Meaning |
| --- | --- |
| `--server <url>` | Server WebSocket URL; default `ws://localhost:3456` |
| `--name <name>` | Agent display name and local instance identity |
| `--port <port>` | Local mode HTTP port; default `6868` |
| `--background`, `-d` | Detach local mode after spawning it |
| `--secret <secret>` | Agent authentication secret |
| `--work-dir <dir>` | Default execution directory |
| `--yeaft-dir <dir>` | Yeaft data root for this Agent instance |
| `--auto-upgrade` | Check for package updates on startup |

Environment alternatives are `SERVER_URL`, `AGENT_NAME`, `AGENT_SECRET`, `WORK_DIR`, and `YEAFT_DIR`. `YEAFT_AGENT_INSTANCE` remains a deprecated instance-ID alias.

### Local mode

```bash
yeaft-agent local
yeaft-agent local --name my-worker --port 7000
```

Local mode starts a no-auth Server and Agent bound to `127.0.0.1`. Use it for a trusted workstation, not as a public listener.

### Managed instances

```bash
yeaft-agent install --server wss://example.test --name worker-a --secret "$AGENT_SECRET"
yeaft-agent status --name worker-a
yeaft-agent logs --name worker-a
yeaft-agent restart --name worker-a
```

Multiple service instances are selected by `--name`; their data/config identity must remain separate.

On Unix, `yeaft-agent upgrade --name worker-a` installs the package but does not restart that named service. Apply the new version explicitly:

```bash
yeaft-agent upgrade --name worker-a
yeaft-agent restart --name worker-a
```

### Native LLM configuration

Every `llm` command accepts `--config <path>`. Without it, the CLI always edits `~/.yeaft/config.json`; `--name`, `--yeaft-dir`, and `YEAFT_DIR` do not select a config for this subcommand.

```bash
CONFIG="$HOME/.yeaft/instances/worker-a/config.json"
yeaft-agent llm show --config "$CONFIG"
yeaft-agent llm list-models --config "$CONFIG"
yeaft-agent llm setup --config "$CONFIG"
yeaft-agent llm use github-copilot --config "$CONFIG" --model <model-id> --fast <model-id>
yeaft-agent llm use openai-compatible --config "$CONFIG" --name <provider-name> --base-url <url> \
  --api-key-env <ENV> --model <model-id> --fast <model-id>
yeaft-agent llm add-provider --config "$CONFIG" ...
yeaft-agent llm set-model --config "$CONFIG" --primary <provider/model> --fast <provider/model>
yeaft-agent llm remove-provider --config "$CONFIG" --name <provider-name>
```

The default service instance uses `~/.yeaft/config.json`; named `<name>` uses `~/.yeaft/instances/<name>/config.json` unless its Yeaft directory was overridden. `yeaft-agent local` defaults `<name>` to the sanitized computer hostname, so use an explicit `--name` when you want a predictable path. `list-models` without a provider reads the selected config offline; `list-models github-copilot` performs live discovery. Avoid `show --reveal` in logs because it prints stored secrets.

## `yeaft`

```text
yeaft "prompt"                    One-shot native query
yeaft -i                          Interactive REPL
yeaft -p "prompt"                 Non-interactive print mode
yeaft --dry-run "prompt"          Show the prepared prompt without an LLM call
```

### Query options

| Flag | Meaning |
| --- | --- |
| `--session-id <id>` | Text modes require an existing formal Session; stream-json accepts a validated existing Session ID or a new ad-hoc CLI conversation key |
| `--cwd <dir>` | Execution working directory |
| `--model <provider/model>` | Override the configured model |
| `--effort <level>` | Override model reasoning effort when supported |
| `--input-format text\|stream-json` | Input protocol |
| `--output-format text\|stream-json` | Output protocol |
| `--language en\|zh` | Prompt language |
| `--debug` | Enable debug tracing |
| `--skip-mcp` | Do not connect configured MCP servers |
| `--skip-skills` | Do not load Skills |

### Machine-readable JSONL

Use both `--input-format stream-json` and `--output-format stream-json` for integrations:

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"List the repository test commands."}}' \
  | yeaft --session-id session_ci \
      --cwd "$PWD" \
      --input-format stream-json \
      --output-format stream-json
```

Stdout is JSONL. Events include Session/turn identity and may include text/thinking deltas, skill loads, tool start/result, todo updates, usage, turn stop, result, or error. If a tool needs human input, stream-json input is required so the caller can return an answer. Treat engine events as authoritative rather than reconstructing state from display text.

If the ID names an existing formal Session (with persisted `session.json` and roster), the transport-neutral runner executes that Session and adds VP identity to streamed events. Per-turn VP selectors such as `targetVpId`, `targetVps`, `targets`, and `broadcast` are valid only on this formal-Session path and are checked against the persisted roster before provider dispatch. A new ID accepted by stream-json only scopes an ad-hoc CLI message history; it does not create `session.json`, a roster, or a Web product Session, so any VP selector is rejected as a terminal result for that input line while later JSONL prompts may continue. ID validation is currently enforced on the stream-json path; text modes instead fail when the requested formal Session does not exist.

## Diagnostics

```bash
yeaft-agent doctor
yeaft --trace stats
yeaft --trace recent
yeaft --trace search "keyword"
```

Debug traces and `--reveal` output may contain credentials, prompts, tool parameters, and project content. Keep them inside the owning Agent boundary.
