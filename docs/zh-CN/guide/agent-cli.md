# Agent 与原生 CLI 参考

npm 包会安装两个职责不同的命令：

- `yeaft-agent`：运行/管理 Web-connected Agent。它的 `llm` subcommand 修改显式 `--config` 路径，未传时固定使用 `~/.yeaft/config.json`；不会推断 named instance。
- `yeaft`：直接从终端运行 Yeaft 原生引擎。

不要把它们当成 alias。`yeaft-agent` 面向 service/control-plane integration；`yeaft` 面向 code-agent query。

## `yeaft-agent`

```text
yeaft-agent [options]              前台运行 Agent
yeaft-agent local [options]        运行本机 Web UI、Server 与 Agent
yeaft-agent local install [options] 安装 local mode 的 managed service
yeaft-agent install [options]      安装 managed service
yeaft-agent uninstall [options]    删除 managed service
yeaft-agent start [options]        启动 managed service
yeaft-agent stop [options]         停止 managed service
yeaft-agent restart [options]      重启 managed service
yeaft-agent status [options]       查看 service 状态
yeaft-agent logs [options]         跟踪 service 日志
yeaft-agent doctor                 诊断 service 配置
yeaft-agent llm <command>          配置原生 LLM provider/model
yeaft-agent upgrade [--name <id>]  升级 package；Unix 上需显式 restart
yeaft-agent --version              显示 package version
```

### Runtime options

| Flag | 含义 |
| --- | --- |
| `--server <url>` | Server WebSocket URL，默认 `ws://localhost:3456` |
| `--name <name>` | Agent display name 与本机 instance identity |
| `--port <port>` | Local mode HTTP port，默认 `6868` |
| `--background`, `-d` | 启动 local mode 后从当前 shell 脱离 |
| `--secret <secret>` | Agent authentication secret |
| `--work-dir <dir>` | 默认 execution directory |
| `--yeaft-dir <dir>` | 当前 Agent instance 的 Yeaft data root |
| `--auto-upgrade` | 启动时检查 package 更新 |

环境变量替代项是 `SERVER_URL`、`AGENT_NAME`、`AGENT_SECRET`、`WORK_DIR` 和 `YEAFT_DIR`。`YEAFT_AGENT_INSTANCE` 仅作为 deprecated instance-ID alias 保留。

### Local mode

```bash
yeaft-agent local
yeaft-agent local --name my-worker --port 7000
```

Local mode 启动绑定到 `127.0.0.1` 的 no-auth Server 与 Agent。它适合受信任的个人工作站，不应作为公网 listener。

临时后台运行：

```bash
yeaft-agent local --name my-worker --port 7000 --background
```

Linux 上可以把同一套 local stack 安装为 user-level systemd service：

```bash
yeaft-agent local install --name my-worker --port 7000
yeaft-agent local status --name my-worker
yeaft-agent local logs --name my-worker
yeaft-agent local stop --name my-worker
yeaft-agent local uninstall --name my-worker
```

service 会在用户登录时启动。若要求机器启动后、尚未登录时也启动，执行一次 `sudo loginctl enable-linger $(whoami)`。它使用同一个 named Agent 的 `~/.yeaft/instances/<name>/` 数据目录，保留正式 Session 与 conversation history。

### Managed instance

```bash
yeaft-agent install --server wss://example.test --name worker-a --secret "$AGENT_SECRET"
yeaft-agent status --name worker-a
yeaft-agent logs --name worker-a
yeaft-agent restart --name worker-a
```

多个 service instance 通过 `--name` 选择；它们的数据/配置 identity 必须保持分离。

在 Unix 上，`yeaft-agent upgrade --name worker-a` 会安装 package，但不会重启这个 named service。需要显式应用新版本：

```bash
yeaft-agent upgrade --name worker-a
yeaft-agent restart --name worker-a
```

### 原生 LLM 配置

每个 `llm` command 都接受 `--config <path>`。未传时 CLI 固定修改 `~/.yeaft/config.json`；这个 subcommand 不会通过 `--name`、`--yeaft-dir` 或 `YEAFT_DIR` 选择 config。

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

Default service instance 使用 `~/.yeaft/config.json`；named `<name>` 默认使用 `~/.yeaft/instances/<name>/config.json`，除非 override 了 Yeaft directory。`yeaft-agent local` 的默认 `<name>` 是经过清理的计算机 hostname；需要可预测路径时应显式传 `--name`。不带 provider 的 `list-models` 只离线读取所选 config；`list-models github-copilot` 做 live discovery。不要在日志中使用 `show --reveal`，它会打印已保存 secret。

## `yeaft`

```text
yeaft "prompt"                    One-shot 原生 query
yeaft -i                          Interactive REPL
yeaft -p "prompt"                 非交互 print mode
yeaft --dry-run "prompt"          不调用 LLM，只展示 prepared prompt
```

### Query options

| Flag | 含义 |
| --- | --- |
| `--session-id <id>` | Text mode 要求已有正式 Session；stream-json 接受已校验的已有 Session ID 或新的 ad-hoc CLI conversation key |
| `--cwd <dir>` | Execution working directory |
| `--model <provider/model>` | Override 已配置 model |
| `--effort <level>` | Model 支持时 override reasoning effort |
| `--input-format text\|stream-json` | 输入协议 |
| `--output-format text\|stream-json` | 输出协议 |
| `--language en\|zh` | Prompt language |
| `--debug` | 启用 debug tracing |
| `--skip-mcp` | 不连接已配置 MCP server |
| `--skip-skills` | 不加载 Skills |

### 机器可读 JSONL

集成时同时使用 `--input-format stream-json` 与 `--output-format stream-json`：

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"列出这个仓库的测试命令。"}}' \
  | yeaft --session-id session_ci \
      --cwd "$PWD" \
      --input-format stream-json \
      --output-format stream-json
```

Stdout 是 JSONL。Event 包含 Session/turn identity，并可能包含 text/thinking delta、skill load、tool start/result、todo update、usage、turn stop、result 或 error。如果工具需要人工输入，必须使用 stream-json input，让调用方可以返回 answer。Engine event 是权威状态，不要根据展示文本重建状态。

如果 ID 指向已有正式 Session（存在持久 `session.json` 与 roster），transport-neutral runner 会执行该 Session，并在 stream event 中增加 VP identity。`targetVpId`、`targetVps`、`targets` 和 `broadcast` 等逐 turn VP selector 只允许用于正式 Session，并会在 provider dispatch 前按持久 roster 校验。

新的 ID 默认仍只隔离 ad-hoc CLI conversation。集成方可仅在第一条 JSONL user prompt 中加入 `roster`（或内容完全相同的 `vps` 别名）以及可选的 `defaultVpId` 来选择正式 Session，例如：

```json
{"type":"user","prompt":"你好","roster":["omni","margaret"],"defaultVpId":"omni"}
```

CLI 会在分派首个 turn 前写入规范的 `session.json`，并为每个正式 Session turn 输出包含 `dispatched_vp_ids` 和 `vp_results` 的单个 aggregate result。roster id 必须唯一且为有效 VP id；同时提供 `vps` 和 `roster` 时二者必须一致，`defaultVpId` 必须属于 roster。后续输入不能修改已持久化的 roster。未在首个 prompt 中提供 roster 时，VP selector 仍会让该输入行返回 terminal error，但后续 JSONL prompt 仍可继续。ID validation 当前只在 stream-json path 强制执行；text mode 则在所请求正式 Session 不存在时失败。

## 诊断

```bash
yeaft-agent doctor
yeaft --trace stats
yeaft --trace recent
yeaft --trace search "keyword"
```

Debug trace 与 `--reveal` output 可能包含 credential、prompt、tool parameter 和 project content。必须留在所属 Agent 的边界内。
