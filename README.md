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

Piop includes an Android companion that connects to your computer over an authenticated TLS connection. It reuses the desktop interface with mobile navigation, touch controls, remote terminals, and phone microphone/speaker support. See [Android build and host setup](docs/android.md).

```sh
npm run android:build
```

## Run

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and Pi, then run:

```bash
npm run tauri dev
```
