# Claude Web Chat — User Guide

> A web-based interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), providing Chat mode for one-on-one AI conversations and Crew mode for multi-agent team collaboration.

**Language**: [中文版](./USER_GUIDE.zh-CN.md)

---

## Table of Contents

- [Getting Started](#getting-started)
- [Chat Mode](#chat-mode)
  - [Starting a Conversation](#starting-a-conversation)
  - [Sending Messages](#sending-messages)
  - [File and Image Upload](#file-and-image-upload)
  - [Image Preview](#image-preview)
  - [Slash Commands](#slash-commands)
  - [Compact vs Clear](#compact-vs-clear)
  - [Session Restore](#session-restore)
  - [Context Usage Indicator](#context-usage-indicator)
  - [Assistant Response Features](#assistant-response-features)
- [Crew Mode](#crew-mode)
  - [Creating a Crew Session](#creating-a-crew-session)
  - [Team Templates](#team-templates)
  - [Role Configuration](#role-configuration)
  - [Working with Crew](#working-with-crew)
  - [Feature & Task Management](#feature--task-management)
  - [Panel Layout](#panel-layout)
  - [Session Controls](#session-controls)
- [Workbench](#workbench)
  - [Terminal](#terminal)
  - [Files](#files)
  - [Git](#git)
  - [Port Proxy](#port-proxy)
- [Sidebar](#sidebar)
  - [Agent Management](#agent-management)
  - [Session List](#session-list)
  - [Collapsed Mode](#collapsed-mode)
- [Settings](#settings)
  - [General](#general)
  - [Account](#account)
  - [Security & Agent Key](#security--agent-key)
  - [Invitation Codes](#invitation-codes)
  - [Port Proxy Settings](#port-proxy-settings)
- [Agent Installation & Connection](#agent-installation--connection)
  - [Installation](#installation)
  - [Service Management](#service-management)
  - [Connection Configuration](#connection-configuration)
  - [Troubleshooting](#troubleshooting)
- [Login & Registration](#login--registration)
  - [Login](#login)
  - [Registration](#registration)
- [Keyboard Shortcuts](#keyboard-shortcuts)

---

## Getting Started

Claude Web Chat requires two components:

1. **Server** — The web application (this project). Deploy it on your server.
2. **Agent** — A CLI tool (`@yeaft/webchat-agent`) installed on the machine where Claude Code runs. The agent connects to the server via WebSocket and executes Claude Code commands.

After deploying the server, you need to:
1. Log in with your credentials
2. Install and connect at least one agent (see [Agent Installation](#agent-installation--connection))
3. Start a conversation or create a Crew session

---

## Chat Mode

Chat mode provides a one-on-one conversation interface with Claude, similar to using Claude Code in a terminal but through a web UI.

### Starting a Conversation

There are two ways to start a new conversation:

1. **Welcome screen** — When no conversation is selected, the welcome screen shows a "New Conversation" button (visible only when at least one agent is online).
2. **Sidebar** — Click the "+" icon next to "Recent Chats" in the sidebar, or click the "+" button in the collapsed sidebar.

When creating a conversation, you'll be prompted to:
- Select an **Agent** (the machine running Claude Code)
- Choose a **working directory** (the project folder for the conversation)

### Sending Messages

- Type your message in the text area at the bottom of the chat
- Press **Enter** to send (use **Shift+Enter** for a new line)
- Click the **Send** button to send
- While the assistant is processing, a **Stop** button appears to cancel execution
- Each message supports **input draft persistence** — if you switch conversations, your unsent text is saved and restored when you return

### File and Image Upload

You can attach files to your messages:

- Click the **paperclip icon** (📎) next to the input area, or use the file picker
- **Paste images** directly from clipboard (Ctrl+V / Cmd+V)
- Supported file types: images (`image/*`), text files, PDF, Word documents (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), JSON, Markdown, Python, JavaScript, TypeScript, CSS, HTML
- Files are uploaded to the server first, then attached to your message
- Image attachments show a thumbnail preview before sending
- After sending, attachments appear as a collapsible badge (e.g., "📎 2 images, 1 file") — click to expand and view

### Image Preview

Click any image attachment in a message to open a full-screen preview overlay:

- The image is displayed centered on a dark backdrop
- Click the **backdrop** (dark area outside the image) to close
- Press **Escape** to close
- The overlay has a smooth fade-in/fade-out transition

### Slash Commands

Type `/` in the input area to see available slash commands with autocomplete:

- `/compact` — Compact the conversation context (see below)
- `/clear` — Clear all messages
- `/context` — Show context information
- `/cost` — Show token usage and costs
- `/init` — Initialize project
- `/doctor` — Run diagnostics
- `/memory` — Manage Claude's memory
- `/model` — Switch model
- `/review` — Code review
- `/mcp` — MCP server management
- `/skills` — List available skills

Use **Arrow keys** to navigate the autocomplete menu, **Tab** or **Enter** to select a command.

### Compact vs Clear

Two conversation management actions are available in the chat header:

#### Compact (↕ icon)
- **What it does**: Sends `/compact` to Claude, which summarizes the conversation history into a condensed form, reducing token usage while preserving context.
- **When to use**: When the context percentage is getting high (50%+) and you want to continue the conversation without losing context.
- **Effect**: Messages remain visible in the UI, but the underlying context sent to Claude is compressed. A status banner shows "Compacting..." during the process and "Compact complete" when done.
- **The input area is disabled** during compaction.

#### Clear (🗑 icon)
- **What it does**: Sends `/clear` to Claude, which deletes all messages in the current conversation and resets the context.
- **When to use**: When you want a fresh start in the same conversation.
- **Confirmation**: A confirmation dialog appears before clearing.
- **Effect**: All messages are removed. A status banner shows the progress.

### Session Restore

If the server restarts or the connection is interrupted, your conversation can be restored:

- Click the **Refresh** button (↻ icon) in the chat header to re-sync messages from the agent
- The system loads the last 5 turns of the conversation
- A loading overlay appears while messages are being fetched

### Context Usage Indicator

In the top-right corner of the chat header, a percentage badge shows the current context window usage:

- **Green** (0-49%): Healthy context usage
- **Yellow** (50-79%): Consider compacting soon
- **Red** (80%+): Context is nearly full, compact recommended

Hover over the badge to see the exact token count (e.g., "Context: 45k / 200k").

### Assistant Response Features

Claude's responses are rendered as "turns" with rich features:

- **Markdown rendering** with syntax-highlighted code blocks
- **Copy button** on each response to copy the text content
- **Code block copy** — Each code block has its own copy button with language label
- **Tool usage display** — Shows what tools Claude used (file reads, edits, searches, etc.)
  - The latest tool action is always visible
  - Previous actions are collapsed behind a "N more" toggle button
- **Todo progress** — When Claude uses the TodoWrite tool, a checklist appears showing task progress with checkmarks (✓), spinners, and status
- **AskUserQuestion** — When Claude asks a question, an interactive card appears with:
  - Pre-defined options to choose from (radio buttons or checkboxes)
  - A custom text input for free-form answers
  - A submit button to send your response
  - Answered questions show the selected response

---

## Crew Mode

Crew mode enables multi-agent team collaboration where multiple AI agents work together as a team with defined roles, managed by a PM (project manager) agent.

### Creating a Crew Session

1. Click the "+" icon next to **Crew Sessions** in the sidebar
2. The **Crew Session** configuration panel opens:

**Step 1: Select Agent**
- Choose an online agent that supports Crew mode (must have the `crew` capability)
- Only agents with Crew support appear in the dropdown

**Step 2: Set Workspace**
- Enter or browse for the project directory
- This is the root directory where the `.crew` folder will be created
- If a `.crew` directory already exists, you'll see options to **Restore** the previous session or **Delete** the config and start fresh

**Step 3: Configure Team**
- Enter a **team name** (optional, max 30 characters)
- Select a **team template** or start from scratch

**Step 4: Start**
- Click the **Start** button to initialize the Crew session
- An initialization progress indicator shows "Preparing roles..." → "Setting up worktrees..."

### Team Templates

Four built-in templates are available, each with pre-configured roles:

| Template | Description | Roles |
|----------|-------------|-------|
| **Dev** | Software development team | PM, Developer, Reviewer, Tester, Designer |
| **Writing** | Creative writing team | Customized writing roles |
| **Trading** | Financial trading team | Trading-specific roles |
| **Video** | Short video production team | Video production roles |
| **Custom** | Start with empty roles | No pre-defined roles |

Templates are available in both Chinese and English, automatically selected based on the UI language setting.

### Role Configuration

Each role has the following properties:

| Property | Description |
|----------|-------------|
| **Icon** | An emoji or short text (max 4 chars) displayed as the role avatar |
| **Display Name** | The name shown in the UI |
| **Description** | A brief description of the role's responsibilities |
| **Decision Maker** | Radio button — one role per team is the decision maker (★ star icon). This role coordinates the team. |
| **Custom Prompt** | Advanced setting — additional CLAUDE.md instructions for this role |
| **Concurrency** | For Developer, Reviewer, and Tester roles: set the number of parallel instances (1-3). Reviewer and Tester auto-follow the Developer count. |

**Adding Roles:**
- Click "Add Role" to open the built-in role picker
- Available preset roles: PM, Developer, Reviewer, Tester, Designer, Architect, DevOps, Researcher
- Some roles are bundled (e.g., adding Developer also adds Reviewer and Tester)
- You can also create a fully custom role with the "Custom Role" option

**Removing Roles:**
- Click the "×" button on any role card to remove it
- If the removed role was the decision maker, the first remaining role becomes the new decision maker

### Working with Crew

Once a Crew session is running:

**Sending Messages:**
- Type messages in the input area at the bottom
- Use **@** to mention a specific role (e.g., `@pm please create a task for...`)
  - An autocomplete menu appears showing available roles
  - Use Arrow keys to navigate, Enter to select
- Press **Enter** to send, **Shift+Enter** for new line

**Message Display:**
- Messages are grouped into **Feature threads** (collapsible blocks organized by task)
- Each feature thread shows:
  - The task title as a header
  - Status indicators (In Progress / Completed)
  - Active roles working on the task (role icons)
  - A "View history" toggle to see older messages
  - The latest message is always visible
- **Global messages** (without a task ID) appear inline outside feature blocks
- **Round dividers** show when the conversation enters a new round
- **Active Messages** section at the bottom shows the most recent message from any role

**Status Bar:**
- Above the input area, a status line shows:
  - **Round number** (R0, R1, R2...)
  - **Cost** in USD
  - **Total tokens** used

### Feature & Task Management

The **Feature Panel** (right sidebar) shows a Kanban-style board:

**Total Progress:**
- A progress bar at the top shows overall completion (e.g., "3 / 5 — 60%")

**In Progress Section:**
- Cards for each active feature/task
- Each card shows:
  - Task title
  - Progress bar (done count / total count)
  - Active roles working on it (role icons)
  - Elapsed time since creation
  - Expandable todo list showing individual steps
- Click a card header to expand/collapse its todo list
- Double-click a card to scroll to that feature in the message flow

**Completed Section:**
- Collapsed by default — click the header to expand
- Shows completed features with their final progress and total time

### Panel Layout

**Desktop (>768px):**
- Three-panel layout: Role Panel (left) | Messages (center) | Feature Panel (right)
- Both side panels can be toggled on/off using the header buttons (people icon for roles, chart icon for features)
- When panels are hidden, the message area expands to fill the space

**Mobile (≤768px):**
- Single-panel layout — only the message area is visible by default
- Tap the **Roles** or **Features** button in the header to open the respective panel as a slide-in drawer
- Tap the overlay backdrop to close the drawer
- A "Close" button is also available inside each drawer

### Session Controls

**Role Panel Actions (bottom of the role panel):**
- **Add Role** (+) — Add a new role to the running session
- **Clear Session** (×) — Clear all messages and reset the session (with confirmation)
- **Stop All** (⏹) — Stop all currently running role processes

**Per-Role Actions (on each role card):**
- **Abort** (⏹) — Stop the current task for this specific role (visible only when the role is actively processing)
- **Clear** (🗑) — Clear this role's chat history

**Crew Settings** — Available via the header gear button:
- Edit team name
- Add/remove roles in the running session
- Changes take effect immediately via the "Apply Changes" button

---

## Workbench

The Workbench is a side panel that provides development tools integrated with the chat experience. It appears on the right side of the chat area and supports three tabs.

### Accessing the Workbench

- Click the **Workbench** icon in the sidebar header (looks like a panel layout icon)
- The workbench can be **maximized** to take more screen space or **collapsed** to hide it
- Drag the **resize handle** on the left edge to adjust the panel width
- Available tabs depend on agent capabilities (`terminal`, `file_editor`)

### Terminal

The Terminal tab provides an integrated terminal connected to the agent machine:

- **Split panes** — Split horizontally (─) or vertically (│) to run multiple terminals side by side
- **Close pane** — Close the active terminal pane
- **Auto-creation** — Terminals are created automatically when the agent runs commands
- Click on a terminal pane to make it active (highlighted border)
- Full terminal emulation powered by xterm.js

### Files

The Files tab provides a VS Code-style file explorer and editor:

**File Tree (left column):**
- Hierarchical directory tree with expand/collapse
- File/folder icons based on file type
- **Search** — Filter files by name (Ctrl+P for quick open)
- **New File** / **New Folder** — Create files/directories via toolbar buttons
- **Delete** / **Move** — Select files and use the operations toolbar
- **Refresh** — Reload the directory tree
- **Collapse All** — Collapse all expanded directories
- **Open Folder** — Change the root directory using a folder picker
- **Drag and drop** — Drop files from your desktop to upload

**Editor (right column):**
- Multi-tab editor with syntax highlighting
- **Find & Replace** — Search within files
- Supports many file types: code, markdown, images, Office documents
- Office documents can be previewed locally or via Office Online (configurable in Settings)
- **Font size** — Use Ctrl+Scroll to adjust the tree font size

### Git

The Git tab provides a visual git status viewer:

- **Branch display** — Shows current branch name and changed file count
- **Push button** — Push commits to remote (shows ahead count)
- **File list** — Shows staged and unstaged changes with status indicators
- **Diff viewer** — Side-by-side or unified diff view for selected files
- **Stage/Unstage** — Toggle files between staged and unstaged
- **Commit** — Write a commit message and commit staged changes
- **Work directory** — Choose which repository to view via folder picker

### Port Proxy

Port Proxy allows you to access services running on the agent machine through the web UI:

- **Add port** — Specify the agent, host, port number, and an optional label
- **Toggle** — Enable/disable individual port proxies with the switch
- **Open in Browser** — Click to open the proxied service in a new browser tab
- **Copy URL** — Click the URL to copy it to clipboard
- Accessible from both the sidebar (collapsed mode) and the Settings → Proxy tab

---

## Sidebar

The sidebar provides navigation and session management.

### Agent Management

The agent status area at the top of the sidebar shows:

- **Online count** — Number of connected agents (e.g., "2 Agent")
- **Latency indicator** — Color-coded ping latency for the current agent
- **Agent dropdown** — Click to expand the full agent list:
  - Each agent shows: name, version, latency, online/offline status
  - **Upgrade** button (↑) — Upgrade the agent to the latest version remotely
  - **Restart** button (↻) — Restart the agent process remotely

### Session List

The sidebar is divided into two sections:

**Recent Chats:**
- Lists all Chat mode conversations
- Shows: conversation title (derived from content or folder name), timestamp, working directory, agent name, latency
- Click a conversation to switch to it
- Click the "×" button to delete a conversation
- A processing dot indicates active conversations

**Crew Sessions:**
- Lists all Crew mode sessions
- Shows: team name, timestamp, working directory, agent name
- Each entry has a crew icon (👥) to distinguish from regular chats

### Collapsed Mode

Click the collapse button (⟵) to minimize the sidebar to an icon-only bar:

- **Menu** icon — Expand sidebar
- **Proxy** icon — Toggle port proxy panel
- **Workbench** icon — Toggle workbench panel
- **+** icon — New conversation
- **Crew** icon — New Crew session
- **Theme** icon — Toggle light/dark mode

---

## Settings

Access Settings by clicking the **gear icon** (⚙) at the bottom of the sidebar.

### General

- **Theme** — Switch between Light and Dark mode
- **Language** — Switch between 中文 (Chinese) and English
- **Office Preview Mode** — Choose between "Local Render" (built-in viewer) and "Office Online" (Microsoft Office online viewer) for Office document previews

### Account

- **Username** — Your login username (read-only)
- **Role** — Your account role: **Pro** or **Admin** (read-only)
- **Email** — Your email address (if set)
- **Logout** — Sign out of your account

### Security & Agent Key

**Agent Key:**
- A secret key used to authenticate agents connecting to the server
- Click the **eye icon** to show/hide the key
- Click the **copy icon** to copy the key to clipboard
- Click **Reset Key** to generate a new key (requires confirmation — all connected agents will need the new key)

**Install Commands:**
- After obtaining your agent key, two commands are shown:
  1. `npm install -g @yeaft/webchat-agent` — Install the agent CLI globally
  2. `yeaft-agent install --server <your-server-url> --secret <your-key>` — Install as a system service

**Change Password:**
- Enter current password, new password (minimum 6 characters), and confirm
- Click "Change Password" to update

### Invitation Codes

> Admin-only feature

Admins can create invitation codes for new users:

- **Create** — Select the role (Pro) and click the "+" button to generate a code
- **Code list** — Shows all invitation codes with:
  - The code string
  - Role badge
  - Status: Available / Used / Expired
  - Used-by username (if used) or expiration time
  - Copy button (for unused codes)
  - Delete button (for unused codes)

New users register using an invitation code on the login page.

### Port Proxy Settings

The Proxy tab in Settings provides the same Port Proxy functionality described in the [Workbench section](#port-proxy).

---

## Agent Installation & Connection

The agent (`@yeaft/webchat-agent`) is a Node.js CLI tool that runs on the machine where Claude Code is installed. It connects to the Claude Web Chat server via WebSocket and bridges commands between the web UI and Claude Code.

### Installation

**Prerequisites:**
- Node.js 18+ installed
- Claude Code CLI installed and configured (`claude` command available)
- npm or a compatible package manager

**Step 1: Install the agent**
```bash
npm install -g @yeaft/webchat-agent
```

**Step 2: Get your agent secret**
- Log in to Claude Web Chat
- Go to **Settings → Security**
- Copy the **Agent Key**

**Step 3: Install as a system service**
```bash
yeaft-agent install --server wss://your-server.com --secret YOUR_AGENT_KEY
```

This registers the agent as a system service (systemd on Linux, launchd on macOS) that starts automatically on boot.

**Alternative: Run in foreground**
```bash
yeaft-agent --server wss://your-server.com --secret YOUR_AGENT_KEY --name my-worker
```

### Service Management

Once installed as a service, you can manage it with these commands:

| Command | Description |
|---------|-------------|
| `yeaft-agent start` | Start the service |
| `yeaft-agent stop` | Stop the service |
| `yeaft-agent restart` | Restart the service |
| `yeaft-agent status` | Show service status |
| `yeaft-agent logs` | View service logs (follow mode) |
| `yeaft-agent uninstall` | Remove the system service |
| `yeaft-agent upgrade` | Upgrade to the latest version |

### Connection Configuration

The agent can be configured via:

**CLI flags:**
| Flag | Description | Default |
|------|-------------|---------|
| `--server <url>` | WebSocket server URL | `ws://localhost:3456` |
| `--name <name>` | Agent display name | `Worker-{platform}-{pid}` |
| `--secret <secret>` | Agent secret for authentication | — |
| `--work-dir <dir>` | Default working directory | Current directory |
| `--auto-upgrade` | Check for updates on startup | Off |

**Environment variables** (override CLI flags):
| Variable | Description |
|----------|-------------|
| `SERVER_URL` | WebSocket server URL |
| `AGENT_NAME` | Agent display name |
| `AGENT_SECRET` | Agent secret |
| `WORK_DIR` | Working directory |

**Config file** (auto-created on first run):
- Local: `.claude-agent.json` in the working directory
- Global: `~/.config/yeaft-agent/config.json`

Priority order: Environment variables > CLI flags > Config file

### Troubleshooting

**Agent shows offline in the web UI:**
- Check that the agent process is running: `yeaft-agent status`
- Verify the server URL is correct and reachable
- Ensure the agent secret matches the one in Settings → Security
- Check agent logs: `yeaft-agent logs`

**Connection keeps reconnecting:**
- The agent auto-reconnects every 5 seconds by default
- Check network connectivity between the agent machine and the server
- If using WSS (WebSocket Secure), ensure SSL certificates are valid

**Agent version mismatch:**
- Use the **Upgrade** button in the sidebar agent dropdown to upgrade remotely
- Or manually: `yeaft-agent upgrade` or `npm install -g @yeaft/webchat-agent@latest`

**Crew mode not available:**
- Crew mode requires the agent to have the `crew` capability
- Ensure Claude Code is properly installed and the `claude` command is available
- Restart the agent after installing Claude Code

---

## Login & Registration

### Login

1. Enter your **username** and **password**
2. If TOTP (two-factor authentication) is enabled:
   - **First login**: A QR code is displayed — scan it with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code
   - **Subsequent logins**: Enter the 6-digit code from your authenticator app
3. If email verification is configured, enter the verification code sent to your email

### Registration

1. Click **"Register with invitation code"** on the login page
2. Enter:
   - **Invitation code** (obtained from an admin)
   - **Username** (minimum 2 characters)
   - **Password** (minimum 6 characters)
   - **Confirm password**
   - **Email** (optional)
3. Click **Submit** to register
4. After successful registration, you'll be redirected to the login page

---

## Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| **Enter** | Chat input | Send message |
| **Shift+Enter** | Chat input | New line |
| **/** | Chat input | Open slash command autocomplete |
| **@** | Crew input | Open role mention autocomplete |
| **Escape** | Image preview | Close preview overlay |
| **Ctrl+P** | Files tab | Quick open file search |
| **Ctrl+Scroll** | Files tree | Adjust font size |
| **Arrow keys** | Autocomplete | Navigate options |
| **Tab** | Autocomplete | Select option |
