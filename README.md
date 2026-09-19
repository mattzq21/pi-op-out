# Piop

## Daemon



```bash
npm ci
npm run daemon:dev
```

## Android

```bash
sudo tailscale serve --bg "unix:$HOME/.piop-dev/tailscale.sock"

npm run android:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Desktop

```bash
npm install
npm run tauri dev
```
