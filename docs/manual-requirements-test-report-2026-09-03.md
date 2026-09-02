# Manual requirements test report — 2026-09-03

This report tests the effective requirements in
[`user-requirements-from-codex-traces.md`](./user-requirements-from-codex-traces.md).
It is an acceptance audit, not a claim that every requirement could be proven in one
healthy end-to-end run. The embedded Tauri WebDriver provider failed before creating a
session, so the native application was also exercised with the external Tauri driver,
focused acceptance cases, visual inspection, and targeted source/configuration checks.

## Result summary

**Overall result: not ready for requirements acceptance.** The app builds and a large
part of the visible shell, Settings, `/btw`, rendering, orchestration, and command flow
works, but several explicit requirements fail and the prescribed embedded-driver
acceptance path is itself broken.

The most important confirmed failures are:

1. The embedded Tauri WebDriver provider cannot create a session.
2. Agents created in Settings are not persisted to the installed orchestration config.
3. Multiline entry loses its newline in both the composer and extension-input editor.
4. The composer hint remains even though the requirement says to remove it.
5. Picker-menu CSS uses a white background despite the dark-only requirement.
6. Pinned projects/chats and `Ctrl+Tab` session-space focus are not implemented.
7. The native attachment checks never showed an attached file.
8. Cache-hit UI was absent in the focused debug acceptance case.
9. Native terminal event/error feedback checks timed out.
10. The required three-session WDIO screenshot walkthrough could not be completed;
    the external WebDriver session disconnected during repeated session transitions.
11. The suite contains 99 cases and no accounting was found for the previously cited
    reduction from 101.

### Status vocabulary

- **PASS** — directly observed in the native app or exercised by a focused native
  acceptance check.
- **PASS (static)** — implementation/configuration is present and unambiguous, but the
  condition was unsafe, impractical, or unavailable for a live manual exercise.
- **PARTIAL** — only part of the requirement was demonstrated, or the result is
  dependent on a mock/external-driver limitation.
- **FAIL** — the observed behavior or implementation contradicts the requirement.
- **BLOCKED** — a necessary external host, provider, long-running workload, or healthy
  embedded driver was unavailable. A blocked result is not counted as a pass.

## Environment and procedure

- Workspace: `pi-ui`, Linux, `DISPLAY=:0`.
- Dependencies installed with `npm ci` (npm reported 16 dependency vulnerabilities:
  15 high and 1 moderate).
- Native release test build: **PASS** after retrying with
  `RUST_MIN_STACK=16777216 CARGO_BUILD_JOBS=2`; the first Rust build exited with
  `SIGSEGV`.
- Frontend production build: **PASS**.
- WebDriver binaries: `/usr/bin/WebKitWebDriver` and the installed `tauri-driver`.
- Intended embedded-provider run: **FAIL**. It timed out at `127.0.0.1:4445`; after a
  temporary capability probe, the server started but dropped the socket during session
  creation and then refused the connection. All temporary capability/config edits were
  reverted.
- External-provider fallback: usable for focused native checks, but it repeatedly lost
  the application session after transitions such as context-menu actions, project
  collapse, cloning, and switching among mocked conversations. Cascading failures after
  a lost session are not treated as independent product defects below.
- No destructive archive, real remote-host, or runaway-memory test was performed against
  user data.

The suite currently discovers **99** cases. Focused reruns produced these useful,
non-additive samples:

- Settings behavior: **12/12 passed**.
- `/btw`, Settings rejection, orchestration, project, and lifecycle group:
  **19 passed / 10 failed**; several failures were stale native-`select` selectors or
  cascading session loss.
- Rendering/event group: **17 passed / 9 failed**.
- Composer/attachment group: **5 passed / 7 failed**.

These totals overlap with additional one-case reruns and therefore must not be summed.

## Visual evidence

- [Native shell](./manual-test-evidence/001-shell.png)
- [Settings / General](./manual-test-evidence/002-settings.png)
- [Open project dialog](./manual-test-evidence/003-project-dialog.png)
- [Bottom terminal panel](./manual-test-evidence/004-terminal.png)

The shell evidence shows the dark native window, orange repository branch, horizontal
icon navigation, narrow conversation rail, empty-chat Pi character, project chooser,
custom Agent/Model/Thinking controls, attachment control, and terminal action. Settings
shows the expected section order and no theme selector. The project dialog starts at the
local home. The terminal evidence shows the bottom panel, plus/tab/delete/close controls,
and `Start the conversation to get a CWD`.

## Requirement-by-requirement matrix

IDs below are local to this report and follow the bullet order in the source document.
Every effective requirement bullet is covered once.

### Product and platform (`PP01`–`PP07`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| PP01 | PASS | Native UI drives mocked Pi/RPC session behavior; no second agent implementation was exposed. |
| PP02 | PASS | Acceptance surface was the Tauri binary; the prescribed browser-only surface is not used. |
| PP03 | PASS | Linux native window and `Ctrl` shortcut labels observed; `Ctrl+,` and configurable shortcuts worked. |
| PP04 | FAIL | No theme selector exists and the main surfaces are dark, but `.composer-picker-menu` is explicitly white. |
| PP05 | PARTIAL | Local and remote machine configuration/UI exist; mocked remote flows pass, but no real SSH peer was exercised. |
| PP06 | PASS (static) | Internal/unavailable commands are filtered from command discovery; the focused internal-command check passed. |
| PP07 | PASS (static) | Tauri icon assets/configuration are present. Visual correspondence to the original reference cannot be re-evaluated because that reference is not in `docs/`. |

### Visual language and shell layout (`VL01`–`VL15`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| VL01 | FAIL | Shell, form, and scrollbar surfaces are dark, but opening a composer picker uses a white CSS background. |
| VL02 | PASS | Message/shell surfaces use closely related dark grays. |
| VL03 | PASS | Orange accents are visible on the branch, active navigation, controls, and dialog focus. |
| VL04 | PASS (static) | App typography is enlarged and UI styles import DM Sans/Instrument Serif; no DM Mono use was found. |
| VL05 | PASS | Native rendering cases place user and assistant content on their required sides. |
| VL06 | PASS | No user or assistant avatars appear. |
| VL07 | PASS | Normal shell logo is absent; the empty-state Pi character remains at the intended prominent scale. |
| VL08 | PASS | No system top bar or reserved replacement strip appears. |
| VL09 | PASS | No main, new-chat, or split-chat header is rendered. |
| VL10 | PASS | Top navigation controls are horizontal. |
| VL11 | PASS | The rail is narrow while retaining a usable conversation list. |
| VL12 | PASS | Sidebar visually reaches the bottom terminal/composer shell. |
| VL13 | PASS (static) | `rail-bottom` has `padding-top: 12px` and a slightly darker background. |
| VL14 | PASS | Current Pi Desktop branch is centered and prominent above navigation. |
| VL15 | PASS (static) | WebKit scrollbar rules are thin, rounded, transparent-track, and keep stable hover/active geometry and color. |

### Sidebar, projects, and session navigation (`SN01`–`SN17`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| SN01 | PASS | Project groups render and the focused collapse check changed group visibility. The driver disconnected during cleanup, after the core assertion. |
| SN02 | PASS | The visible session area is compact and suitable for approximately five active sessions. |
| SN03 | FAIL | No pinned-project or pinned-chat model/UI was found. |
| SN04 | FAIL | Because pinned areas are absent, their item actions are absent too. |
| SN05 | FAIL | No `Ctrl+Tab` session-space focus implementation was found. |
| SN06 | PASS (static) | Active-project styles and state apply orange to the project label. |
| SN07 | PASS | Session rows in the walkthrough omit secondary project text and metadata. |
| SN08 | PASS (static) | Session-title state is read from and written through Pi session metadata. A live CLI/Desktop bidirectional rename was not available. |
| SN09 | PASS (static) | Unseen completed sessions have a distinct light-blue indicator. |
| SN10 | PASS (static) | No yellow running-session line style is present. |
| SN11 | PASS | Global hide-conversations and conversation-menu controls are absent. |
| SN12 | PASS | Project switcher/native-status/panel headings/legacy session-copy span are absent from the shell. |
| SN13 | PASS | Session actions appear in item context/hover affordances. Indexed context actions were visible before the fallback driver disconnected. |
| SN14 | PASS | Archive affordance is hover-only in implementation. |
| SN15 | PASS | Context menu omits compact-context and generic retry-response actions. |
| SN16 | PASS | **New project** opens the project dialog; **Choose directory** is a separate action inside it. |
| SN17 | PARTIAL | Settings is in the top control cluster, but Debug now sits between New project and Settings. This conflicts with the older adjacency bullet; the later debug requirement explicitly requires Debug immediately left of Settings, and the current UI follows that later instruction. |

### Session lifecycle and concurrency (`LC01`–`LC11`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| LC01 | PASS (static) | Per-session runtimes are held in `SessionRuntimePool`; selecting a shell does not stop another runtime. Repeated live switching was destabilized by the fallback driver. |
| LC02 | PASS | Shell/session selection updates before asynchronous history loading in implementation. |
| LC03 | BLOCKED | No sufficiently large real history/stream was available for a meaningful WebView responsiveness and pagination stress test. The batching/lazy-rendering code exists. |
| LC04 | PASS | Focused new-chat/keyboard behavior and project inheritance logic are present. |
| LC05 | PASS (static) | Projectless chats derive `~/pi-desktop/tmp/{chatId}/`. |
| LC06 | PASS | New-chat project chooser is above the composer and opens the shared dialog with directory actions. |
| LC07 | PASS | Split action excludes the currently open session. |
| LC08 | PASS | Split pane is vertical and interactive; the split draft-isolation assertions passed before teardown lost the driver session. |
| LC09 | PASS | All five focused `/btw` acceptance cases passed, including ephemeral right-pane behavior. |
| LC10 | PARTIAL | Archive path and owned-terminal shutdown/state-save logic exist, but no user session was destructively archived and restored. |
| LC11 | PARTIAL | Session persistence code exists. The old acceptance checks use missing native `<select>` elements, so a complete round trip was not demonstrated with the current custom pickers. |

### Conversation rendering and live work (`CR01`–`CR14`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| CR01 | PASS | Live assistant activity and separate incremental text/tool/reasoning acceptance checks passed. |
| CR02 | PASS | Finished work collapses and final answer remains visible. |
| CR03 | PARTIAL | Completed tool summaries render collapsed with state/name, but WebKitWebDriver reported their `<summary>` controls as non-interactable. |
| CR04 | PASS (static) | Completed output preview is line-limited and overflow-scrollable. |
| CR05 | PASS | Sequential-output/grouping behavior passed and live calls remain separate while active. |
| CR06 | PASS | Reasoning is rendered in the work section using smaller plain styling. |
| CR07 | PASS (static) | Tool/reasoning blocks use a 3 px bottom margin. |
| CR08 | PASS (static) | Assistant messages inside `.work-group-content` have no bottom margin. |
| CR09 | PASS | Completed work uses elapsed-duration text rather than `Work · N steps`. |
| CR10 | PARTIAL | Per-block copy control exists with transparent styling; the native click case hit a WebDriver-transpilation error (`__name`), not a demonstrated copy result. |
| CR11 | PASS (static) | Changed-file information precedes message actions. |
| CR12 | PASS | Mention-context, branch text label, and per-message model label are absent. |
| CR13 | PARTIAL | Active work remained stable in ordinary streaming checks, but the explicit click-through could not complete reliably with the fallback driver. |
| CR14 | PASS | `text_delta`, `thinking_delta`, tool lifecycle, revision, and stale-noise acceptance cases passed. |

### Failure, abort, and retry (`FR01`–`FR07`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| FR01 | PASS | Provider failure, success, and aborted-state rendering are distinct. |
| FR02 | PARTIAL | Automatic retry is propagated to Pi and retry events are handled; no real eligible provider retry was induced. |
| FR03 | PASS | Focused latest-aborted-turn check showed the dedicated retry affordance. |
| FR04 | PASS (static) | Aborted user prompt is restored into the session draft. |
| FR05 | PASS | Clean-continuation/fork retry behavior passed the focused acceptance path. |
| FR06 | PASS (static) | Sending edited restored text abandons the old aborted turn and sends the replacement. |
| FR07 | PARTIAL | Runtime ownership is designed to prevent switch-triggered aborts, but repeated transition testing was blocked by the external driver disconnect. |

### Composer, attachments, and commands (`CC01`–`CC16`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| CC01 | PASS (static) | Composer textarea grows with content up to its configured bound. |
| CC02 | PASS | Navigation and split-pane focused checks preserved separate drafts; failures occurred only during teardown after driver loss. |
| CC03 | PASS | Model/effort controls are inside the composer bar at right. |
| CC04 | PASS | Controls omit the `Model` text label and decorative selector SVGs. |
| CC05 | PASS (static) | Compact model trigger is constrained to 70 px and contained by the composer. |
| CC06 | PASS | Display-name normalization removes case-insensitive `gpt-` without changing stored model IDs. |
| CC07 | PASS | Model popup width is compact relative to the earlier layout. |
| CC08 | PARTIAL | Agent/effort controls are 120 px and centered, but option rows are 22 px rather than the requested approximately 15 px. |
| CC09 | PARTIAL | Custom popovers are app-contained in implementation and visible controls open normally, but a full edge-position sweep was not possible after driver loss. |
| CC10 | PASS (static) | Defaults specify `openai-codex/gpt-5.6-sol`; the walkthrough showed a persisted user choice of Luna, which is not the factory default. |
| CC11 | FAIL | File attachment and explicit terminal controls remain as intended, but the composer placeholder/hint is still visibly present. |
| CC12 | PASS | Skill references render as compact `$skillname` mentions; injected bodies stay out of the composer. |
| CC13 | PASS | Skill-command insertion and ordinary leading-slash discovery checks passed. |
| CC14 | PASS | Menu selection/Tab/arrows/Escape/outside-click behavior is implemented and keyboard acceptance paths passed. |
| CC15 | PASS (static) | `/compact` is added to the command set when Pi does not supply it. |
| CC16 | FAIL | The focused empty-path check did not expose a role-alert containing `Path can't be empty`, although the literal error exists in `ProjectDialog.tsx`. |
| — | FAIL | Additional direct composer defect: Shift+Enter produced `First lineSecond line`; the newline was lost. |
| — | PARTIAL/FAIL | All native file-upload attempts left `.attachments` empty, including image/file/oversize cases. This may involve WebKitWebDriver file transport, but the required visible behavior was not demonstrated. |

### Prompt dictionaries (`PD01`–`PD06`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| PD01 | PASS (static) | Named dictionaries are represented in Settings and persisted under Pi Desktop configuration. |
| PD02 | PASS (static) | Dictionary enable/disable state is persisted. |
| PD03 | PASS (static) | Enabled-key collision validation rejects duplicate keys. |
| PD04 | PASS (static) | Active keys receive yellow highlight and hover replacement UI. |
| PD05 | PASS (static) | Substitution happens in submission processing; draft text remains unchanged. |
| PD06 | PARTIAL | Controls use standard focusable inputs/buttons, but a full keyboard-only dictionary creation/edit cycle was not run. |

### Tools, skills, and permissions (`TS01`–`TS10`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| TS01 | PASS (static) | Discovery covers both `~/.pi/agent/skills` and `~/.agents/skills`. |
| TS02 | PASS | Skill filter, individual toggles, and bulk toggle preserving user-only entries passed. |
| TS03 | PASS | Settings renders the compact two-row, larger-text skill display without paths. |
| TS04 | PASS | Skills appears above Tools. |
| TS05 | PASS | Removed skill-path/remove/global-code controls are absent. |
| TS06 | FAIL | Claude-style `disable-model-invocation` handling exists, but no Codex-convention `user-invocable-only` metadata handling was found. |
| TS07 | PASS | Both stdio and HTTP MCP creation, including HTTP headers, passed Settings acceptance. |
| TS08 | PASS (static) | Filesystem MCP integration is absent. |
| TS09 | PASS (static) | Agent/tool capability validation rejects denied or unavailable declarations before inference. |
| TS10 | PASS (static) | Tool permission is derived from current capability state rather than old transcript mentions. |

### Agents, sequences, and orchestration (`AS01`–`AS09`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| AS01 | FAIL | The focused flow created an agent in the UI, but it was absent from installed orchestration configuration afterward. |
| AS02 | PARTIAL | Default-agent disabled styling/state exists. The legacy test expects a native `<select>` and therefore does not exercise the current custom picker. |
| AS03 | PARTIAL | Selected-agent tool loading is implemented; picker-based round trip was not fully demonstrated due stale selector assumptions. |
| AS04 | PASS (static) | Broker addresses runtimes by `{hostId, sessionId}`. |
| AS05 | PASS | `list_agents` and `send_message` exist and are independently toggleable. |
| AS06 | PASS | Ordered sequence configuration and final-answer handoff acceptance cases passed. |
| AS07 | PASS | Visible-prefix foreground and remaining background/temporary-branch behavior is implemented. |
| AS08 | PASS | Orchestrator-gated mode exposes named/described targets through the orchestration tool. |
| AS09 | PASS | Work rendering showed `{name} called` for delegated orchestration events. |

### Remote machines and projects (`RM01`–`RM06`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| RM01 | PARTIAL | Remote-first-class routes/state exist and mocked remote project cases passed; real chat/terminal/create/open behavior needs an SSH host. |
| RM02 | PASS (mocked) | New Project uses the selected mocked machine's home rather than the desktop home. |
| RM03 | PASS (mocked) | Remote Open Project and directory-selection behavior passed mocked project checks. |
| RM04 | PASS (mocked) | Mocked VPS switching did not add redundant user-initiated notices. |
| RM05 | PASS (mocked) | Mocked remote selection remained responsive. |
| RM06 | BLOCKED | A concurrent slow remote Pi/large-history isolation stress test requires a real remote host and workloads. |

### Terminals (`TT01`–`TT10`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| TT01 | PASS | Terminal opens in a bottom panel belonging to the current session. |
| TT02 | PASS (static) | Native backend launches PTY-backed terminals rather than a mock output component. |
| TT03 | PASS | Focused add/delete/close checks passed; plus button and tabs are visible. |
| TT04 | FAIL | The implementation creates a PTY shell; no path was found that attaches to an already-existing original interactive Pi terminal session. |
| TT05 | PASS | UI says Delete terminal and tabs contain no code label. |
| TT06 | PASS | Exact no-CWD text is centered, larger, and less dim in the terminal screenshot. |
| TT07 | PARTIAL/FAIL | The focused terminal-output event check timed out, so non-duplication was not demonstrated. |
| TT08 | PASS (static) | Retained output is capped at `32 * 1024 * 1024` bytes per terminal. A 32 MB live stress run was not performed. |
| TT09 | PASS (static) | The Tauri launcher binds an available port with `listen(0)`. |
| TT10 | PARTIAL | Native test windows were visible; no simultaneous four-window quadrant arrangement was exercised. |

### Context, debug, and token accounting (`CD01`–`CD13`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| CD01 | PASS | Debug control is immediately left of Settings, defaults off in implementation, and `Ctrl+D` is configurable/defaulted. |
| CD02 | PASS (static) | Debug-mode response entries retain prompt context independently for each response. |
| CD03 | PASS (static) | System, Tools, Skills, and Instructions categories and distinct styles exist. |
| CD04 | PASS (static) | Context categories expand to literal stored request content. |
| CD05 | PASS (static) | Exclusive category totals and skill de-duplication are calculated before drawing the circular gauge. |
| CD06 | PASS | Context-after-compaction/history-event acceptance behavior passed; storage survives completion/reload paths. |
| CD07 | PASS (static) | Composer/response cache information is gated by the debug flag. |
| CD08 | FAIL | Focused debug cache case could not find `.cache-hit-rate`; required per-response cache status was absent in that scenario. |
| CD09 | PASS (static) | Session-wide cache counter is non-interactive and positioned by the terminal control. |
| CD10 | PASS (static) | No adjacent/previous-message cache comparison control exists. |
| CD11 | PASS | Compaction acceptance retained context instead of reporting zero. |
| CD12 | PASS | Usage-remaining control appears beside Settings; duration formatting handles days beyond 24 hours. |
| CD13 | PASS (static) | Per-session estimated API cost is hidden until session-row hover. |

### Diffs and changed files (`DF01`–`DF05`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| DF01 | PASS (static) | Response diff capture renders changed-file summary inside the message above actions. |
| DF02 | PASS (static) | Compact list includes all files and hover preview is positioned above it. |
| DF03 | PASS (static) | Diff text sizing, addition/deletion colors, and lighter filename styles are present. |
| DF04 | PASS (static) | Color backgrounds target marker/text spans rather than nested code wholesale. |
| DF05 | PASS (static) | Diff state is keyed by main/split session and reset on session lifecycle transitions. A two-pane live edit was not induced. |

### Logs, traces, and export (`LG01`–`LG08`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| LG01 | PASS | Session action is named **Open logs in browser**. |
| LG02 | PARTIAL | Native command uses the browser opener and omits the old notification; invoking the real OS handler was avoided during the test. |
| LG03 | PASS (static) | Viewer parses literal Pi request bodies and supports filtering. |
| LG04 | PASS (static) | Source JSONL link and emphasized request sequence number are rendered. |
| LG05 | PASS (static) | Repeated fields are summarized by count. |
| LG06 | PASS (static) | Tool schemas and exposed skills are separate inspectable categories. |
| LG07 | PASS (static) | Trace-reader tool returns filtered genuine user/completed-assistant conversation and excludes tools/injected/system/developer/AGENTS content. |
| LG08 | PASS (static) | Trace interpretation uses structured instruction/system/tool/skill fields for both CLI and Desktop formats. |

### Settings organization (`SO01`–`SO06`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| SO01 | PASS | Steering queue and Follow-up queue are absent from General. |
| SO02 | PASS | Model controls are in General below auto-compaction/automatic-retry settings. |
| SO03 | PASS | Settings navigation has no arrow SVGs. |
| SO04 | PASS | Settings header has visible top spacing. |
| SO05 | PASS | Default keybindings, restore/unassign behavior, Toggle terminal, and Toggle debug acceptance checks passed. |
| SO06 | PASS | Settings save and immediate runtime/UI update checks passed; save rejection also remained visible and recoverable. |

### Testing and development workflow (`TW01`–`TW10`)

| ID | Result | Evidence / observation |
| --- | --- | --- |
| TW01 | FAIL | WDIO acceptance cases exist, but the embedded Tauri provider cannot establish a session. |
| TW02 | PASS | Fallback checks exercised the visible native Tauri application, not a browser approximation. |
| TW03 | FAIL | Agent create/save acceptance exists and exposes the real persistence failure. |
| TW04 | FAIL | Three-session click-and-screenshot walkthrough could not complete because the fallback native session disconnected during transitions. Four other native evidence screenshots were captured. |
| TW05 | PASS | `docs/wdio-mcp-testing.md` is a short practical manual-testing guide. |
| TW06 | PASS | Native Tauri windows were visible during checks. |
| TW07 | PARTIAL | Mock conversations remain distinct in the acceptance harness, but no dedicated, keyboard-navigable in-Tauri prototype route was demonstrated. |
| TW08 | FAIL | Suite discovers 99 cases; no record accounting for the cited 101-to-99 reduction was found. |
| TW09 | PASS (static) | Tauri dev launcher chooses a free port automatically. |
| TW10 | PARTIAL | Documentation describes current intended flows, but embedded-provider breakage and stale native-`select` selectors show docs/tests are not fully synchronized with shipped UI. |

## Reported-defect retest (`DG01`–`DG16`)

These are acceptance gaps recorded separately in the source requirements. They overlap
with requirements above and are not an additional requirement count.

| ID | Result | Retest |
| --- | --- | --- |
| DG01 | REPRODUCED | Composer picker popup CSS is white. |
| DG02 | NOT REPRODUCED | Incremental text/thinking/tool event checks passed. |
| DG03 | PARTIAL | Ordinary active work stayed stable; explicit tool-summary interaction was not reliable through WebKitWebDriver. |
| DG04 | INCONCLUSIVE | Terminal event check timed out; duplicate output could not be ruled out. |
| DG05 | PARTIAL | Runtime design avoids switching aborts, but the fallback WebDriver itself disconnected during repeated switches. |
| DG06 | NOT REPRODUCED IN MOCK / BLOCKED REAL | Mocked remote selections remained responsive; no real host was available. |
| DG07 | REPRODUCED | UI-created agent was absent from persisted orchestration config. |
| DG08 | NOT REPRODUCED | Mocked project selection visibly updated. |
| DG09 | PARTIAL | Custom popovers replace old selects and are app-contained in CSS; edge sweep was incomplete. |
| DG10 | PARTIAL | Agent/model/effort controls are visible; stale tests cannot select them, and created-agent persistence still fails. |
| DG11 | NOT REPRODUCED | Five focused `/btw` cases passed. |
| DG12 | NOT REPRODUCED (static) | Context is stored/rendered per response rather than only on the newest response. |
| DG13 | NOT REPRODUCED | Context-after-compaction acceptance passed. |
| DG14 | NOT REPRODUCED | Stable WebKit scrollbar hover/active rules are present. |
| DG15 | PARTIAL | Browser-opening command is wired correctly; real desktop handler was not launched. |
| DG16 | PARTIAL | 32 MB cap is explicit; kill-threshold stress run was not performed. |

## Additional direct observations

- **Stale test selectors:** several failures search for
  `select[aria-label="Agent|Model|Thinking level"]`. The shipped UI uses custom
  accessible picker buttons/listboxes, visible in the shell screenshot. Those failures
  are test drift, not proof that the controls are absent.
- **Extension editor newline loss:** the multiline extension-input acceptance case also
  stripped its newline, corroborating the composer Shift+Enter failure.
- **Tool disclosure interactivity:** completed and failed `<summary>` elements were
  visible, but the driver considered them non-interactable.
- **Copy checks:** the code-block/copy case failed inside generated browser test code
  with `Can't find variable: __name`; product copy behavior remains unproven.
- **Terminal errors:** output, startup-failure, and input-failure event cases timed out in
  the focused native run.

## Recommended acceptance order

1. Repair embedded-provider session startup, then update WDIO selectors to the current
   custom picker contract.
2. Fix the confirmed product defects: agent persistence, multiline newlines, composer
   hint, dark picker menus, empty-path alert exposure, cache display, and attachment
   behavior.
3. Implement or explicitly remove from scope: pinned items, `Ctrl+Tab` session focus,
   and attachment to an original interactive Pi terminal.
4. Account for the 101-to-99 suite change and add the required stable three-session
   screenshot walkthrough.
5. Run the blocked real-environment matrix: SSH project/chat/terminal behavior,
   concurrent slow local/remote workloads, large histories, real automatic provider
   retry, browser-handler launch, and 32 MB terminal retention.

