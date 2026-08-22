# Pi Desktop

A web-first Tauri interface for the Pi coding agent. The desktop build controls a persistent local `pi --mode rpc` process; the browser build uses a deterministic preview transport so the complete interface can be developed without model usage.

## What is included

- Streaming chat with Markdown, thinking content, tool progress, abort, retry, steering, follow-ups, and queued-message state
- Project-grouped conversation history, search, switching, rename, clone, compaction, HTML export, branch creation, and a session-tree/statistics inspector
- Runtime model and thinking-level controls, slash-command discovery, text/image attachments, and direct project shell execution
- Pi extension UI support for prompts, confirms, selects, editors, notifications, status lines, widgets, titles, and editor text
- Settings for themes, completion notifications, retry/compaction behavior, queue modes, default model, tools, discovered/custom skills, and MCP servers
- A dependency-free MCP stdio bridge that discovers server tools and registers them as namespaced Pi tools

## Run in the browser

```bash
npm install
npm run dev
```

The browser build includes seeded conversations and a streaming test agent, so chat, branching, session search, model controls, attachments, slash commands, terminal, and settings can be exercised without spending model tokens.

## Run as a desktop app

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and make sure `pi` is available on `PATH`, then run:

```bash
npm run tauri dev
```

The native launcher also checks `~/.local/bin/pi`, `~/.npm-global/bin/pi`, and `~/.bun/bin/pi`. Set `PI_DESKTOP_PI_PATH` to use another executable.

Authenticate Pi before starting the desktop app with Pi's normal `/login` flow or provider environment variables. Credentials remain in Pi's own auth store and are never copied into this app's settings.

Saving native settings restarts the managed Pi process while preserving the active project and session. Enabled tools, skills, default model/thinking level, and MCP configuration are applied at startup.

MCP servers currently use stdio commands. Arguments support shell-style quoting, but the command is launched directly without a shell. MCP tools appear in Pi as `mcp_<server>_<tool>`.

## Verify

```bash
npm test
npm run build
cd src-tauri && cargo check
```
