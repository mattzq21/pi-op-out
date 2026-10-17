# Launching the Piop session

Read this before starting a new session. Paths below are relative to the **active Piop checkout**. Recheck the named implementation files if the branch has changed; old traces contain superseded commands and binary names.

## What the launcher does

`scripts/tauri-webdriver.py` in this skill is the only supported launcher. It needs Linux, `WebKitWebDriver` and `npx`. It:

1. Reserves two free loopback ports and starts `WebKitWebDriver --target=127.0.0.1:<inspector port>`.
2. Runs the app command in `--project` with `WEBKIT_INSPECTOR_SERVER` set to that port. The default command is `npm run tauri dev` (`scripts/tauri.mjs`): a debug build, a Vite server and the worktree's development daemon. Pass another command after `--` to replace it.
3. Creates a WebDriver session, starts `@wdio/mcp`, attaches it to that session, and prints the attachment JSON.

No Cargo feature or special build is needed: the WebKit inspector server is part of WebKitGTK. Do not run `npm test` or `npm run test:e2e` to get a manual session; `test:e2e` builds a separate E2E app for the automated suite only.

`npm run tauri dev` builds the frontend and Rust app and can rebuild or restart the worktree's development daemon. The launcher holds `target/.piop-daemon-launch.lock` during startup so that parallel launchers on the same worktree wait for each other. The default `--timeout` is 600 seconds; increase it for a cold build.

## Profiles

- `--shared-profile` (default): uses your normal home, provider credentials and development daemon. Use it to check existing user state.
- `--isolated-profile`: sets `HOME`, `PI_CODING_AGENT_DIR` and the XDG folders to `<instance>/home`, clears `PIOP_TEST_HOME`, `PIOP_DAEMON_URL`, `PIOP_DAEMON_TOKEN` and `PI_CODING_AGENT_SESSION_DIR`, and binds the mobile server to `127.0.0.1:0`. `CARGO_HOME` and `RUSTUP_HOME` keep their real values. There are no provider credentials, so model calls fail. Use it for checks that create or change state.

For checks that need credentials in an isolated profile, copy only the needed agent files into `<instance>/home/.pi/agent`, honoring file-edit rules. Keep their contents out of tool output and reports. Use a disposable project inside the instance folder for worktree, rename, trash or branching experiments. Do not reinterpret a requested check of existing user state as an empty profile check.

Debug daemon endpoints live under `~/.piop-dev/daemons/<worktree-hash>` of the selected home. Inspect `clients/desktop/src/daemon_endpoint.rs` if discovery differs. The endpoint JSON contains a token: check readiness without dumping credentials. An "already running" message requires checking the existing daemon's identity and build. Do not kill another task's daemon.

## Start the launcher and retain ownership

```bash
python3 <skill>/scripts/tauri-webdriver.py --project "$PWD" [--isolated-profile]
```

Use `exec_command` with a PTY and a short initial yield (for example `tty: true`, `yield_time_ms: 3000`), then `write_stdin` to collect output. Retain the terminal session ID for cleanup. Stderr first prints the instance folder (`/tmp/tauri-webdriver-<uid>/instance-*`). Wait for the **attachment JSON** on stdout and the `Ready:` line. Record:

- The launcher terminal ID and `launcherPid`.
- The `sessionFile`, `profileHome`, `logs` paths (`app.log`, `driver.log`, `mcp.log`, `webdriver.log`) and `runtime.daemonLog`.
- The printed `webdriverSessionId` and `webdriverConfig`.

On failure, read `app.log` first: build errors and daemon errors appear there.

On Linux, `scripts/tauri.mjs` selects window bounds through `scripts/window-placement.mjs` and passes `PI_WINDOW_BOUNDS`; these bounds are specific to the user's monitor arrangement. A screenshot can reveal an unexpected size or location. Do not rewrite production window configuration to drive a manual check.

## Use the attached session

The launcher owns the WDIO MCP process. Call it through the same script:

```bash
python3 <skill>/scripts/tauri-webdriver.py tools --session <sessionFile> [TOOL]
python3 <skill>/scripts/tauri-webdriver.py call --session <sessionFile> get_elements '{}'
```

Only these tools are allowed: `click_element`, `scroll`, `set_value`, `tap_element`, `swipe`, `drag_and_drop`, `execute_script`, `get_elements`, `get_screenshot`. Session tools (`start_session`, `attach_session`, `close_session`, `launch_chrome`) are blocked, so do not create a second session. Screenshots are saved to files; the output gives their paths. `connect --session <sessionFile>` exposes the same MCP over stdio for an MCP client.

After an app restart, the session and ports may change. Use the current launcher output. When finished, send Ctrl+C (SIGINT) to the owned launcher. It detaches MCP, deletes the WebDriver session, stops only processes marked with its instance ID, and keeps the instance folder for logs and reproduction artifacts.
