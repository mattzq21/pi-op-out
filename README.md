# Piop

A native Tauri interface for the Pi coding agent, with persistent local or SSH-hosted `pi --mode rpc` sessions.

## Features

- Streaming chat with Markdown, thinking content, tool progress, attachments, and context/cache usage
- Pause/resume, stop, retry, steering, and queued follow-ups
- Project-grouped conversation history, search, split panes, and Git worktree branching
- Model and thinking-level controls, slash commands, and a project terminal
- Named [agent profiles](extensions/pi-define-agents/README.md) with models, instructions, and tool, skill, and MCP server selections
- Settings for tools, skills, remote hosts, MCP servers, and compaction
- Pi extension dialogs, notifications, status lines, and widgets
- Bundled [Codex compaction](extensions/pi-codex-compaction/README.md) and [web search](extensions/pi-codex-web-search/README.md)

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

The launcher checks `~/.local/bin/pi`, `~/.npm-global/bin/pi`, and `~/.bun/bin/pi` before falling back to `PATH`. Set `PIOP_PI_PATH` to use another executable.

Authenticate Pi with its `/login` flow or provider environment variables before starting Piop. Credentials stay in Pi's auth store.

`npm run dev` starts only the frontend server; use `tauri dev` to run the desktop app.

## Conversations

While Piop is responding, Enter queues a follow-up and Ctrl+Enter sends a steering message. When idle or paused, either sends normally. Shift+Enter inserts a new line.

Pause saves completed model turns and tool results. Resume continues from that context, including after reopening a saved conversation. Interrupted partial responses remain visible but are excluded from the resumed model context.

Ctrl+click an HTTP or HTTPS Markdown link to open it in your browser. Right-click to copy the link.

Select an agent in the conversation and configure profiles in Settings → Agents. Piop installs the bundled agent extension locally and on SSH hosts.

### Branching and worktrees

- `/branch-off [number]` branches the conversation in its current directory.
- `/worktree [number] [name]` creates a Git worktree and branches the conversation into it. Omit the name to open the name dialog.

The number counts backwards through completed responses: `0` (the default) is the latest, `1` is the previous response. Examples: `/worktree 2 experiment` or `/worktree experiment`. Stop or pause the agent before either command.

**Branch before this prompt**, beside a user message, opens a new worktree with that prompt's starting files and conversation history. Piop retains the latest 10 checkpoints per conversation; the original conversation can keep running. See [checkpoint storage and limits](extensions/pi-project-files-watch/README.md#before-prompt-checkpoints).

`/catch-up` resets a secondary worktree's current branch to the main worktree's commit after confirmation. It discards tracked local changes and does not copy the main worktree's uncommitted changes or fetch from a remote. Stop or pause the agent first; the command is also blocked if another Piop agent is working in that worktree. In the main worktree, it does nothing.

## Storage and integrations

Saved conversations live in `~/.piop/sessions` on each host; archived conversations live in `~/.piop/archived`. Pi CLI sessions in `~/.pi/agent/sessions` are not included in Piop history. The `read_trace` tool extracts user prompts and completed assistant messages from Piop's active or archived session files.

`/btw` side conversations use temporary session files. Closing their pane removes those files; they do not appear in saved history.

Codex compaction uses the auto-compaction setting, context cap, and `/compact` command. Pi 0.84.4 or newer is recommended. Native checkpoints require the Codex model that created them; other providers use Pi's standard compaction.

MCP servers can use stdio commands or HTTP endpoints. Stdio arguments support shell-style quoting, but commands run without a shell. Tools appear in Pi as `mcp_<server>_<tool>`.

## End-to-end tests

The WebdriverIO suite builds and exercises the native app with the test-only `webdriver` Cargo feature:

```bash
npm run test:e2e
```

Use `npm run test:e2e:run` to reuse an existing test build, or set `PI_E2E_BINARY` to select another test binary. See [WebdriverIO acceptance testing](docs/webdriverio-testing.md) for setup and test authoring.
