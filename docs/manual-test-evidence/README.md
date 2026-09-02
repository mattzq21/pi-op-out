# Manual test evidence

These screenshots were captured from the WebDriver-enabled native Tauri build during
the 2026-09-03 requirements walkthrough:

- `001-shell.png` — native empty-chat shell and composer controls
- `002-settings.png` — Settings / General and section navigation
- `003-project-dialog.png` — Open project dialog
- `004-terminal.png` — session-owned bottom terminal panel before a CWD exists

The requested evidence from three separate session selections is not present. During
that part of the walkthrough, the external-driver fallback lost its native application
session. The failure and its effect on coverage are documented in
[`../manual-requirements-test-report-2026-09-03.md`](../manual-requirements-test-report-2026-09-03.md).
