# Architecture review

## Current layout

The desktop app (a Tauri app, which proxies calls through Rust) and the Android app (which uses a WebSocket) both talk to `piopd`, the daemon. The daemon runs on Bun. Inside it, the `Host` object starts Pi child processes, which run on Node with piop's own Pi extensions. Data is in Pi's JSONL transcript files plus one shared `sessions.sqlite`.

## High

1. **Piop changes Pi's internal code at run time, and the Pi version is not fixed.**
   - [runtime-bridge.cjs](../daemon/resources/runtime-bridge.cjs#L741), [session-storage.mjs](../daemon/resources/piop-storage/session-storage.mjs#L74), `sdk-storage.mjs`, `runtime-availability.cjs` and `runtime-configuration.cjs` replace methods on Pi classes. Some are private methods such as `_appendEntry`, `_rewriteFile`, `_loadEntries` and `_queueFollowUp`.
   - They also import Pi's internal files (`dist/core/output-guard.js`, `dist/extensions/mcp/runtime.js`).
   - [`piExecutable()`](../daemon/src/environment.ts#L22) uses any `pi` it finds on the machine. Nothing checks its version.
   - A Pi update can break storage, the message queue and crash recovery without any error.

2. **Many processes write the same storage and coordinate through files.**
   - These processes all open `sessions.sqlite` and the JSONL files directly: the daemon, each Pi process, the worker threads, the restart candidate (the new daemon during a restart), and one development daemon per checkout (all share `~/.piop-dev`).
   - To coordinate, they use:
     - about six kinds of file locks (`flock`);
     - a local HTTP server for ownership hand-off ([ownership.ts](../daemon/src/host/ownership.ts#L100));
     - a folder of marker files that `fs.watch` monitors to sync settings;
     - transaction journals.
   - Recovery runs on read paths too, for example `restoreRecovery.recover` in `listLocalSessions`.
   - Most of the ~4.6k lines of storage code exist only to make many writers safe.
   - A better design: one writer per storage root (the daemon), with Pi using the broker channel it already has.

3. **No single owner of the database schema.**
   - About 75 `CREATE TABLE IF NOT EXISTS` statements are spread over about 20 files. Some tables are defined in 2–3 files: `goal_text_files`, `temporary_chat_allocations`, `external_transcripts`, `application_settings` and others.
   - Only `session-database.cjs` uses version numbers for schema changes.
   - Many tables store a `record_json` text block, so SQLite cannot check or index the values.
   - Each call opens a new connection and runs the PRAGMA and CREATE statements again ([settings_records.ts](../daemon/src/settings_records.ts#L7)).

4. **File paths are used as database keys.**
   - `settings_records.open(path)` selects the database from `dirname(path)` and the row from `basename(path)`. `settings.json`, `context-cap-settings.json` and `agent-definitions.json` are not real files.
   - In development builds, `context-cap-settings.json` goes into a second, hidden `sessions.sqlite` under `~/.piop-dev/daemons/<key>/extensions/`.
   - The context cap values (context window limits) have 3 copies: in AppSettings, in that record, and in the `context_cap_settings` message sent to Pi.

5. **Each Pi start rewrites about 85 generated files and forces them to disk.**
   - The path is [`configureLocalExtensions`](../daemon/src/pi_launch.ts#L157) → `prepare*` → [`publishPrivate`](../daemon/src/private_fs.ts#L52).
   - When the content has not changed, it still forces the file to disk (`fsync`), and then each parent folder up to `/`. All of this is synchronous on the main event loop.
   - It runs on each `start_pi`, each orchestration `send`, `settle_first_message` and each prompt preview.
   - Running Pi processes read these same files while they are replaced.

6. **Source code is shipped as text and changed with regex.**
   - [resources.ts](../daemon/src/resources.ts) imports about 90 files with `?raw`, from a hand-kept list.
   - `embedFileLock` changes `require`/`module.exports` with string replacement and inserts a base64 data URL.
   - `file-lock.cjs` contains its own code a second time, as a string.
   - The folder mixes `.cjs`, `.mjs`, `.ts` and hand-written `.d.cts` type files.
   - A better design: build one bundle per extension at build time. `fast-mode` and `mcp-bridge` already work this way.

## Medium

7. **Components in the same process talk through an untyped message protocol.** `Daemon` ([daemon.ts](../daemon/src/daemon.ts#L122)) calls `Host` (the object that runs sessions) inside the same process. It still uses:
   - untyped `any` packets and switches on string message types;
   - request IDs, 660 s timeouts and `structuredClone` copies;
   - `connect()` and `loadAppSettings` before almost every call.

   Some code is dead:
   - `connect()` rejects every non-local host, so the per-host map, `connectionConfig` and `remotePort` (always undefined) are never used.
   - There are 46 `hostId` parameters and checks that only assert the value is `'local'`.

8. **Some objects hold too much state.**
   - `Host` exposes about 20 mutable maps (sessions, subscriptions, attachments, `readonlyMap`, gates, and more) that other modules change directly.
   - On the UI side, [`createAppConversations`](../clients/ui/appConversations.ts#L49) returns about 140 fields, and `App.tsx` reads all of them.

9. **The message protocol is defined 3–4 times.**
   - Each side has its own definition: the daemon uses hand-written `argument()` checks, the UI uses zod, Rust has the `piop_protocol` crate, and the Pi side uses typebox.
   - Error texts copy Rust serde messages ([mobile_commands.ts:139](../daemon/src/mobile_commands.ts#L139)), probably left from an older Rust daemon.
   - Some commands are duplicates: `load_app_settings`/`load_host_settings` and `load_settings_change`/`load_host_settings_change`.
   - Two "local-only command" lists differ: one in `peers.ts` and one in `mobile_commands.ts` (`dispatchPeerRequest`).

10. **The transport layers know about specific commands.**
    - Tracking of resources (Pi runtimes, terminals, sign-in flows) is done 3 times: in Rust (`desktop_daemon.rs`), in `RemoteClient.ts`, and in the ID rewriting of `peers.route`. Each knows `start_pi`, `stop_pi`, `start_terminal`, `close_terminal` and the `flowId` of `provider_auth`.
    - Desktop sends each call through Rust and holds a blocking thread for up to 660 s per call. Android uses a WebSocket directly, so the same UI has two transports.

11. **The daemon sends all events to all clients, and clients reload everything.**
    - [mobile.ts:148](../daemon/src/mobile.ts#L148) sends every event, including streamed text from all runtimes, to every client.
    - `sessions-changed` has no data and fires on each working/idle change. The client then reloads the full session list from all hosts and replaces the whole array ([appConversations.ts:258](../clients/ui/appConversations.ts#L258)).
    - `clientPayload` walks every outgoing packet and guesses data types from their shape. It has subagent tool names hard-coded.

12. **Polling where events are available.**
    - The parent checks subagent completion every 500 ms ([subagent-reconciliation.ts:209](../daemon/resources/session-broker/subagent-reconciliation.ts#L209)). The daemon already receives `agent_settled` events.
    - Read-only views reload the full snapshot every 2 s ([useChatSession.ts:387](../clients/ui/lib/useChatSession.ts#L387)).
    - Retention cleanup runs every 30 s.
    - Other loops: `sleep(100)` in start, stop and restart; `sleep(25)` while terminals settle; a 1 s loop in the shutdown wait.

13. **Plugins are really built-ins.**
    - The daemon `CATALOG` and the UI `plugins` list are fixed at build time. Name, description and `queuedCommands` are duplicated on both sides.
    - The core settings type includes the plugin settings: `PluginSettings = ReviewSettings & WebSearchSettings`.
    - The core knows the review plugin: `review-publication.cjs` in core storage, a `review` phase in the publication journal, `piop-review` in `restore-plan.cjs`, and `KNOWN_WITHOUT_LIST = ['cost','review']`.

14. **The UI uses React patterns in SolidJS.**
    - `lib/solid.ts` copies React helpers (`createRef`, `StateUpdate`, `createSubscription`).
    - Messages are one immutable array. Each streamed piece of text runs `findIndex`, copies the array, and runs all calculations that depend on messages again, including grouping messages into turns.
    - `state` is one object that is replaced for any field change.
    - The fix: `createStore` with path updates, keyed by message ID.

15. **Failures are lost without a message.** There are about 108 empty `catch` blocks or `.catch(() => undefined)` calls. Examples:
    - sidebar order saves in `sidebarState.ts` (a saved change can be lost);
    - `releaseUnused` and the abort before stop in `controller.ts`;
    - the checks for Pi's internal modules in `provider-sdk.mjs`, where a failed import becomes "no SDK".

16. **Settings are read again for almost every request.** `loadAppSettings` has 37 call sites. Each call takes two file locks, reads and parses the database row, merges the discovered skills and reads the tool list. There is no copy in memory that change events keep current.

## Low

17. **Names conflict with GLOSSARY.md.**
    - The glossary says "Extensions" are agent-defined, but the `extensions/` folder holds piop's own Pi extensions. Pi extensions are also in `daemon/resources/` and `daemon/plugins/`.
    - The `Daemon` class is a connection to `Host`, not a daemon.
    - `mobile*.ts` serves all clients, not only mobile.

18. **Backward-compatibility code remains, against the "no backwards compatibility" rule.** Examples: `DROP TABLE session_children`, `migrateKeybindings`, the `migrate*` functions in `piop-define-agents`, and the Rust-style error texts.

19. **The same storage code runs on two runtimes.** The daemon uses Bun and Pi uses Node, so there are two file-lock paths. In Node, each lock starts a Bun child process. The lock code loads `libc.so.6` directly, which works only with glibc.

## Main recommendation

The most useful change is to make the daemon the only writer for its storage and to fix the Pi version. That removes most of the cause of items 2–6, 12 and 19.
