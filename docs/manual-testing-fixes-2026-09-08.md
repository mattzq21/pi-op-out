# Manual-testing finding validation

Source: `Run manual wdio testing` (01a07dfc-fedf-7592-b190-a8f3244e706b), report at `/home/matt/.codex/worktrees/e73d/piop/docs/manual-testing-2026-09-08.md`. Checked against main at a35aa88.

| Finding | Disposition |
| --- | --- |
| WDIO MCP setup | Fixed the nonexistent project path and removed the separate tauri-driver launch. MCP now attaches to the documented embedded session; pinned to the reviewed 3.12.0 version. Shell syntax checked. Connector discovery itself requires a new task/reload. |
| Case-only group names | Already fixed: duplicate validation uses the same case-insensitive collator for project and group names. |
| Retry leaves restored draft | Fixed: consume a matching restored draft before submission; restore it on rejection if still mounted and no newer draft exists. Different drafts remain untouched. |
| Clone loses source drafts/attachments | Fixed: copy the draft and retain attachments under the source runtime while cloning. Cancellation leaves source ownership unchanged. |
| Mixed native drop hides rejection | Fixed: validate the batch together and combine native-read and frontend-validation errors. |
| More than 12 files silently omitted | Fixed: both native and file-URI drops explicitly report skipped excess files. |
| Ctrl+F interrupts shortcut recording | Fixed: Find ignores events from the shortcut recorder. |
| Raw MCP metadata in BTW pane | Already fixed: SplitChatPane excludes the internal MCP status key from generic status rendering. |
| BTW storage documentation | Corrected README: temporary private side-session files have distinct identities and are removed when the pane closes; they are not saved sidebar history. |
| Spaced diff filenames | Already fixed: current parser resolves complete Git paths rather than splitting on whitespace. |

## Verification

- Existing native E2E suite: **103 passing**, no new or modified tests (`/tmp/piop-manual-fixes-e2e.log`).
- WebDriver-enabled native release build and TypeScript/Vite build passed.
- Targeted manual WebDriver checks used a separate app with private PIOP_TEST_HOME, SDK settings, and XDG directories. Model/session responses were mocked; file drops used the real native file-reading backend. No fixture files were sent to a model.
- Mixed SVG/text native drop: accepted the text file and retained the SVG warning.
- Thirteen-file native drop: accepted 12 and displayed the excess-file warning.
- Shortcut recording: Ctrl+F appeared in the field, focus remained there, and no Find bar opened. The unsaved binding was restored afterward.
- Retry: a matching restored draft was consumed; the existing retry acceptance case passed. The targeted fixture did not perform live inference.
- Clone: native WebDriver typing populated SOURCE_DRAFT; the clone received a copy. After replacing the clone text, the explicitly selected source retained SOURCE_DRAFT. Removing the clone attachment left the source attachment intact.
- `git diff --check` and WDIO launcher shell syntax passed. Real configuration hash checks remained unchanged.
