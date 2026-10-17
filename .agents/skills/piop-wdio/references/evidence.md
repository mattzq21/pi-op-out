# Evidence behind this skill

Extracted on 2026-10-02 from local Codex rollout JSONL files associated with Piop in the read-only thread index. The search found 42 candidate traces containing WDIO calls or launcher-related tool activity. Counts included historical project variants and launcher inspections; they are not a count of successful sessions. The operational guidance comes from the concrete calls/results below, not the mere presence of WDIO tool descriptions.

These are historical observations, not instructions to replay. Ports, IDs, paths, credentials, model names, and build commands must be rediscovered in the current task.

## Representative traces

All filenames below are under `/home/matt/.codex/archived_sessions/`; line numbers identify JSONL records.

| Trace | Observed evidence and consequence |
| --- | --- |
| `rollout-2026-09-30T21-33-23-01a0f3ce-ae95-72d2-8406-405655986b7e.jsonl` | Lines 47–51 show dependency and daemon startup failures; 111–135 show a fixture daemon, manual launcher, external attachment, and successful element discovery. Lines 918–925 show explicit detach, SIGINT to the owned launcher, and shutdown of the owned daemon. These establish launch/attach/cleanup ownership. |
| `rollout-2026-10-01T17-18-34-01a0f80b-bd5b-7b62-9f83-4f573f9a304a.jsonl` | Lines 22–31 show `Invalid URL` with incomplete attachment parameters and refusal on an assumed port. Lines 175–188 show a new manual launcher, its actual ephemeral endpoint, successful attachment, and DOM inspection. The earlier supplied ID was also found in Piop conversation files. Do not treat a chat ID as a WebDriver ID. |
| `rollout-2026-09-25T10-55-41-01a0d7c7-0d23-7041-aa0c-6900ce4ba4ec.jsonl` | Lines 74–117 show a missing package, dependency installation, launcher output, and attachment. Lines 124–158 show attachment succeeded while the app displayed a daemon/settings error; Chromium session logs were unavailable. Lines 323–399 show successful debug attachment and UI interaction. Lines 538–549 demonstrate WDIO text selectors failing in `querySelector` and recovery using CSS/DOM filtering. Lines 8134–8137 show Electron scripting is unavailable on the Tauri session. |
| `rollout-2026-09-25T10-54-58-01a0d7c6-64d0-7843-a3d5-391f4bc3a615.jsonl` | Lines 577–582 show a nonexistent field selector failing after a menu action; 3962–3966 and 4259–4262 show application validation messages returned as script errors. Refresh UI evidence before diagnosing an app failure or repeating an action. |
| `rollout-2026-09-22T14-50-44-01a0c92b-2afb-75b1-b9aa-eb7df1e7afa3.jsonl` | Lines 1095–1101 show an invalid combined CSS/text selector; 1132–1136 show Tauri window-resize permission limits; 1580–1585 show a directly launched app with explicit WebDriver port and a successful external `start_session`. This is an alternative to the helper, not a reason to create a second session after helper startup. |

The September 25 notes interactions also used synthetic `KeyboardEvent` dispatch (for example lines 441 and 8179 in the `01a0d7c7` trace). These exercised page event handlers; the skill deliberately does not equate them with native keyboard or clipboard coverage.

## Current implementation cross-check

Checked in `/home/matt/.codex/worktrees/7fda/piop` when authoring; resolve these paths against the active checkout on later runs:

- `scripts/wdio-manual.mjs`: embedded provider, ephemeral loopback port, `PI_E2E_BINARY`, printed attachment data, signal-driven cleanup; no fixture setup.
- `.codex/start-wdio-mcp.sh`: launches WDIO MCP; explicitly requires attachment to the session printed by the manual launcher.
- `package.json`: separate build/manual/test-run commands; the build uses an E2E frontend and builds `piopd` with `daemon,test-home`.
- `clients/desktop/Cargo.toml` and `clients/desktop/src/desktop.rs`: `webdriver` feature enables the embedded plugin and app home override.
- `wdio.conf.ts`, `test/isolated-node-home.mjs`, and `clients/desktop/src/backend/environment.rs`: fixture environment, Node home override, and daemon's feature-gated `PIOP_TEST_HOME` support.
- `clients/desktop/src/daemon_endpoint.rs` and `clients/desktop/src/desktop_daemon.rs`: release/debug endpoint location, companion executable, automatic development daemon build, and connection behavior.
- `scripts/tauri.mjs`, `scripts/build-daemon.mjs`, and `scripts/window-placement.mjs`: dynamic dev URL, daemon build/startup side effects, and monitor-specific placement.
- `src/App.tsx` and `src/lib/nativeTransport.ts`: E2E controls and mode-dependent temporary-chat behavior.

Live WDIO tool schemas were also inspected for attachment, session creation/closure, DOM execution, element discovery, text input, and screenshot behavior. No app sessions, builds, or test suites were run to create this skill.
