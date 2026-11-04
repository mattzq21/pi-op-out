# Architecture review

## Current layout

The desktop app (a Tauri app, which proxies calls through Rust) and the Android app (which uses a WebSocket) both talk to `piopd`, the daemon. The daemon runs on Bun. Inside it, the `Host` object starts Pi child processes, which run on Node with piop's own Pi extensions. Data is in Pi's JSONL transcript files plus one shared `sessions.sqlite`.

## High

1. **Piop changes Pi's internal code at run time, and the Pi version is not fixed.**
   - [runtime-bridge.cjs](../daemon/resources/runtime-bridge.cjs), [session-storage.mjs](../daemon/resources/piop-storage/session-storage.mjs), `sdk-storage.mjs`, `runtime-availability.cjs` and `runtime-configuration.cjs` replace methods on Pi classes. Some are private methods such as `_appendEntry`, `_rewriteFile`, `_loadEntries` and `_queueFollowUp`.
   - They also import Pi's internal files (`dist/core/output-guard.js`, `dist/extensions/mcp/runtime.js`).
   - [`piExecutable()`](../daemon/src/environment.ts#L22) uses any `pi` it finds on the machine. Nothing checks its version.
   - A Pi update can break storage, the message queue and crash recovery without any error.
   - **Status: partly fixed.**
     - Piop needs exactly Pi 1.5.0. One function, [`supportedPi`](../daemon/resources/pi-runtime.cjs), finds Pi and checks its version, for the Pi launch, the provider SDK and the agent checks. Another version stops with a message that names the needed version.
     - Each Pi method that piop replaces or calls is checked first, through [pi-patch.cjs](../daemon/resources/pi-patch.cjs). If one is missing, Pi stops at start with the class and method name.
     - Not planned: a private install of the fixed Pi version under `~/.piop/pi/<version>/`. Piop still uses the `pi` on the PATH.
     - Still open: piop imports Pi's internal files and replaces private methods. The fixed version and the checks make this safe until the next Pi update.

2. **Many processes write the same storage and coordinate through files.**
   - These processes all open `sessions.sqlite` and the JSONL files directly: the daemon, each Pi process, the worker threads, and the restart candidate (the new daemon during a restart). Each development checkout now has its own storage folder under `~/.piop-dev/daemons/` ([config.ts](../daemon/src/config.ts)).
   - To coordinate, they use:
     - about six kinds of file locks (`flock`);
     - a local HTTP server for ownership hand-off ([ownership.ts](../daemon/src/host/ownership.ts#L100));
     - a folder of marker files that `fs.watch` monitors to sync settings;
     - transaction journals.
   - Recovery runs on read paths too, for example `restoreRecovery.recover` in `listLocalSessions`.
   - Most of the ~4.6k lines of storage code exist only to make many writers safe.
   - A better design: one writer per storage root (the daemon), with Pi using the broker channel it already has.
   - **Status: in progress.** The work has 8 steps.
     1. Done: Pi saves its chat transcripts through the daemon. The daemon starts each Pi with a storage channel (descriptor 3). Pi sends each change and waits for the answer, so the change is saved or has failed when the call returns. The daemon runs the change ([transcript-writes.mjs](../daemon/resources/piop-storage/transcript-writes.mjs), [pi_storage.ts](../daemon/src/host/pi_storage.ts)). Pi keeps only its copy in memory and the reads.
     2. The new chat files that Pi extensions make: forks, side chats, reviews, subagent chats and agent profiles.
     3. Pi's other database writes: mailbox, subagent runs, child index, chat list summaries, and the record of transcripts outside the storage folder.
     4. Pi's settings writes: Pi's sign-in, settings and trust files, `models.json`, and the agent definitions.
     5. Pi opens the database read-only, so any write that is left fails at once.
     6. The daemon's worker threads write from one place only.
     7. The restart candidate does not write at the same time as the daemon that it replaces.
     8. Remove what only many writers needed: file locks, session claims, the ownership hand-off server, marker-file settings sync, file-identity checks, and recovery on read paths.

3. **No single owner of the database schema.**
   - About 75 `CREATE TABLE IF NOT EXISTS` statements are spread over about 20 files. Some tables are defined in 2–3 files: `goal_text_files`, `temporary_chat_allocations`, `external_transcripts`, `application_settings` and others.
   - Only `session-database.cjs` uses version numbers for schema changes.
   - Many tables store a `record_json` text block, so SQLite cannot check or index the values.
   - Each call opens a new connection and runs the PRAGMA and CREATE statements again ([settings_records.ts](../daemon/src/settings_records.ts#L7)).
   - **Status: partly fixed** by other changes in this worktree. All tables are now made in [session-database.cjs](../daemon/resources/session-database.cjs), with one schema version. Each process keeps one connection per database. Still open: the `record_json` text blocks.

4. **File paths are used as database keys.**
   - `settings_records.open(path)` selects the database from `dirname(path)` and the row from `basename(path)`. `settings.json`, `context-cap-settings.json` and `agent-definitions.json` are not real files.
   - In development builds, `context-cap-settings.json` goes into a second, hidden `sessions.sqlite` under `~/.piop-dev/daemons/<key>/extensions/`.
   - The context cap values (context window limits) have 3 copies: in AppSettings, in that record, and in the `context_cap_settings` message sent to Pi.
   - **Status: partly fixed.** The hidden second database is gone: the context cap record is now in the main `sessions.sqlite` of the storage folder. Still open: the paths as keys and the 3 copies.

5. **Each Pi start rewrites about 85 generated files and forces them to disk.**
   - The path is [`configureLocalExtensions`](../daemon/src/pi_launch.ts#L157) → `prepare*` → [`publishPrivate`](../daemon/src/private_fs.ts#L52).
   - When the content has not changed, it still forces the file to disk (`fsync`), and then each parent folder up to `/`. All of this is synchronous on the main event loop.
   - It runs on each `start_pi`, each orchestration `send`, `settle_first_message` and each prompt preview.
   - Running Pi processes read these same files while they are replaced.
   - **Status: fixed.** The daemon writes the generated files once, into `generated/<content hash>/`, with a rename of the full folder. A Pi start writes nothing. The daemon removes the folders of older builds only after all old Pi processes have stopped ([extensions.ts](../daemon/src/extensions.ts)).

6. **Source code is shipped as text and changed with regex.**
   - [resources.ts](../daemon/src/resources.ts) imports about 90 files with `?raw`, from a hand-kept list.
   - `embedFileLock` changes `require`/`module.exports` with string replacement and inserts a base64 data URL.
   - `file-lock.cjs` contains its own code a second time, as a string.
   - The folder mixes `.cjs`, `.mjs`, `.ts` and hand-written `.d.cts` type files.
   - A better design: build one bundle per extension at build time. `fast-mode` and `mcp-bridge` already work this way.
   - **Status: fixed.** The daemon build makes one file for each Pi extension, for the runtime bridge and for the provider SDK. The import form is `'…?pi-extension' with { type: 'text' }` or `'…?node-program'` ([daemon-imports.mjs](../scripts/daemon-imports.mjs)). [resources.ts](../daemon/src/resources.ts) has 17 imports. There is no text replacement, and `file-lock.cjs` has its code once. The saved `.bundle.mjs` files are gone. The source folders still mix `.cjs`, `.mjs` and `.ts`, but piop no longer ships them as text.

## Medium

7. **Components in the same process talk through an untyped message protocol.** `Daemon` ([daemon.ts](../daemon/src/daemon.ts#L122)) calls `Host` (the object that runs sessions) inside the same process. It still uses:
   - untyped `any` packets and switches on string message types;
   - request IDs, 660 s timeouts and `structuredClone` copies;
   - `connect()` and `loadAppSettings` before almost every call.

   Some code is dead:
   - `connect()` rejects every non-local host, so the per-host map, `connectionConfig` and `remotePort` (always undefined) are never used.
   - There are 46 `hostId` parameters and checks that only assert the value is `'local'`.

   **Status: fixed.** The daemon calls typed `Host` methods directly, and the Host reports through a typed `HostEvents` listener ([local_host.ts](../daemon/src/local_host.ts), [host/events.ts](../daemon/src/host/events.ts), [host/requests.ts](../daemon/src/host/requests.ts)). The packets, request IDs, timeouts, `connect()` and the per-host map are gone. The daemon starts its one Host at launch and stops it at shutdown. The command dispatcher checks `hostId` once; the functions behind it no longer take it. The dead SSH paths for terminals, home folder and project checks are removed.

8. **Some objects hold too much state.**
   - `Host` exposes about 20 mutable maps (sessions, subscriptions, attachments, `readonlyMap`, gates, and more) that other modules change directly.
   - On the UI side, [`createAppConversations`](../clients/ui/appConversations.ts#L49) returns about 140 fields, and `App.tsx` reads all of them.

   **Status: fixed.** The Host state is private. Other modules use Host methods, or `host.views` ([client_views.ts](../daemon/src/host/client_views.ts)), which keeps each client's requested, current and read-only session together. The lock maps are `KeyedLocks` ([lock_gate.ts](../daemon/src/host/lock_gate.ts)), which drop unused locks. `createAppConversations` returns nine groups (`conversation`, `sessions`, `layout`, `settings`, `usage`, `notices`, `dialogs`, `side`, `terminal`). `App.tsx` gives each part only its groups: [AppSidebar.tsx](../clients/ui/AppSidebar.tsx), [ChatWorkspace.tsx](../clients/ui/ChatWorkspace.tsx), [AppOverlays.tsx](../clients/ui/AppOverlays.tsx). The inside of `createAppConversations` is still one large function.

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

    **Status: mostly fixed.**
    - The daemon catalog is the only place that names a plugin and lists its queued commands. The unused descriptions are gone. `plugin_status` sends them; the UI list keeps only the client parts (code, settings page, message views).
    - Plugin settings are saved under `plugins.<id>`. The core does not know their fields; each plugin parses its own, and its settings page sees only its own.
    - Core storage publishes any plugin's auxiliary chat and links it from its parent with a core `piop-auxiliary-link` record and the plugin's own message ([auxiliary-link-publication.cjs](../daemon/resources/piop-storage/auxiliary-link-publication.cjs)). Restore uses that record. `KNOWN_WITHOUT_LIST` is gone.
    - Still open: the set of plugins is fixed when piop is built.

14. **The UI uses React patterns in SolidJS.**
    - `lib/solid.ts` copies React helpers (`createRef`, `StateUpdate`, `createSubscription`).
    - Messages are one immutable array. Each streamed piece of text runs `findIndex`, copies the array, and runs all calculations that depend on messages again, including grouping messages into turns.
    - `state` is one object that is replaced for any field change.
    - The fix: `createStore` with path updates, keyed by message ID.

    **Status: mostly fixed.** The client copy of a conversation ([sessionMemory.ts](../clients/ui/lib/sessionMemory.ts)) is now a Solid store. Messages are matched by ID, so a streamed piece of text changes only that message's fields; grouping into turns does not run again. `state` changes field by field. The store copies what it takes in, so it never changes an object that someone else holds. The caches that assumed unchanged message objects are gone, and the runtime pool gives Solid signals in place of `createSubscription`. Still open: the event code still builds the next message list before the store compares it, and `createRef`, `StateUpdate` and `createDependencyEffect` are still used in about 250 places.

15. **Failures are lost without a message.** There are about 108 empty `catch` blocks or `.catch(() => undefined)` calls. Examples:
    - sidebar order saves in `sidebarState.ts` (a saved change can be lost);
    - `releaseUnused` and the abort before stop in `controller.ts`;
    - the checks for Pi's internal modules in `provider-sdk.mjs`, where a failed import becomes "no SDK".

    **Status: fixed.** Each place was checked. Lost failures now reach the user (UI notices), the daemon log or the Host diagnostics; provider errors keep their cause. Expected cases catch only their own error (for example a missing file) and pass on all others. About 35 places stay, each for a reason: the failure reaches another caller (`observedElsewhere` in the daemon), the call only waits for earlier work to settle, a cache read or write, or a parse whose fallback still reports the problem.

16. **Settings are read again for almost every request.** `loadAppSettings` has 37 call sites. Each call takes two file locks, reads and parses the database row, merges the discovered skills and reads the tool list. There is no copy in memory that change events keep current.

## Low

17. **Names conflict with GLOSSARY.md.**
    - The glossary says "Extensions" are agent-defined, but the `extensions/` folder holds piop's own Pi extensions. Pi extensions are also in `daemon/resources/` and `daemon/plugins/`.
    - The `Daemon` class is a connection to `Host`, not a daemon. (Fixed with issue 7: it is now `LocalHost` in `local_host.ts`.)
    - `mobile*.ts` serves all clients, not only mobile.

18. **Backward-compatibility code remains, against the "no backwards compatibility" rule.** Examples: `DROP TABLE session_children`, `migrateKeybindings`, the `migrate*` functions in `piop-define-agents`, and the Rust-style error texts.

19. **The same storage code runs on two runtimes.** The daemon uses Bun and Pi uses Node, so there are two file-lock paths. In Node, each lock starts a Bun child process. The lock code loads `libc.so.6` directly, which works only with glibc.

## Main recommendation

The most useful change is to make the daemon the only writer for its storage and to fix the Pi version. That removes most of the cause of items 2–6, 12 and 19.

Done so far: the Pi version is fixed (item 1), the generated files are written once (item 5), each extension is one built file (item 6), and Pi saves its chat transcripts through the daemon (item 2, step 1).
