# Agent 与原生 CLI 参考

npm 包会安装两个职责不同的命令：

- `yeaft-agent`：运行/管理 Web-connected Agent 及其本机配置。
- `yeaft`：直接从终端运行 Yeaft 原生引擎。

不要把它们当成 alias。`yeaft-agent` 面向 service/control-plane integration；`yeaft` 面向 code-agent query。

## `yeaft-agent`

```text
yeaft-agent [options]              前台运行 Agent
yeaft-agent local [options]        运行本机 Web UI、Server 与 Agent
yeaft-agent install [options]      安装 managed service
yeaft-agent uninstall [options]    删除 managed service
yeaft-agent start [options]        启动 managed service
yeaft-agent stop [options]         停止 managed service
yeaft-agent restart [options]      重启 managed service
yeaft-agent status [options]       查看 service 状态
yeaft-agent logs [options]         跟踪 service 日志
yeaft-agent doctor                 诊断 service 配置
yeaft-agent llm <command>          配置原生 LLM provider/model
yeaft-agent upgrade [--name <id>]  升级并重启一个 instance
yeaft-agent --version              显示 package version
```

### Runtime options

| Flag | 含义 |
| --- | --- |
| `--server <url>` | Server WebSocket URL，默认 `ws://localhost:3456` |
| `--name <name>` | Agent display name 与本机 instance identity |
| `--port <port>` | Local mode HTTP port，默认 `6868` |
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

### Managed instance

```bash
yeaft-agent install --server wss://example.test --name worker-a --secret "$AGENT_SECRET"
yeaft-agent status --name worker-a
yeaft-agent logs --name worker-a
yeaft-agent restart --name worker-a
```

多个 service instance 通过 `--name` 选择；它们的数据/配置 identity 必须保持分离。

### 原生 LLM 配置

```text
yeaft-agent llm show [--reveal]
yeaft-agent llm list-models [<provider-name>]
yeaft-agent llm setup
yeaft-agent llm use github-copilot --model <model-id> [--fast <model-id>]
yeaft-agent llm use openai-compatible --name <name> --base-url <url> \
  --api-key-env <ENV> --model <model-id> [--fast <model-id>]
yeaft-agent llm add-provider ...
yeaft-agent llm set-model --primary <provider/model> [--fast <provider/model>]
yeaft-agent llm remove-provider --name <name>
```

不带 provider 的 `list-models` 只离线读取本机 config。`list-models github-copilot` 使用本机 credential provider 做 live discovery。不要在日志中使用 `show --reveal`，它会打印已保存 secret。

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
| `--session-id <id>` | 持久化/恢复原生 Session；ID 必须满足 runtime Session-ID contract |
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

CLI Session 使用与 Web path 相同的原生 Session runtime 和 ID validation。传入已有 Session roster 时，会运行 transport-neutral multi-VP Session runner，并在 stream event 中增加 VP identity；CLI 不通过未文档化的文本 flag 创建任意 roster。

## 诊断

```bash
yeaft-agent doctor
yeaft --trace stats
yeaft --trace recent
yeaft --trace search "keyword"
```

Debug trace 与 `--reveal` output 可能包含 credential、prompt、tool parameter 和 project content。必须留在所属 Agent 的边界内。
