# Workbench

Workbench is the development panel on the right side of Chat and Yeaft Sessions. Its tools run on the selected Agent and are scoped to the currently selected Session and working directory.

## Open and close Workbench

Use the **Workbench** action in the Chat header or Yeaft Session actions.

Workbench opens on a launcher with four capability cards:

- **Terminal** — run commands in the current Session working directory
- **Git** — inspect repository status and diffs
- **Files** — browse, preview, and edit Agent-local files
- **Browser** — view and control the Agent-local browser when Browser Runtime is available

All four cards remain visible. A card marked **Unavailable on this Agent** can be opened to see the current availability explanation, but it does not start a fake or partial tool.

Only the capability you select is started. Closing the capability returns focus to its launcher card; closing Workbench collapses the whole panel. You can also maximize the panel or drag its left resize handle.

Workbench follows the canonical Session route. Switching to another Session on the same Agent returns to the launcher and isolates Terminal, Git, and Files state from the previous Session.

## Terminal

Terminal provides an xterm.js terminal connected to a PTY on the Agent:

- opens in the selected Session's working directory
- supports horizontal and vertical splits
- supports normal terminal applications such as `vim`, `tmux`, and `htop`
- keeps terminal state only within the owning Session route

Use the Terminal toolbar to split or close terminal panes. Use the Workbench back action to return to the capability launcher without closing the entire Workbench.

## Files

Files provides a VS Code-style file tree, editor, and preview surface.

### File tree

- expand and collapse directories
- use `Ctrl+P` for quick open
- create, delete, move, copy, or upload files
- refresh the tree or choose another folder inside the current Session workspace

### Editor and previews

- edit multiple files with syntax highlighting
- use `Ctrl+F` / `Ctrl+H` to find and replace
- use `Ctrl+S` to save on the Agent
- preview Markdown, images, PDFs, and supported Office documents

Opening a file reference from chat opens Workbench directly in Files for the current Session route.

## Git

Git shows the repository selected for the current Session:

- branch and ahead/behind status
- staged, modified, and untracked files
- file diffs
- stage, unstage, discard, commit, and push actions
- an optional folder picker for another repository within the current Session workspace

Use Terminal for merge-conflict resolution and interactive rebase.

## Browser

Browser opens an isolated Chromium process on the selected Agent and displays its active tab as a live WebRTC video stream. Browser Sessions are memory-only, use a temporary profile, and are bounded by the Agent's configured Session and idle limits.

The current viewer is read-only. Navigation, keyboard, pointer, and scroll control arrive in the next Browser Runtime phase; the UI does not pretend those controls are available in this release.

### Enable Browser Runtime

Browser is fail-closed at three layers. All three must be ready:

1. Enable the Server rollout gate with `BROWSER_RUNTIME_ENABLED=true`.
2. Configure ICE. `BROWSER_STUN_URLS` is optional for direct connectivity. Production deployments should configure `BROWSER_TURN_URLS` and `BROWSER_TURN_SECRET`; use `BROWSER_ICE_TRANSPORT_POLICY=relay` when direct candidates are not allowed.
3. On the selected Agent instance, install and enable the pinned managed browser, then restart that Agent:

```bash
yeaft-agent browser install --name <agent-instance>
yeaft-agent browser probe --name <agent-instance>
yeaft-agent browser enable --name <agent-instance>
```

After restart, a successful Linux tab-capture probe advertises `browser_runtime`, `browser_webrtc`, and `browser_capture_tab`. Workbench enables Browser only after the Web protocol handshake, Server rollout gate, and complete Agent capability combination all succeed.

A deployment without TURN may work over direct ICE, but it is a degraded direct-only setup and is not a production availability guarantee across NATs or restrictive networks.

### Session lifecycle

- opening Browser restores an existing ready Browser Session for that Agent or creates one
- closing the Browser capability detaches only the viewer; the Agent reclaims a no-viewer Session after the configured idle timeout
- **End browser** closes Chromium and deletes its temporary profile immediately
- WebSocket or Agent transport replacement invalidates the peer generation and closes Agent-owned Browser Sessions fail-closed
- SDP, ICE candidates, TURN credentials, video, and temporary profile data are never written to Chat or Yeaft transcripts

## Troubleshooting

**A capability is unavailable**

- verify that the selected Agent advertises the required capability, including `workbench_session_routes` for route-scoped tools
- upgrade the Agent if necessary and check its startup logs

**Terminal does not open**

- check the Agent logs for PTY startup errors
- verify that the Agent installation includes the supported PTY backend

**Files or Git points at the wrong project**

- confirm the currently selected Session and its working directory
- close and reopen the capability after changing Session metadata

**Files cannot save**

- confirm that the Agent process user can write to the selected path
