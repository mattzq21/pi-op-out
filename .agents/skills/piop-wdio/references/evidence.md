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

Resolve these paths against the active checkout on later runs:

- `scripts/tauri-webdriver.py` (this skill): WebKitWebDriver plus `WEBKIT_INSPECTOR_SERVER`, port leases, daemon launch lock, shared or isolated profile, MCP attachment, restricted tool calls and owned-process cleanup.
- `scripts/tests/test_tauri_webdriver_mcp.py` (this skill): exercises the MCP transport against a minimal WebDriver endpoint.
- `package.json` and `scripts/tauri.mjs`: the default `npm run tauri dev` command, dynamic Vite URL and window bounds.
- `scripts/build-daemon.mjs` and `scripts/window-placement.mjs`: daemon build side effects and monitor-specific placement.
- `clients/desktop/src/daemon_endpoint.rs` and `clients/desktop/src/desktop_daemon.rs`: release/debug endpoint location, companion executable, automatic development daemon build and connection behavior.

The traces above used an older launcher (`scripts/wdio-manual.mjs`, a Cargo `webdriver` feature and `PIOP_TEST_HOME`). These no longer exist. Their lessons about selectors, attachment, ownership and cleanup still apply.
