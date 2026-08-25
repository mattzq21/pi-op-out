# Ponytail audit execution

All findings from the repository audit were applied in commit `d9b8f11`.

- Deleted the checked-in generated Tauri schemas and ignored `src-tauri/gen/`.
- Deleted temporary frontend, integration, and Rust tests, their fixtures and configuration, and five test-only dependencies.
- Deleted the browser preview transport and fabricated preview data; both chat shells now instantiate `NativeTransport` directly.
- Deleted legacy orchestration YAML/settings migration and its hand-written parser. Orchestration uses its current JSON configuration only.
- Consolidated local/remote interactive and broker Pi command construction in `build_pi_command`.
- Added `useChatSession`, shared by primary and split chats for snapshots, frame-batched streaming, tool events, queue state, and model metadata.
- Deleted unreachable notification, steering-mode, and follow-up-mode settings. Desktop notifications are off; Pi defaults govern both queue modes.
- Deleted the unused logo, loading state, helpers, session `starred`, skill `scope`, and slash-command path fields.
- Replaced `chrono` timestamp formatting with `SystemTime::duration_since(SystemTime::UNIX_EPOCH)` and removed the direct dependency.
- Deleted the unused `playwright-core` dependency.

Net result: 8,405 lines and 7 direct dependencies removed.

Verification completed with:

```text
npm run build
cd src-tauri && cargo check --locked
cd src-tauri && cargo build --locked
Pi orchestration RPC capability smoke
```
