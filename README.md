# Piop

## Daemon

Requires Node.js, Rust, and Pi. Runs independently of desktop:

```bash
npm ci
npm run daemon:dev
```

Uses `~/.piop-dev`, shared with development desktop. For release data, use `npm run daemon` and `~/.piop/tailscale.sock` for Serve. Run only one daemon per data directory.

## Android

Requires Tailscale on the Linux host and phone:

```bash
# In another terminal: expose the daemon to mobile
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

## Desktop

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Desktop reuses the development daemon or starts it if needed:

```bash
npm run tauri dev
```
