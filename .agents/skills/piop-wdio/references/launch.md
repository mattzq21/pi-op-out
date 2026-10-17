# Launching the Piop session

Read this before starting a new session. Paths below are relative to the **active Piop checkout**. Recheck the named implementation files if the branch has changed; old traces contain superseded commands and binary names.

## Select a matching build

The current manual launcher is `npm run test:e2e:manual`, equivalent to `node scripts/wdio-manual.mjs`. It starts the app, creates an embedded WebDriver session, prints attachment JSON, and waits for SIGINT/SIGTERM. It does not run the E2E suite.

Its default app is `target/e2e/release/piop` (`piop.exe` on Windows). `PI_E2E_BINARY` overrides that path. The app must have been built with the Cargo `webdriver` feature. For isolated state, its companion daemon must have `daemon,test-home`; the current binary name is `piopd`, not the historical `piop-daemon`.

Reuse a suitable existing binary when its revision and build mode match the requested check. If a build is necessary and permitted by the current task/instructions, the repository's `npm run test:e2e:build` builds both binaries and frontend assets. Inspect its definition first: it includes TypeScript checking and an E2E-mode frontend, but does not execute the test suite. Do not run `npm test`, `npm run test:e2e`, or `test:e2e:run` merely to obtain a manual session. Respect instructions restricting builds or checks.

E2E-mode assets expose `E2E responses` and `E2E calls` controls and can change temporary-chat behavior. State the build mode in your result. Injected responses do not establish a live model/backend round trip. Choose a normal frontend when that distinction matters.

For an existing debug binary, use `PI_E2E_BINARY` with its absolute path. Debug builds use `.piop-dev` and can depend on a Vite server at the URL compiled into the binary. `npm run tauri -- dev` currently chooses a dynamic Vite port and can rebuild/stop the development daemon; it is not a harmless substitute for the manual launcher. Recheck `scripts/tauri.mjs` before using it. For an isolated debug run, explicitly start a matching daemon built with `test-home` before the client, avoiding its automatic daemon rebuild without that feature.

## Isolate new exploratory runs

`wdio.conf.ts` prepares an isolated fixture, authentication copies, a daemon, and cleanup for automated runs. **The manual launcher does none of that.** Supply the environment yourself when the requested interactions create or change state.

Use a unique fixture directory, and record its absolute path so separate terminal calls can use the same value:

```bash
piop_fixture=$(mktemp -d /tmp/piop-wdio.XXXXXX)
printf '%s\n' "$piop_fixture"
```

Apply this environment to **both** the separately launched daemon and manual launcher. Repeat it in each shell call, substituting the recorded path; shell exports do not automatically carry between tool calls:

```bash
piop_fixture=/absolute/path/printed/above
export PIOP_TEST_HOME="$piop_fixture"
export PI_CODING_AGENT_DIR="$piop_fixture/.pi/agent"
export XDG_CONFIG_HOME="$piop_fixture/config"
export XDG_DATA_HOME="$piop_fixture/data"
export XDG_CACHE_HOME="$piop_fixture/cache"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PWD/test/isolated-node-home.mjs"
export PIOP_MOBILE_BIND=127.0.0.1:0
unset PIOP_DAEMON_URL PIOP_DAEMON_TOKEN
```

`PIOP_TEST_HOME` redirects the Rust app/daemon only in builds with the appropriate features. The Node preload redirects `os.homedir()` for child processes. The XDG paths cover client preferences and caches; `PI_CODING_AGENT_DIR` covers agent configuration. Do not replace `HOME`, `CARGO_HOME`, or `RUSTUP_HOME` with a scratch path.

For checks needing authentication, follow the current fixture setup in `wdio.conf.ts` to prepare only the needed agent files within the fixture, honoring file-edit rules. Keep their contents out of tool output and reports. Checks of UI validation and navigation may not need credentials. Use a disposable project inside the fixture for worktree, rename, trash, or branching experiments. Do not reinterpret a requested check of existing user state as an empty fixture check.

Start the matching fixture daemon in a persistent terminal with the environment above:

```bash
target/release/piopd --serve
```

For a debug app use the matching debug daemon. Wait for startup and publication of its fixture endpoint before starting the app. Release endpoints live under `$PIOP_TEST_HOME/.piop`; current debug endpoints live under `$PIOP_TEST_HOME/.piop-dev/daemons/<worktree-hash>`. Inspect `clients/desktop/src/daemon_endpoint.rs` if discovery differs. The endpoint JSON contains a token: check readiness without dumping credentials.

An “already running” message requires checking the existing daemon's identity, build, and environment. Do not kill another task's daemon or reuse it solely because a port is open.

## Start the launcher and retain ownership

In another persistent terminal, repeat the same fixture environment and run:

```bash
npm run test:e2e:manual
```

Or select a verified debug binary:

```bash
PI_E2E_BINARY="$PWD/target/debug/piop" node scripts/wdio-manual.mjs
```

Use `exec_command` with a PTY and a short initial yield (for example `tty: true`, `yield_time_ms: 1000`), then `write_stdin` to collect startup output. Retain the terminal session ID for cleanup. Wait for the **final attachment JSON**, not just “WebDriver server ready.” Record separately:

- The daemon and launcher terminal IDs/PIDs this task owns.
- The selected binary, fixture directory, and frontend server if any.
- The printed WebDriver `sessionId` and `webdriverConfig`.

The current launcher allocates a free loopback port. On Linux it selects X11 and window bounds through `scripts/window-placement.mjs`; these bounds are specific to the user's monitor arrangement. A screenshot can reveal an unexpected size or location. The launcher supplies its own `PI_WINDOW_BOUNDS`, so setting that variable outside it does not necessarily override placement. Do not rewrite production window configuration to drive a manual check.

Attach through WDIO as shown in `SKILL.md`, inspect the app, and leave the launcher alive until finished. The MCP configuration may point at the main checkout even while this task uses a worktree; that does not select the application binary for you.

## Direct launch: only when the helper is unsuitable

The traces also show a webdriver-enabled app launched directly with `TAURI_WEBDRIVER_PORT` set to a verified free port, followed by:

```js
text(await tools.mcp__wdio__start_session({
  platform: "browser",
  provider: "external",
  webdriverConfig: { hostname: "127.0.0.1", port: 12345, path: "/" },
  capabilities: { browserName: "tauri" }
}));
```

Replace the example port with the chosen live port. This creates the WebDriver session on an app that is already running; it does not launch Piop. Recheck the installed embedded driver's environment contract before using this route. Keep the same fixture, daemon, and ownership rules. Prefer the existing helper unless direct launch solves an actual need such as custom initial window bounds. Never call `start_session` on top of the session already created by `wdio-manual.mjs`.

After an app restart, both session identity and endpoint may change. Reattach with current output. After detaching the MCP, stop only the task's recorded launcher/daemon/server processes, preserving any reproduction artifacts the user needs.
