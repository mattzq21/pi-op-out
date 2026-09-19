# Piop

A native Tauri interface for the Pi coding agent, with persistent local or SSH-hosted `pi --mode rpc` sessions.

## Features

- Streaming chat with Markdown, thinking content, tool progress, attachments, and context/cache usage
- Pause/resume, stop, retry, steering, and queued follow-ups
- Project-grouped conversation history, search, split panes, and Git worktree branching
- Model and thinking-level controls, slash commands, and a project terminal
- Named [agent profiles](extensions/piop-define-agents/README.md) with models, instructions, and tool, skill, and MCP server selections
- Settings for tools, skills, remote hosts, MCP servers, and compaction
- Pi extension dialogs, notifications, status lines, and widgets
- Bundled [web search](extensions/piop-codex-web-search/README.md)

## Android

```bash
# Start desktop and its development daemon
npm ci
npm run tauri dev
```

```bash
# In another terminal: expose the same daemon to mobile
sudo tailscale serve --bg "unix:$HOME/.piop-dev/tailscale.sock"
tailscale serve status

# Build and install on a USB-connected phone with USB debugging enabled
npm run android:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

```text
# On the phone: connect Tailscale using the host's account, then open Piop
# Enter the Serve hostname with wss:// and tap Connect to workspace
wss://your-host.your-tailnet.ts.net
```

## Run

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and Pi, then run:

```bash
npm run tauri dev
```
