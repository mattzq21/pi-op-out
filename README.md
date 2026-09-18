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

The launcher checks `~/.local/bin/pi`, `~/.npm-global/bin/pi`, and `~/.bun/bin/pi` before falling back to `PATH`.

Authenticate Pi with its `/login` flow or provider environment variables before starting Piop. Credentials stay in Pi's auth store.

Pi's built-in `opencode-go` provider surfaces OpenCode Go subscription models the same way: store an OpenCode API key through Pi's login flow or set `OPENCODE_API_KEY` in the environment, and models such as `opencode-go/kimi-k2.7-code` appear in the model picker. When the subscription is active, OpenCode Go usage limits appear in the sidebar above the Codex usage limits.

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

Agents can also use `fork_session`, `create_worktree`, and `remove_worktree`. These tools are enabled by default and can be configured per agent in Settings. Their slash commands are:

- `/fork-session [directory]` saves a separate conversation in the current directory or another existing directory. Works in Git and non-Git projects; it does not copy files.
- `/fork-session --worktree name` saves the fork in a new Git worktree, copying current tracked changes and nonignored untracked files.
- `/create-worktree name` creates a Git worktree with current files and runs configured setup scripts, without creating a conversation.
- `/remove-worktree path` removes an unused, clean Git worktree after cleanup scripts, keeping its branch. The agent tool optionally deletes the branch with `deleteBranch: true`, without forcing deletion.

`fork_session` leaves the original agent running and returns a new `hostId` and `sessionId`; use `send_message` to start work in that conversation. It retains history through the latest completed assistant response (or a specified `entryId` on the current branch), excluding the active unfinished turn. If no completed response exists, the fork starts with empty history. A worktree fork uses **current files**, while `/worktree` uses the selected response's saved checkpoint. Worktree operations require Git, run on the session's machine, and preserve piop's checks for dirty worktrees, active conversations, and terminals. Setup failures keep the created worktree and return its path with `setupError`.

**Branch before this prompt**, beside a user message, opens a new worktree with that prompt's starting files and conversation history. Piop retains the latest 10 checkpoints per conversation; the original conversation can keep running. See [checkpoint storage and limits](extensions/piop-project-files-watch/README.md#before-prompt-checkpoints).

`/catch-up` resets a secondary worktree's current branch to the main worktree's commit after confirmation. It discards tracked local changes and does not copy the main worktree's uncommitted changes or fetch from a remote. Stop or pause the agent first; the command is also blocked if another Piop agent is working in that worktree. In the main worktree, it does nothing.

## Storage and integrations

Saved conversations live in `~/.piop/sessions` on each host; archived conversations live in `~/.piop/archived`. Pi CLI sessions in `~/.pi/agent/sessions` are not included in Piop history. The `read_trace` tool extracts user prompts and completed assistant messages from Piop's active or archived session files.

`/btw` side conversations use temporary session files. Closing their pane removes those files; they do not appear in saved history.

 Compaction is handled by Pi's standard lifecycle: automatic compaction, context cap, and `/compact` command.

MCP servers can use stdio commands or HTTP endpoints. Stdio arguments support shell-style quoting, but commands run without a shell. Tools appear in Pi as `mcp_<server>_<tool>`.

## End-to-end tests

The WebdriverIO suite builds and exercises the native app with the test-only `webdriver` Cargo feature:

```bash
npm run test:e2e
```

Use `npm run test:e2e:run` to reuse an existing test build, or set `PI_E2E_BINARY` to select another test binary. See [WebdriverIO acceptance testing](docs/webdriverio-testing.md) for setup and test authoring.
