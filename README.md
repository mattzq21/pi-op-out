# Pi Desktop

A Tauri-only native interface for the Pi coding agent. It is not a standalone browser application. The desktop app controls persistent local or SSH-hosted `pi --mode rpc` processes.

## What is included

- Streaming chat with Markdown, thinking content, per-response and session-wide cache hit rates, tool progress, abort, retry, steering, follow-ups, and queued-message state
- Project-grouped conversation history, search, switching, rename, clone, branch creation, archiving, and split panes
- Runtime model and thinking-level controls, slash-command discovery, text/image attachments, and direct project shell execution
- Pi extension UI support for prompts, confirms, selects, editors, notifications, status lines, widgets, titles, and editor text
- Settings for retry/compaction behavior, context-window cap, default model, tools, discovered skills, agents, sequences, remote machines, and MCP servers
- Live context-window usage gauge in the composer
- A dependency-free MCP stdio/HTTP bridge that discovers server tools and registers them as namespaced Pi tools
- A `read_trace` Pi tool that finds local or remote session JSONL and returns only user prompts and completed assistant messages
- A shared session runtime for primary and split chats, with animation-frame batching for streaming message and tool updates

## Run as a desktop app

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and make sure `pi` is available on `PATH`, then run:

```bash
npm run tauri dev
```

The native launcher also checks `~/.local/bin/pi`, `~/.npm-global/bin/pi`, and `~/.bun/bin/pi`. Set `PI_DESKTOP_PI_PATH` to use another executable.

Authenticate Pi before starting the desktop app with Pi's normal `/login` flow or provider environment variables. Credentials remain in Pi's own auth store and are never copied into this app's settings.

`npm run dev` only provides the frontend development server consumed by `tauri dev`; opening that server directly in a browser is unsupported.

Saving native settings restarts the managed Pi process while preserving the active project and session. Enabled tools, skills, default model/thinking level, and MCP configuration are applied at startup.

MCP servers can use stdio commands or HTTP endpoints. Stdio arguments support shell-style quoting, but the command is launched directly without a shell. MCP tools appear in Pi as `mcp_<server>_<tool>`.

## Verify

```bash
npm run build
cd src-tauri && cargo check --locked
cd src-tauri && cargo build --locked
```

## End-to-end tests

The acceptance-oriented WebdriverIO suite builds a release-profile native app with its test-only `webdriver` Cargo feature, then exercises user-visible frontend workflows through a native Tauri WebDriver provider. Linux uses the external `tauri-driver` and `WebKitWebDriver`; other platforms use the embedded provider. The release profile ensures Tauri embeds the tested frontend rather than loading the development server. Normal builds do not register the test plugin.

```bash
npm run test:e2e
```

After the binary has already been built, use `npm run test:e2e:run` for faster iterations. Set `PI_E2E_BINARY` to test another binary. Add acceptance scenarios under `test/e2e/specs` and reusable interactions under `test/e2e/pageobjects`.

For runner configuration, native-command mocking, synthetic Pi events, and cleanup behavior, see [WebdriverIO acceptance testing](docs/webdriverio-testing.md).
