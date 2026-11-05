# Architecture review

Fixed items are removed. The other items keep their numbers.

## Current layout

The desktop app (a Tauri app, which proxies calls through Rust) and the Android app (which uses a WebSocket) both talk to `piopd`, the daemon. The daemon runs on Bun. Inside it, the `Host` object starts Pi child processes, which run on Node with piop's own Pi extensions. Data is in Pi's JSONL transcript files plus one shared `sessions.sqlite`.

## High

None left.

## Medium

None left.

## Low

None left.

## Main recommendation

Done: the daemon is the only writer of its storage (old item 2), and keeps its settings in memory (old item 16). All tables are made in one place, and each stored record is checked against its schema when it is saved and read (old item 3). Records are found by storage folder and name, not by a file path (old item 4). The client commands are defined once, in [protocol/commands.ts](../protocol/commands.ts), with what each takes and answers; the daemon and the clients both check against it (old item 9). The backward-compatibility code is gone (old item 18). The transports are plain pipes: the desktop app's Rust connection and the WebSocket client do not track chats or terminals, and they tell the window once when the connection is lost. The daemon finds which commands start and stop resources, and which may run when it is busy, in the command table (old item 10). The events of a chat go only to the client that opened it. A chat that starts or stops working is told by its own event, and the client changes only that row; a reload of the chat list keeps the rows that did not change. Pi's data is changed into the client form only where it comes from Pi, and the subagent tools are named in one place (old item 11). Waits use events, not checks again and again: a subagent's parent waits until the subagent's chat changes; a read-only view reads the chat again only on its events; deferred cleanup runs when storage changes; the end of a process is told by a pidfd, the end of the daemon by its lock, and a change of the daemon's records by the file system (old item 12). piop's own Pi extensions are in `pi-extensions/`, and the daemon's client server is in `daemon/src/clients/`; the glossary names both (old item 17).

Plugins are real plugins (old item 13). A plugin is a folder with a manifest ([protocol/plugins.ts](../protocol/plugins.ts)), its built Pi extension and its built app part. The built-in plugins are in [plugins/](../plugins); the daemon also loads the plugins in `~/.piop/plugins/` when it starts ([plugins/catalog.ts](../daemon/src/plugins/catalog.ts)). The core names no plugin: the manifest gives the commands, settings, state records, message display and side chat look, and the app loads each enabled plugin's app part from its host at run time ([clientModules.ts](../clients/ui/plugins/clientModules.ts)).

The client copy of a chat is a Solid store (old item 14). Messages are matched by ID; a streamed piece of text, a tool update or another live change changes only that message in its place, and grouping into turns does not run again ([sessionMemory.ts](../clients/ui/lib/sessionMemory.ts)). `state` changes field by field. The small helpers in [lib/solid.ts](../clients/ui/lib/solid.ts) stay: `createRef` is a box for values that do not change the view, and `createDependencyEffect` is Solid's `on` with a value comparison, so it runs only when a value really changes.
