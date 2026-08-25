delete: Checked-in generated Tauri schemas, including two identical 2,357-line files. Regenerate them on demand and ignore `src-tauri/gen/`. [src-tauri/gen/schemas](/home/matt/Projects/pi-ui/src-tauri/gen/schemas)

delete: Committed temporary tests and fixtures contradict the repository’s test policy. Remove them, Vitest configuration, and five test-only dependencies. [src](/home/matt/Projects/pi-ui/src) [test](/home/matt/Projects/pi-ui/test) [src-tauri/src/lib.rs](/home/matt/Projects/pi-ui/src-tauri/src/lib.rs:978)

yagni: Production browser-preview transport and its large fabricated dataset in a Tauri-only application. Instantiate `NativeTransport` directly. [mockTransport.ts](/home/matt/Projects/pi-ui/src/lib/mockTransport.ts) [transport.ts](/home/matt/Projects/pi-ui/src/lib/transport.ts)

delete: One-time legacy YAML/settings migration and its hand-written YAML parser. Require the current JSON orchestration configuration. [index.ts](/home/matt/Projects/pi-ui/extensions/pi-orchestration/index.ts:36)

shrink: Local/remote Pi command construction is duplicated between interactive startup and broker dispatch. Use one command builder parameterized by mode, session and prompt. [lib.rs](/home/matt/Projects/pi-ui/src-tauri/src/lib.rs:484)

shrink: Split panes duplicate connection, refresh, streaming and command logic from the primary chat. Share one session controller between both chat shells. [SplitChatPane.tsx](/home/matt/Projects/pi-ui/src/components/SplitChatPane.tsx) [App.tsx](/home/matt/Projects/pi-ui/src/App.tsx)

yagni: Hidden `notifications`, `steeringMode`, and `followUpMode` settings cannot be changed in the UI but remain persisted and propagated. Pick fixed behavior or Pi defaults. [types.ts](/home/matt/Projects/pi-ui/src/types.ts:22) [lib.rs](/home/matt/Projects/pi-ui/src-tauri/src/lib.rs:114)

delete: Dead logo, loading state, `projectName`, `relativeTime`, `sequencePrompt`, `starred`, skill `scope`, and command `path` artifacts. Replacement: nothing. [Logo.tsx](/home/matt/Projects/pi-ui/src/components/Logo.tsx) [content.ts](/home/matt/Projects/pi-ui/src/lib/content.ts:17) [sequence.ts](/home/matt/Projects/pi-ui/src/lib/sequence.ts:5)

stdlib: `chrono` is used only to turn `SystemTime` into a sortable RFC3339 string that the UI never displays. Sort UNIX timestamps from `duration_since(SystemTime::UNIX_EPOCH)`. [lib.rs](/home/matt/Projects/pi-ui/src-tauri/src/lib.rs:695) [Cargo.toml](/home/matt/Projects/pi-ui/src-tauri/Cargo.toml)

delete: Unused direct `playwright-core` dependency. Replacement: nothing. [package.json](/home/matt/Projects/pi-ui/package.json)

net: -6,150 lines, -7 deps possible.
