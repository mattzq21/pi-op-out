# Piop

A desktop and Android app to run and manage [Pi](https://github.com/earendil-works/pi) coding agent sessions.

Piop gives Pi a graphical interface. One background service (`piopd`) keeps your sessions alive. The desktop app and the Android app connect to it. You can run agents on this computer or on remote computers over SSH, and you can control them from your phone.

**Status:** active development. Version 0.1.0. Linux and Android only.

## Features

- Many Pi sessions in one window, grouped by project folder or Git repository.
- Git worktrees per chat, chat branches, and forks.
- Side chats (`/btw`), subagents, and a review agent in a side pane.
- Agents that send messages to each other (orchestration).
- Remote hosts over SSH.
- Android app that connects to your computer through [Tailscale](https://tailscale.com).
- Plugins and Pi extensions: web search, cost limits, context-window cap, background compaction, and more.

## Install

You need:

- Linux (Debian-based for the `.deb` package)
- [Bun](https://bun.sh) and [Node.js](https://nodejs.org) 26.13 or newer
- [Rust](https://rustup.rs) and the [Tauri system dependencies](https://tauri.app/start/prerequisites/)

Build and install the desktop app:

```sh
git clone https://github.com/mattzq21/piop.git
cd piop
bun run reinstall:desktop
```

This builds a `.deb` package and installs it with `sudo`.

### Android

You also need the Android SDK and Tailscale on the computer and the phone.

```sh
bun run android:build
```

The APK is in `clients/android/app/build/outputs/apk/debug/`.

## Usage

Start Piop from your application menu, or run `piop`. The app starts `piopd` for you.

To run only the background service:

```sh
$ piopd
Usage: piopd <start|stop>

  start  Run the daemon in the background until stopped
  stop   Shut down the running daemon gracefully
```

Piop keeps its data in `~/.piop/`. It installs its own copy of Pi in `~/.piop/pi/`.

## Project layout

| Folder | Contents |
| --- | --- |
| `daemon/src/` | `piopd`, the background service. Each folder is one area; other areas use only its `index.ts`. The top files only start and connect the areas: `main.ts`, `app.ts`, `lifecycle.ts` |
| `daemon/resources/` | Code that runs in Pi's processes, and the storage modules that Pi and `piopd` share. Each folder is one area; other areas use only its `index.ts` |
| `clients/ui/` | Shared user interface (SolidJS) |
| `clients/desktop/` | Desktop app (Tauri) |
| `clients/android/` | Android app (Capacitor) |
| `pi-extensions/` | Pi extensions that Piop loads |
| `plugins/` | Built-in plugins. Other plugins go in `~/.piop/plugins/` |
| `protocol/` | The messages between the clients and `piopd` |
| `docs/adr/` | Design decisions |
| `GLOSSARY.md` | Words that this project uses |

## Development

```sh
bun run tauri dev     # desktop app with live reload
bun run daemon:dev    # debug build of piopd
bun run test:unit     # unit tests
```

See `package.json` for all test commands.

## Contributing

Closed to contributions for now.

## License

No license yet. All rights reserved.
