# WebdriverIO acceptance testing

The acceptance suite exercises the native Tauri application with WebdriverIO. It builds the frontend in E2E mode, builds the native binary with Cargo's release profile and the test-only `webdriver` feature, and connects through the embedded Tauri WebDriver provider. Normal application builds do not register the test plugin, and the suite does not require a separate `tauri-driver` process.

## Run the suite

Build the application and run every acceptance spec:

```bash
npm run test:e2e
```

For separate build and run steps:

```bash
npm run test:e2e:build
npm run test:e2e:run
```

The default executable is `src-tauri/target/release/pi-desktop` (`pi-desktop.exe` on Windows). Set `PI_E2E_BINARY` to run the specs against another executable.

Each run asks the operating system to allocate an available ephemeral loopback port, then passes that port to the embedded WebDriver server. An abandoned process on a previous run's port therefore does not block the next run.

The suite includes a real provider call. Before starting, it verifies that Pi's installed model catalog and authentication contain the selected provider. The default is `openai-codex/gpt-5.6-luna`; override it with `PI_E2E_ACTUAL_MODEL`:

```bash
PI_E2E_ACTUAL_MODEL=provider/model npm run test:e2e
```

The runner uses one application instance and captures native backend logs. Specs have a 60-second timeout; WebDriver commands use a 10-second wait timeout.

## Agent-driven sessions

When using the WebdriverIO MCP, do not enable trace recording. Omit the `trace` argument or set `trace: false` when starting or attaching to a session. Trace recording creates screenshot-heavy archives in `.trace/` that are not needed for normal agent operation.

## Add a scenario

Acceptance specs live in `test/e2e/specs`. Reusable selectors and user interactions belong in `test/e2e/pageobjects/app.page.ts`.

Prefer selectors based on stable accessible names, for example:

```ts
const composer = $('textarea[aria-label="Message Pi"]');
const send = $('button[aria-label="Send message"]');
```

Use the shared page object where it already exposes the control or interaction. The suite currently uses Mocha and WebdriverIO's `expect` assertions.

## Mock native commands

The E2E frontend renders two hidden text areas:

- `textarea[aria-label="E2E responses"]` stores a JSON object of mocked responses.
- `textarea[aria-label="E2E calls"]` records native calls as `{ command, args, mocked }` objects.

Initialize the call field to `[]` before an interaction. Response keys are the Tauri command name, except Pi RPC commands, which use `pi_command:<type>`:

```ts
await $('textarea[aria-label="E2E calls"]').setValue("[]");
await $('textarea[aria-label="E2E responses"]').setValue(JSON.stringify({
  list_sessions: [],
  "pi_command:set_model": {},
  "pi_command:prompt": { error: "Prompt failed" },
}));
```

A mocked object containing `error` rejects the frontend call with that message. If a response key is absent, the command falls through to the real Tauri backend. Keep the response map limited to the behavior the scenario needs so that native fallthrough is intentional.

The current helpers `mockBackend`, `backendCalls`, `updateBackendResponse`, and `resetBackend` are defined near the top of `test/e2e/specs/conversation.acceptance.spec.ts`.

## Emit Pi events

Scenarios can emit an event through Tauri when mocked state needs a matching runtime notification:

```ts
await browser.execute(async (payload) => {
  await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "pi://event",
    payload,
  });
}, { type: "session_switched" });
```

Use normal WebDriver interactions for user behavior. Use `browser.execute` for bridge setup and synthetic native events that cannot originate from a mocked command response.

## Test cleanup

Before the run, the configuration records existing session files, marked temporary test projects, and the orchestration configuration. On completion it:

- removes new test session files only when their headers identify a marked temporary test project;
- removes new temporary project directories containing `.pi-e2e-test`; and
- restores the orchestration configuration to its pre-run contents, or removes it if it did not previously exist.

This cleanup is deliberately selective. A scenario that writes any other native state must restore that state itself.
