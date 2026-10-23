# piop-openai-fast-mode

Local fork of John Munson's pi-openai-fast-mode 0.3.0, distributed under the original MIT license in LICENSE.

Adds gpt-6-astra for both OpenAI and OpenAI Codex, and publishes Fast mode on/off directly to piop in RPC mode. The Desktop toggle is hidden for unsupported models. The original terminal indicator is preserved.

Commands: /fast, /fast on, /fast off, /fast toggle. The toggle and priority request behavior are unchanged.

piop bundles and loads this extension automatically for local and remote sessions, including `npm run tauri dev`.

For standalone Pi use, install this directory at ~/.pi/agent/extensions/piop-openai-fast-mode. Pi discovers src/index.ts through package.json. Remove npm:pi-openai-fast-mode from Pi's package settings and uninstall that npm package to avoid registering /fast twice.

User settings are saved in ~/.pi/agent/extensions/piop-openai-fast-mode/config.json; project settings use .pi/piop-openai-fast-mode/config.json. When migrating, copy the original config.json to the corresponding new location to preserve the toggle. On startup, the fork refreshes supported targets while preserving enabled.

This is a local package; npm updates to the original package do not replace it. Edit this repository copy and copy the changed source files to the installed directory, preserving its config.json. Reload Pi sessions after updating source files.
