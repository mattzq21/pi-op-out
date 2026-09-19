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

The Android app connects to the same Piop daemon as desktop over Tailscale. Projects, provider credentials, Pi workers, and conversations stay on the host. The desktop window can be closed while the daemon continues running.

### Prerequisites

- Build machine: Node.js 22+, JDK 21, Android SDK platform 36 and platform-tools (`adb`). Set `JAVA_HOME` and `ANDROID_HOME` for your installation; see the [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).
- Host: Linux with systemd, Pi and its runtime dependencies, and Tailscale running as the root-managed `tailscaled.service`. Building the daemon also requires Rust.
- Phone: Android 7+ with Tailscale installed and connected. Sign the phone and host into the **same Tailscale account**. Tagged hosts are not supported by the current mobile authentication.

Run the following commands from the repository root.

### 1. Start the host used by desktop

For a development desktop, run:

```bash
npm ci
npm run tauri dev
```

Desktop starts or reuses the development daemon. To run that daemon without opening desktop, use this alternative:

```bash
npm run build:extensions
node scripts/build-daemon.mjs --debug
./src-tauri/target/debug/piop-daemon
```

Run only one daemon per data directory. If one is already running, reuse it; after updating daemon code, restart that existing process to load the rebuild. Restarting disconnects clients and stops its workers.

### 2. Expose that daemon through Tailscale Serve

For the development daemon:

```bash
sudo tailscale serve --bg "unix:$HOME/.piop-dev/tailscale.sock"
tailscale serve status
```

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) supplies HTTPS access within your tailnet. Follow its setup prompt if HTTPS needs enabling. Piop uses verified Tailscale identity; no pairing token, authentication environment variable, or Caddy configuration is needed. Point Serve at the **Unix socket**, since the TCP listener uses token authentication for desktop and other clients.

**Match the desktop's daemon when choosing the socket:**

| Desktop/daemon build | Data directory | Serve target | Local TCP port |
| --- | --- | --- | --- |
| Development (`npm run tauri dev`) | `~/.piop-dev` | `unix:$HOME/.piop-dev/tailscale.sock` | 9848 |
| Release (`npm run daemon`) | `~/.piop` | `unix:$HOME/.piop/tailscale.sock` | 9847 |

For release, run `npm run daemon` instead of the development host commands and use the release socket in the Serve command. These data directories are separate: pointing mobile at release while desktop runs development shows different chats, groups, and archive state. The Android APK's debug/release build does not select the host data directory; the Serve target does.

### 3. Build and install the Android app

Connect the phone over USB, enable USB debugging, and accept the computer's debugging authorization on the phone:

```bash
npm run android:build
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Alternatively, `npm run android:open` syncs the mobile assets and opens Android Studio, where you can select the phone and run the app. Rebuild and reinstall after mobile UI changes; the installed APK does not load the desktop development server.

### 4. Connect from the phone

Open Piop with Tailscale connected. Enter the hostname shown by `tailscale serve status`, replacing `https://` with `wss://`, for example `wss://your-host.your-tailnet.ts.net`. Tap **Connect to workspace**. Keep the host awake and the daemon running.

If connection is rejected, check that both devices use the same Tailscale account, the host's `tailscaled.service` is running, and Serve points to the correct existing socket. After changing the Serve target, disconnect and reconnect mobile. If it displays different chats from desktop, check the development/release table above.

## Run

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and Pi, then run:

```bash
npm run tauri dev
```
