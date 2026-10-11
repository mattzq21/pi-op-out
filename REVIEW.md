# Piop review findings

Six reviewers covered the daemon, the UI, the extensions, and the Rust and build code. Four other reviewers then checked each finding. All 19 findings are confirmed. Some are narrower than the first report, and the text below shows the corrected trigger and effect.

## Most serious

1. **A restart timeout can freeze the daemon.**
   `daemon/src/mobile_commands.ts:75`
   The restart waits up to 30 seconds for the restart lock. If another request is still running, the restart gives up, but its lock request stays in the queue (`daemon/src/util/sync.ts:63`, `:119`). When the lock is given later, nothing releases it. After that, all normal client commands wait forever at `mobile_commands.ts:54`. Only a control stop or killing the process recovers it.

2. **Development builds open a shell to anyone who can reach the debug port.**
   `daemon/src/mobile.ts:120`, `daemon/src/ws_server.ts:11`
   The debug listener starts in every development build. It listens on 127.0.0.1 on a random port and has no token check and no `Origin` check. Any local process can connect and start a terminal (`start_terminal`, `write_terminal`). A web page in a local browser can do the same if it finds the port and the browser lets it reach local addresses. `PIOP_DEBUG_MOBILE_BIND` can make the port reachable from the network.

3. **An image path can stop the whole daemon.**
   `daemon/src/project_files.ts:19`
   `readLocalImage()` calls the blocking `openSync` before it checks that the path is a normal file. If a message has an image reference such as `/tmp/x.png` and that path is a named pipe with no writer, the daemon blocks. The UI calls `read_image_file` as soon as the message is shown (`clients/ui/components/markdownImages.tsx:21`). The function also accepts paths outside the project, such as absolute paths, `..`, and symbolic links.

4. **Moving a draft between hosts and back crashes draft lookup.**
   `clients/ui/appDrafts.ts:175` (`rekeyDraft`), `clients/ui/appDrafts.ts:183`
   Move a draft from host A to host B, then back to A. The second move records the link B→A but does not remove the old link A→B. `keyFor()` then follows these links in a loop until the stack overflows. After that, draft edits and project changes fail.

5. **The `.deb` package needs Bun to start its daemon.**
   `scripts/build-daemon.mjs:55`, `clients/desktop/tauri.conf.json:19`
   The packaged `piopd` is a script that starts with `#!/usr/bin/env bun`. The package does not include Bun or list it as a dependency. On a machine without Bun in `PATH`, the app cannot start its own daemon.

6. **`bun run reinstall` always stops at its build check.**
   `scripts/mobile-debug-connection.mjs:67`
   Line 22 hashes the daemon script. Line 67 hashes `/proc/<pid>/exe`, which is the Bun executable. The two never match, so `scripts/reinstall-mobile.mjs:102` stops before it builds or installs the Android app.

## Data loss and wrong behavior

7. **Mobile disconnect can lose interrupted messages.**
   `clients/ui/appConversations.ts:354`
   The disconnect warning counts drafts but not `drafts.submissions()`. A message with an unknown result is kept only in memory in `submissions`. If there are no other drafts or unsaved settings, the app disconnects without a warning, and the text and attachments are lost.

8. **Reloading a conversation window opens a blank chat.**
   `clients/ui/lib/sessionResume.ts:156`
   This affects editable windows opened with `target` in the URL. After a reload, `restoredSessionTarget()` returns `{}` where it should return the window's target. The window loses its session, project, and host. Read-only windows are not affected.

9. **ChatGPT plugin drafts are lost.**
   `clients/ui/plugins/chatgpt/useChatGpt.ts:172`, `clients/ui/plugins/workspace.tsx:168`
   Selecting a chat from the history clears the unsent prompt. Removing the ChatGPT tab destroys `QuickChat` and its state. Neither action asks first, and the text is not saved.

10. **`/fast off` still rejects models without fast mode.**
    `extensions/piop-define-agents/index.ts:475`
    `/fast off` sets `fastModeOverride = false` (`index.ts:603`). But `validateFastMode()` checks the agent's original `fastMode` setting, so the next message is rejected (`index.ts:660`).

11. **One failed fast mode lookup is kept until the daemon restarts.**
    `daemon/src/host/providers.ts:68`, `daemon/resources/fast-capabilities.mjs:64`, `extensions/piop-openai-fast-mode/src/discovery.ts:120`
    If the model list download fails at startup, for example because you are not logged in or offline, the daemon gets an empty list and stores it permanently. The extension accepts the empty list and does not try again. Fast mode support from that list stays missing until a daemon restart. Support from model fields or explicit settings still works.

12. **Older saved answers can block the message queue.**
    `daemon/src/host/queue.ts:165`, `daemon/src/host/queue_storage.ts:143`
    When the daemon recovers an older answer that has no queue ID and no matching message, `recoverQuestion()` inserts the ID `question:<requestId>`. The queue storage accepts only numeric IDs, so every save fails. New messages and retries fail until the user removes that item.

13. **Read-only views stay registered after they close.**
    `daemon/src/host/controller.ts:247`, `:264`, `daemon/src/host/session.ts:540`
    `presence()` adds a read-only view to the session, but `detachReadonly()` removes a view only through its subscription, and read-only views have none. While the view is open, the daemon can give it a question that is then never sent (`session.ts:214`). After the view closes, it stays listed and can keep questions that no one sees.

14. **Switching agents can remove the new agent's model provider.**
    `extensions/piop-define-agents/extension-loader.ts:509`
    The new extension group starts before the old group shuts down. If both agents load the same extension, and that extension unregisters its provider on `session_shutdown`, the old copy removes the provider that the new copy just registered. No bundled extension does this today.

## Leaks and build problems

15. **Failed output setup does not release files.**
    `daemon/src/broker_output.ts:74`
    If `MessageOutput.prepare()` fails after it opens files, it closes only the creation lock. The owner lock and output files stay open until the daemon exits, and the caller (`daemon/src/broker.ts:249`) cannot clean them up.

16. **The stop polling loop leaks one callback per second.**
    `daemon/src/daemon_clients.ts:39`
    Each loop runs `stopped.notified()` against `sleep()`. When the timer finishes first, the unused callback stays in `Notify`, which adds about 86,000 callbacks per day. A stop signal can go to an old callback, which delays shutdown by up to one second.

17. **The draft store keeps every released connection object.**
    `clients/ui/appDrafts.ts:149`
    `bindTransport()` adds each object to `owners` and never removes it. `uploadsByTransport` keeps them too. Each draft update also processes all of the old objects.

18. **The frontend build can reuse old output.**
    `scripts/build-frontend.mjs:33`
    The change check skips `daemon/resources` and `extensions`. But the UI imports `daemon/resources/session-broker/review-prompt.txt` (`clients/ui/components/ReviewSettings.tsx:3`) and `extensions/piop-define-agents/mcp-schema.ts` (`clients/ui/lib/agentSchemas.ts:3`).

19. **`tauri dev` does not rebuild after changes in `shared/rust`.**
    `scripts/watch-backend.mjs:177`, `scripts/tauri.mjs:81`
    The watcher does not watch `shared/rust`, which the desktop app includes (`clients/desktop/src/client_settings.rs:4`). Tauri's own watcher is turned off with `--no-watch`.

## No findings

The reviewers did not find XSS in the markdown and HTML rendering code.

