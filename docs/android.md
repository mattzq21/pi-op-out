# Piop for Android

The Android companion packages the shared Piop React interface with Capacitor. It connects over an authenticated WebSocket to the existing Tauri backend. Pi, Node, Git, SSH, MCP servers, credentials, project files, and saved conversations remain on your computer. Android does not execute development tools locally.

## Build and install

Use Node 22 or newer, JDK 21, and the Android SDK with platform 36 and build tools 36.0.0. Android 7 (API 24) is the minimum supported OS. Install the SDK through [Android Studio](https://developer.android.com/studio); see the [Capacitor environment guide](https://capacitorjs.com/docs/getting-started/environment-setup).

```sh
npm ci
npm run android:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Set `JAVA_HOME` and `ANDROID_HOME` to your installed JDK and SDK. Alternatively, `npm run android:open` builds/syncs the mobile assets and opens Android Studio. The `Android APK` GitHub Actions workflow also builds a downloadable debug APK. Production distribution requires signing a release with your own Android signing key. No signing secrets are stored in this repository.

`npm run build:mobile` writes to `dist-mobile`; the desktop build continues to use `dist`. Never copy the desktop `dist` into the Android app. `npm run android:sync` rebuilds and copies the correct assets and plugins.

## Enable the host

Build or run this version of the **desktop** Piop app on the computer containing your projects and authenticated Pi installation. The host needs a graphical session; this is not a standalone headless server.

Set a high-entropy pairing token before starting Piop, for example:

```sh
export PIOP_MOBILE_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$PIOP_MOBILE_TOKEN"
npm run tauri dev
```

Copy the printed token to the phone. It grants access to this host's Piop commands, including terminal commands and project modifications. The endpoint is disabled when the variable is absent. Tokens shorter than 32 characters cause startup to fail. Restart the host with a new token to revoke existing access.

The listener defaults to `127.0.0.1:9847`. Put a TLS reverse proxy in front of it, with a certificate trusted by Android. For example, a Caddy configuration for a hostname you control:

```caddyfile
piop.example.com {
    reverse_proxy 127.0.0.1:9847
}
```

Use your own hostname and appropriate private network/firewall configuration. On the phone, enter `wss://piop.example.com` and the pairing token. TLS and the token are required; the Android client rejects plain `ws://` and URLs containing credentials. The default loopback listener should remain behind the proxy. `PIOP_MOBILE_BIND` can override its address for deployments with a separate trusted proxy.

The host URL is remembered on the phone. The pairing token stays in memory and must be entered again after the app process exits. Pi/provider credentials are never sent to Android.

## Mobile behavior

- The shared interface provides streaming chat, Markdown, attachments from the Android file picker, pause/resume/stop, retry, queued follow-ups, models, thinking levels, agents, tools, skills, MCP configuration, extension dialogs, history/search, worktrees, diffs, storage, and terminals.
- The top navigation opens conversations, starts a chat, opens settings, or disconnects from the host. Android Back closes a dialog, returns from settings, closes the terminal, or toggles conversations.
- Enter inserts a newline on the phone. Tap Send to submit; while streaming, tap Steer for a steering message. Queue controls remain available by touch.
- Split conversations stack vertically on narrow screens. Opening a separate desktop window opens that conversation in the current Android view. “Open directory” opens the host's file manager; the project picker browses host directories inside Android.
- Terminal special keys are available in a touch toolbar. Terminal processes belong to the connection and close when it disconnects.
- Voice uses the phone microphone and speaker over WebRTC. Grant microphone permission when asked. The host authenticates the voice session using its existing Codex login and relays transcripts/delegation events. The phone never starts the host microphone. Actual voice availability depends on the host account's voice access.
- On connection loss, Piop returns to the connection screen. Reconnect and reopen the saved conversation to recover its history. In-flight commands are never automatically replayed because they may have already completed. Unsent drafts are not durable across app restarts. Keep the host running and awake; background execution and uninterrupted mobile voice calls are not guaranteed by Android.

## Validation

```sh
npm run test:mobile
CHROME_PATH=/path/to/chrome npm run test:mobile:ui
npm run build:mobile
npm run android:sync
```

The remote transport tests cover TLS validation, pairing, correlated responses, event subscription, command errors, and disconnect handling. Native Rust authentication tests run with `cargo test --manifest-path src-tauri/Cargo.toml --lib mobile::tests` after building the normal host prerequisites. If the desktop voice helper dependencies are unavailable, the host Rust code can be checked without bundling that executable:

```sh
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Before distribution, test a real Android device against a real TLS host: streaming and reconnect after airplane mode, microphone permission denial and a voice call, keyboard resize/rotation, file attachments, terminal input, and worktree creation. Browser transport tests do not validate device audio or Android lifecycle behavior.
