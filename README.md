# Piop

A Tauri-only native interface for the Pi coding agent. It is not a standalone browser application. The desktop app controls persistent local or SSH-hosted `pi --mode rpc` processes.

## What is included

- Streaming chat with Markdown, thinking content, per-response and session-wide cache hit rates, tool progress, pause/resume, abort, retry, steering, follow-ups, and queued-message state
- Project-grouped conversation history, search, switching, rename, clone, branch creation, archiving, and split panes
- Runtime model and thinking-level controls, slash-command discovery, text/image attachments, and direct project shell execution
- Pi extension UI support for prompts, confirms, selects, editors, notifications, status lines, widgets, titles, and editor text
- Settings for retry/compaction behavior, context-window cap, default model, tools, discovered skills, agents, sequences, remote machines, and MCP servers
- Independent [pi-define-agents](extensions/pi-define-agents/README.md) profiles and optional [pi-orchestration](extensions/pi-orchestration/README.md) sequences and delegation
- Live context-window usage gauge in the composer
- Bundled [pi-codex-compaction](extensions/pi-codex-compaction/README.md) for native OpenAI Codex compaction in local, SSH, and delegated sessions
- An MCP SDK-backed stdio/HTTP bridge that discovers server tools and registers them as namespaced Pi tools
- A `read_trace` Pi tool that finds local or remote session JSONL and returns only user prompts and completed assistant messages
- A shared session runtime for primary and split chats, with animation-frame batching for streaming message and tool updates

## Run as a desktop app

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and make sure `pi` is available on `PATH`, then run:

```bash
npm run tauri dev
```

The native launcher also checks `~/.local/bin/pi`, `~/.npm-global/bin/pi`, and `~/.bun/bin/pi`. Set `PIOP_PI_PATH` to use another executable.

Authenticate Pi before starting the desktop app with Pi's normal `/login` flow or provider environment variables. Credentials remain in Pi's own auth store and are never copied into this app's settings.

`npm run dev` only provides the frontend development server consumed by `tauri dev`; opening that server directly in a browser is unsupported.

Agent profiles are included: piop automatically installs and loads `pi-define-agents` locally and on SSH hosts. Orchestration is optional everywhere; install `pi-orchestration` on each machine where you want sequences and delegation, following its README, then reload Pi. Existing combined orchestration configuration is split automatically with a backup. Previously installed orchestration extensions remain installed.

Saving native settings restarts the managed Pi process while preserving the active project and session. Enabled tools, skills, default model/thinking level, and MCP configuration are applied at startup.

Ctrl+left-click a rendered HTTP or HTTPS Markdown link to open it in your default browser. Ordinary clicks keep you in the conversation. Right-click a link for a menu containing only **Copy link**.

While piop is responding, Enter queues a follow-up, and Ctrl+Enter sends a steering message. The send button becomes Pause while running and Resume while paused, with Stop beside it. Shift+Enter inserts a new line. When piop is idle or paused, Enter and Ctrl+Enter send normally.

Pause interrupts the current response and saves completed model turns and tool results in the conversation context. Resume continues from that context with the selected agent's instructions, including after reopening a saved conversation. You can also send a new message while paused. An interrupted partial assistant response remains visible in the transcript but is excluded from the resumed model context.

Codex sessions use the bundled [pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction) extension with the existing auto-compaction setting, context cap, and `/compact` command. Use Pi 0.84.4 or newer on local and remote hosts. Native checkpoints require the Codex model that created them; other providers retain Pi’s standard compaction.

MCP servers can use stdio commands or HTTP endpoints. Stdio arguments support shell-style quoting, but the command is launched directly without a shell. MCP tools appear in Pi as `mcp_<server>_<tool>`.

## Verify

```bash
npm run build
cd src-tauri && cargo check --locked
cd src-tauri && cargo build --locked
```

## End-to-end tests

The acceptance-oriented WebdriverIO suite builds a release-profile native app with its test-only `webdriver` Cargo feature, then exercises user-visible frontend workflows through the embedded Tauri WebDriver provider. The release profile ensures Tauri embeds the tested frontend rather than loading the development server. Normal builds do not register the test plugin, and no external `tauri-driver` is required.

```bash
npm run test:e2e
```

After the binary has already been built, use `npm run test:e2e:run` for faster iterations. Set `PI_E2E_BINARY` to test another binary. Add acceptance scenarios under `test/e2e/specs` and reusable interactions under `test/e2e/pageobjects`.

For runner configuration, native-command mocking, synthetic Pi events, and cleanup behavior, see [WebdriverIO acceptance testing](docs/webdriverio-testing.md).

`/catch-up` resets a secondary Git worktree to the main worktree's current commit,
keeping the secondary worktree's branch. It discards tracked local changes; it does
not copy uncommitted changes from the main worktree or fetch from a remote. In the
main worktree it does nothing. Stop or pause a running agent before invoking it.
Catch-up is blocked with an error if another Pi UI agent is working in the same
worktree on that host. This is checked both before and after confirmation.
A confirmation dialog shows the worktree and target commit before resetting.
Cancelling leaves the worktree and conversation unchanged. The result appears as
a centered system message in the conversation.

## Compatibility

The app and executable are named `piop`. Sessions, archived conversations, and Git snapshots use `~/.piop` on local and remote machines. When upgrading from a version that used `~/.pi-desktop`, copy its contents into `~/.piop` while the app is closed; resolve any existing destination files before copying. The app does not merge or delete the old directory automatically. The settings identifier (`dev.pi.desktop`), browser-storage keys, and extension protocol IDs remain stable. `PIOP_PI_PATH` selects the upstream Pi executable; the previous `PI_DESKTOP_PI_PATH` override remains supported. The upstream Pi CLI and third-party Pi extension package names are unchanged.
