# Validation of FINDINGS.md — 2026-09-18

Reviewed all finding IDs F-001–F-075 against commit `bb08854f00cb72f82598ac683d58e6623825b7fc` in this worktree. The input was the untracked `/home/matt/Projects/piop/FINDINGS.md`, SHA-256 `ffff14d98f2eab1a2d00dc91183229733c24dce530cee088869255c058bb8465`. It is absent from this worktree; the original log was left unchanged. The main checkout contains additional uncommitted edits, and the log describes an older release binary, so these verdicts concern the named commit, not that historical binary.

The log contains useful bugs, duplicates, expected behavior, and several incorrect conclusions. The strongest actionable findings are missing keybinding defaults, `/catch-up` dropping images and ignoring streaming behavior, unbounded content-index allocation, and malformed event/render data causing failures. The repeated **CRITICAL** labels are not established security severities: mock-injected invalid data proves a robustness defect, not an attacker-accessible production payload.

## Verification and limits

[Executable probes](test/validation/findings.mjs) bundle current TypeScript/React modules and run them in headless Chromium. Private helpers are exported temporarily during bundling; the App send closure is extracted from the current source. No production source was changed. Browser-side commands are mocked; no real agent prompts, settings changes, file uploads, or account operations were performed.

Run with installed project dependencies and Chromium:

```sh
node test/validation/findings.mjs
```

For this worktree, which has no node_modules, the executed command was:

```sh
PIOP_VALIDATION_DEPS=/home/matt/Projects/piop node test/validation/findings.mjs
```

All 39 observation probes passed. **PASS means the recorded observation or correction holds, not that the app is bug-free.** The results are in [findings-results.json](test/validation/findings-results.json). They include actual React root failures for null assistant content, object-valued pending messages, and missing prompt-context tokens; helper failures for storage data; real transport listener starvation; and the actual App send routing with image payloads. The allocation probe stops at 1,000,000; no OOM was attempted.

No native Tauri/WebKit release rebuild, Android device session, historical wdio session, real authentication attempt, or exhaustive application navigation was run. Code-only and historical observations below are explicitly distinguished from executed probes. Helper-level failures do not independently reproduce an entire native application white screen.

## Corrections that materially change the log

- **F-038:** A synthetic `cancel` event reaches React's `onCancel` handler in the actual ExtensionDialog. Dialogs explicitly call cancellation callbacks, which their owners use to remove them. The general “Android Back cannot dismiss dialogs; needs .close()” claim is unsupported. Pending responses can intentionally block cancellation (F-016); native Android behavior still needs a device test.
- **F-072:** `Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare('Alpha', 'alpha')` returns **0**, not -1. The actual duplicate-name predicate uses this comparator. Both create and rename inputs have Enter handlers. The null-name failure and invisible/uncapped names remain separate valid concerns.
- **F-071:** Drag reordering also filters to the same `behavior`; it does **not** reorder across steer/follow-up queues. The object-child crash is reproducible. Normal queue insertion creates UUIDs and coerces message text to strings, so duplicate/object payloads require corruption or an alternate producer.
- **F-065:** Current plain Enter with no matching suggestion submits the typed path for validation. It does not silently select home. Ctrl+Enter and “Open current folder” intentionally select the listed directory. The home-prefix input issue in F-069 is separate.
- **F-032:** 32 zero-width characters satisfy the frontend length check. This is **not an authentication bypass** and does not bypass a 32-character length requirement; the real host must still match the pairing token.
- **F-034/F-058:** Lexical normalization and opening a user-selected file outside the project do not establish a project sandbox escape. Neither feature promises confinement to the repository. The diff normalizer does not itself read a file. Basename-only display can obscure provenance.
- **F-033/F-063:** Error replacement depends on event order. `onerror` → rejected-promise handler → `onclose` reproduces the generic overwrite; `onclose` rejecting first can be followed by the specific catch handler instead. Failed first connections do not persist the host; successful ones do. Keeping the token only in memory is explicitly stated in the UI.
- **F-004/F-031/F-048:** NaN reset time is falsy at the actual render gate, so `formatCodexReset(NaN)` alone does not prove a visible `NaNm` badge. Missing warnings produce `[undefined]` (JSON serialization displays `[null]`). Extensionless files are accepted if their MIME type is supported; this is not a universal filename-only rejection.

## Per-finding verdicts

“Reproduced” identifies a current-source executable observation. “Supported” means source review supports the stated mechanism, with no new end-to-end reproduction. “Partial” narrows or corrects the claim. “Unverified” means the historical observation or sparse description cannot establish a current defect. Source paths name the relevant functions/components for follow-up.

| ID | Verdict | Evidence and qualification |
| --- | --- | --- |
| F-001 | Unverified / tooling | Historical wdio transport failure, not a demonstrated piop defect. No current launch_chrome test. |
| F-002 | Supported / expected | `src/lib/platform.ts` invokes native Tauri outside mobile mode. A plain desktop frontend requires its host; mobile mode is the supported browser/remote path. |
| F-003, F-006 | Reproduced primitive; send path supported | `Composer.submit` and Send disabled-state use trim. U+200B remains nonempty; FEFF is removed. UX validation issue, not a universal prohibition on invisible characters. |
| F-004 | Partial / reproduced helper | `App.formatCodexReset` returns NaNm/Infinityd, but NaN fails the render's resetAt truthiness gate. JSON cannot transport NaN/Infinity as numeric literals. |
| F-005 | Reproduced | `messages.cacheHitStats({})` returns NaN rate. Requires incomplete/malformed usage data. |
| F-007 | Unverified | “ProjectDialog path edges (minor)” gives no concrete assertion; specific picker cases are assessed in F-065/F-069. |
| F-008 | Reproduced | `messages.applyAssistantMessageEvent` allocates 1,000,001 content entries for index 1,000,000. Unbounded loop is real; critical remote exploitability and 100M OOM were not established. Both transport and chat reducer call this helper. |
| F-009 | Reproduced | `keybindings.matchesShortcut` cannot match Ctrl++; the recorder can produce that spelling. Rust canonicalization also splits on + and rejects the resulting keyless form. |
| F-010 | Reproduced; call-site caveat | Null normalizeMessage input throws; null-role history message is skipped. Live `useChatSession` can dereference rawMessage.role even before normalization. Do not conflate a null message with null content. |
| F-011 | Reproduced scaling; timing revised | 100k-entry parent chain ran in hundreds of milliseconds in Chromium (see JSON). `branch.unshift` repeatedly shifts the array. Historical 1389ms is environment-specific, not a stable threshold. |
| F-012 | Reproduced validator / healthy | `remoteClient.validateHost` rejects insecure protocols and URL credentials/query/fragment. These are application checks, not all native HTML validation. |
| F-013 | Supported / partly intentional syntax | `App.send` treats a first argument beginning with a signed digit as response number: `123abc` becomes an invalid number. `/worktree 0 123abc` disambiguates a digit-leading name. ZWSP remains nonempty. |
| F-014 | Reproduced | `branchMessages` dereferences entry.id before validation; null entry throws. Non-array entries also fail. |
| F-015 | Supported; performance unverified | `ExtensionDialog` maps all options with key=option. Duplicates share keys; no frontend count cap. Historical 10k timing not re-run. |
| F-016 | Partial | ExtensionDialog blocks all responses/cancel while awaiting onRespond. However native daemon requests have a 660-second timeout (`src-tauri/src/daemon.rs`), as does mobile invoke. “No escape forever” overstates the production hang. |
| F-017 | Supported | Rename, relocate, and settings name/command checks use trim, which preserves ZWSP. Backend acceptance/execution differs by field and was not asserted. |
| F-018 | Reproduced UI classification | `voiceMessages.parseVoicePrompt` classifies a typed voice marker as piop-voice and changes its ID/content. This proves spoofable UI metadata, not privilege escalation or genuine audio origin. |
| F-019 | Supported / delimiter ambiguity | `Composer.submit` escapes filename attributes but inserts text-file content verbatim into `<file>`. A file containing `</file>` breaks the textual framing; this is not HTML execution, and model behavior was not tested. |
| F-020 | Reproduced | App's lowercase catch-up branch omits images. Duplicate of F-056 and image half of F-070. |
| F-021 | Not a reachable UI defect as stated | `usePendingMessageDrag` excludes the source ID from candidate targets. A self-target arithmetic example requires bypassing this condition. |
| F-022 | Supported only for malformed queue | Composer keys/addresses controls by pending ID. Duplicate IDs collide; daemon queue normally generates UUIDs. Also covered by F-071. |
| F-023 | Supported structure; timing unverified | Composer renders all pending rows. 200-item smoothness is an observation, not a defect or a tested cap. |
| F-024 | Partial / latent guard gap | `App.selectSession` lacks canLeaveSettings, but SessionPanel is mounted only in chat view. Ordinary sidebar clicks from Settings are not demonstrated; a reachable alternate trigger is needed. |
| F-025 | Supported | Frontend duplicate detection uses lowercase literal strings; Rust keeps Mod and Ctrl distinct. `matchesShortcut` lets Mod overlap Ctrl (or Meta), so conflicting global actions can be saved. |
| F-026 | Supported | README specifies Ctrl+click; `Message.MarkdownLink` opens HTTP(S) URLs on ordinary click. Documentation mismatch. |
| F-027 | Supported, helper failures reproduced | StorageSettings trusts report categories/archives. See F-059/F-061; malformed frontend payload, not proven output from the normal inventory producer. |
| F-028 | Reproduced | `expandSkillReference` returns after the first known reference and skips slash-prefixed input. Whether multiple skill expansion is intended needs a product decision. |
| F-029 | Reproduced | `branchMessages` Map keeps the last duplicate ID. History-format corruption is required; no normal duplicate-ID producer established. |
| F-030 | Reproduced | `textOf`/`thinkingOf` assume string or valid content-part array. Null and non-array content throw. |
| F-031 | Partial / helper failure reproduced | Null patch throws; toolCallIds/paths are unchecked in turnDiff. Missing warnings yield undefined, not actual null. Standard custom-entry ingestion through appendFileChanges already validates these fields; an alternate malformed snapshot path is needed to establish production reachability. |
| F-032 | Reproduced, mischaracterized | Invisible token passes the format check, but has 32 characters and cannot authenticate unless it matches the host token. Validation/feedback concern only. |
| F-033 | Reproduced with explicit schedule | Error then close can overwrite the specific error. “Generic always wins” is false; promise/event ordering matters. |
| F-034 | Behavior reproduced; security claim unsupported | `turnDiff.absolutePath` resolves ../../etc/passwd to /etc/passwd. This is display/dedup normalization, not a filesystem confinement boundary or file read. |
| F-035 | Reproduced URL normalization; storage supported | URL removes U+200B in hostname; MobileApp persists trimmed raw URL after successful connection. Low-impact representation discrepancy. |
| F-036 | Partial | DiffViewer reducers trust additions/deletions. String arithmetic would concatenate, but normal values are generated numerically by `lib/diff.ts`; no ordinary backend input path to injected counters established. |
| F-037 | Partial; superseded by F-072 | Null-name group need not crash heading render. It can fail name validation through group.name.trim. |
| F-038 | Contradicted as blanket claim | Actual ExtensionDialog receives the synthetic cancel event and invokes onRespond(cancelled). Native Android bridge and pending-response exceptions were not exercised. |
| F-039 | Supported / benign shape gap | `initialWindowTarget` accepts JSON arrays as objects. Constructor generally treats missing named properties as defaults; no harmful outcome established. |
| F-040 | Supported robustness issue | App setWidget accepts lines without per-line validation; ChatView renders each as a child. Object-valued lines can fail rendering. Count/timing claims not re-run. |
| F-041 | Supported | `startNewSession` treats ZWSP draft as nonempty through trim, prompting discard. Same primitive as F-003. |
| F-042 | Reproduced matcher; backend supported | Ctrl+N+XYZ, Ctrl+Control and bare Space behave as described. Rust parser also picks first non-modifier; its validation is not generally “solid.” |
| F-043 | Supported | Composer's restoredDraft effect marks ID consumed before checking whether value is empty. Existing user draft is preserved, but aborted prompt is not retried by that effect. User-visible recovery elsewhere not tested. |
| F-044 | Reproduced missing-token root failure | PromptContextBar accesses context.tokens without validation. Invalid numeric shares are also unchecked. Producer and debug-view reachability determine impact. |
| F-045 | Supported robustness issue | HooksSettings calls listing.hooks.filter and hook.entry.toLocaleLowerCase. Null collection/invalid entry fail; malformed real producer not established. |
| F-046 | Reproduced | `userMessageParts` extraction is case-sensitive; fallback literal detector is insensitive. Lowercase generated skill blocks work; uppercase input takes the literal-display fallback. Primarily display inconsistency. |
| F-047 | Supported | Tool input pretty-print debraces any non-null object, including arrays, using slice(1,-1). Stored/sent arguments are unchanged; display loses brackets. |
| F-048 | Partial | Files without listed extensions and without supported MIME types are rejected. `text/*` or known text MIME passes regardless of filename. No blanket Makefile/Dockerfile/LICENSE rejection. |
| F-049 | Supported pipeline behavior | Composer expands skills after dictionary replacement. A replacement introducing $linter can invoke it. Proposed ordering change affects desired semantics; not automatically the correct fix. |
| F-050 | Reproduced | Actual NativeTransport.emit stops calling listeners after a listener throws; no isolation. Does not imply all subsequent future events are permanently starved. |
| F-051 | Supported / low | Pending text is reused in row labels/titles. Long labels increase DOM/accessibility verbosity; historical “~5x” is not a measured memory bound. |
| F-052 | Supported conditional growth | useChatSession stores active IDs by arbitrary role strings. End events delete them and refresh/transport changes clear the map; growth requires many distinct unended roles. |
| F-053 | Reproduced helper | Search normalizes collapsible document whitespace but not query whitespace. Direct newline/double-space queries miss. Actual single-line search input may strip pasted newlines, so helper behavior does not prove every paste scenario. |
| F-054 | Reproduced | findMatches flushes on nearest block changes; phrases across paragraphs/messages do not match. Whether cross-message search should match is a product choice. |
| F-055 | Supported | Context cap input has min/step but no maximum or safe-integer validation. Rust u64 deserializer reports “whole number” when as_u64 fails, including range overflow. |
| F-056 | Reproduced | Lowercase catch-up drops images; uppercase skips the special branch and keeps them. This does not prove uppercase is recognized as the same backend command. |
| F-057 | Reproduced render failure; historical chain corrected | Rendering a normalized assistant message with null content fails in textOf/thinkingOf and clears the test React root. normalizeMessage itself preserves null content; it is not the throwing helper. Normal backend generation and native full-app sequence were not re-run. |
| F-058 | Behavior supported; sandbox interpretation rejected | URL/path resolution plus read_dropped_file opens the requested file without a project-root restriction. It is an intentional general attachment reader; basename-only framing can hide origin. |
| F-059 | Reproduced lookup failure; app path supported | Unknown category makes categoryDetails[id].icon throw. StorageSettings and root have no protective boundary. Inventory normally emits fixed categories. |
| F-060 | Supported migration bug; throw reproduced | serde(default) fills an absent keybindings field, not missing entries in an existing map. migrate_keybindings removes retired keys/changes Ctrl+L but does not add toggleDebugMode. SettingsView dereferences missing value.trim; global matcher can also fail on undefined.split. Real stored settings were not modified. |
| F-061 | Reproduced helpers; render path supported | Invalid date throws only on archive rows using formatDate (deletable=true); object name is an invalid React child; invalid size formats as NaN KiB. Malformed input condition must be stated. |
| F-062 | Supported | App runtimePool errorHandler gives all errors the “Project changes” title, including retainSession failures. |
| F-063 | Partial | No retry spacing is implemented, but Connect disables while pending. Successful host is persisted; unsuccessful new host is not. Token intentionally stays in memory. Generic-error issue is F-033. |
| F-064 | Supported structure; performance unverified | SessionPanel maps all expanded/filtered rows without virtualization. Collapsed groups/search affect mounted count. Historical 5k/4.6s measurement not reproduced here. |
| F-065 | Contradicted for current plain Enter | ProjectDialog submits typed path when no suggestion matches; App calls validateProjectDirectory and preserves dialog on error. Current-folder button/Ctrl+Enter are explicitly different actions. |
| F-066 | Partial | ZWSP dictionary word passes trim validation. It is not inherently a dead entry: dictionaryMatches can match it where boundary checks permit. No match in plain text lacking that word is expected. |
| F-067 | Supported; matcher reproduced | Backend permits bare Space; global App shortcut handler does not exclude composer input and prevents default. Real setting persistence/typing hijack not repeated. |
| F-068 | Partial | setTitle is an intentional extension capability, not by itself an unauthorized spoof. addNotice appends without cap/expiry, so accumulation is supported. Historical 60/30s and 500-status tests not repeated. |
| F-069 | Partial | WorktreeDialog checks nonempty name; backend validation is legitimate. Home-prefix input can prepend ~/ to a pasted absolute path. Symlink selection can preserve link paths; list_directories does canonicalize its requested listing path. No actual home jail: .. can traverse ancestors. |
| F-070 | Reproduced frontend routing | Actual App send emits prompt for catch-up despite followUp/steer and omits images. Daemon excludes slash prompts from automatic follow-up conversion, but routes through queue.command; serialization exists. Concurrent-turn collision remains unproven. |
| F-071 | Partial; object-child root failure reproduced | Object message yields exact React object-child error. Duplicate IDs are malformed-input concern. Claimed cross-behavior drag is false: drag peers also require matching behavior. Other historical action/error controls not re-run. |
| F-072 | Partial; key corrections reproduced | Null group.name throws before finishGroup's try block; ZWSP and uncapped names pass. Alpha/alpha compare equal and duplicate check rejects them. Create and rename both handle Enter. Rename error lacks create's describedby link; aria-invalid is present. |
| F-073 | Source-supported healthy behavior; live results unverified | App uses eight-tab cap/notice, routes by active ID, and coerces terminal event fields. Historical multi-tab typing and recovery battery not repeated. Component remount key explains stale handles. |
| F-074 | Frontend matrix reproduced; end behavior unverified | Worktree blocks streaming; catch-up emits prompt ignoring modifier; compact text uses follow_up/steer. Backend result of queued slash text cannot be inferred from mocked send. Idle Ctrl+Enter matching normal send is harmless. |
| F-075 | Supported | Relocate handler rejects empty trim result, preserves error dialog, but passes ZWSP path. Actual relocation/reconnect and historical OS error not repeated. |

## Recommended triage

1. Fix missing keybinding default migration (F-060) and the independently reachable parser/Space-binding issues (F-009/F-025/F-042/F-067).
2. Fix catch-up attachment loss and define streaming slash-command behavior (F-020/F-056/F-070/F-074).
3. Bound content-index allocation and validate incoming content/queue shapes; add render error containment and isolate event listeners (F-008/F-030/F-050/F-057/F-071). Keep malformed producer reachability distinct from frontend failure severity.
4. Harden the remaining report/group/context trust boundaries; prioritize actual producers or stored data that can produce these shapes.
5. Consolidate duplicates and retain performance figures as historical measurements. Do not treat feature design choices, legitimate path normalization, intentional ephemeral tokens, or mocked attack-shaped values as independently confirmed security bugs.
