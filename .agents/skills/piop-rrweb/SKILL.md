---
name: piop-rrweb
description: Record, replay and read rrweb recordings of Piop's Tauri desktop or Capacitor Android web UI, with time markers and layout measurements, to answer DOM and layout debugging questions.
---

All paths are relative to the Piop checkout you work in. The tool is `node .agents/skills/piop-rrweb/scripts/piop-rrweb.mjs` (run `--help` for every command). Call it `rrweb` below.

The answer to a debugging question comes from `diff`, `attrs`, `texts` and the geometry samples, read in the terminal. The visual replay only confirms state. Plan the recording around markers: one mark before each action, then read the changes between marks.

## 1. Launch the app

Desktop (Linux, Tauri/WebKitGTK): in a persistent terminal run

```bash
python3 .agents/skills/piop-wdio/scripts/tauri-webdriver.py --project "$PWD" --isolated-profile
```

It builds and starts the app (2–3 min on a cold build) and prints JSON; note its `sessionFile`. Keep it running. Use `--isolated-profile` unless the task needs the user's real sessions: a shared profile puts real chat titles into the recording, and it may rebuild the daemon other launchers use. Run one launcher per worktree at a time. Sending a message needs a configured model; an isolated profile has none, so flows that need a reply (terminal panel, streaming) need the user's profile or a fake provider. See `.agents/skills/piop-wdio/SKILL.md` for the launcher's own tools.

If the app shows "Could not load settings" with "daemon_invoke not allowed" or a settings timeout, the shared cargo build dir (`.cargo/config.toml`) mixed in another worktree's build. Stop the launcher and relaunch it with `CARGO_BUILD_BUILD_DIR="$PWD/target/build-dir"` in its environment (first build takes longer).

Android: follow the WDIO WebView section of `.agents/skills/mobile-piop/SKILL.md` and inject the record bundle (`rrweb fetch` prints its path) with `execute_script` in the WebView context. The commands below assume the desktop session file.

## 2. Record

Export `PIOP_WDIO_SESSION=<sessionFile>` or pass `--session` to every command. Scripted flow:

```bash
rrweb record --session S --out /tmp/rec --track ".messages,.composer" --steps steps.json
```

`steps.json` is a list such as `[{"mark":"before"},{"keys":"Ctrl+B"},{"wait":1500},{"click":"button[aria-label='Settings']"},{"click":{"text":"Local","within":".settings-nav"}},{"type":["textarea","hello"]},{"drag":".plugin-resizer","dx":-150},{"wait":1000}]`. Every action adds a marker named after it (or `"label"`). Or step by step: `rrweb start --track SEL`, then `mark`, `click`, `type`, `keys`, `drag`, `js`, then `rrweb stop --out DIR`. To find selectors first, use `rrweb js 'return [...document.querySelectorAll("button[aria-label]")].map(b => b.getAttribute("aria-label"))'`; keybindings are in `clients/ui`.

Output: `events.json` (rrweb events with `mark` and `geometry` custom events), `geometry.json`, `recording.json` (marks, a settle report per mark and tracked selector, sampler health). `--track` samples bounding box and scroll position of each selector on a 20 ms timer plus Mutation/Resize observers. rrweb mutations do not measure layout, and CSS-driven size changes are invisible in them; only inline styles show up.

Facts about this WebView under WebDriver: `requestAnimationFrame` never fires (`visibilityState` is hidden), so never sample on animation frames. WebDriver screenshots hang. W3C pointer actions hang and `DELETE /actions` crashes the driver; `click` and `drag` therefore dispatch DOM events, which exercise the app's handlers but not native input. Keyboard actions work. Inputs are not masked by default (`--mask` masks them, but typed text still appears wherever the app mirrors it, for example the sidebar draft title).

## 3. Read the recording

```bash
rrweb summary events.json                              # counts per second, marker list
rrweb diff events.json --between open close            # adds/removes/text/attr changes with element paths; unchanged attribute rewrites hidden
rrweb diff events.json --from close --to 5             # a marker and a time in seconds mix
rrweb quiet events.json --after close --ms 2000        # last DOM change after each "close" marker; non-zero exit when one lands later than 2 s
rrweb find events.json "Message piop"                  # node id and path of an element
rrweb attrs events.json --id 180 --name style          # one node's attribute timeline, repeats hidden
rrweb texts events.json                                # text and input changes
rrweb dom events.json --at open --id 180               # DOM outline at a marker
```

`diff` flags `[placeholder]` for the empty text/comment nodes SolidJS keeps for conditional content, and counts placeholder swaps separately. rrweb sees DOM output only: a component that re-ran without changing the DOM, detached-node activity, and render cost are not in the recording.

## 4. Replay and verify

```bash
rrweb replay /tmp/rec --selector ".messages,.unsaved-badge" --at 2.5
```

This writes a self-contained `replay.html` with a button per marker, opens it in headless Chromium (Playwright's cached build; set `PIOP_RRWEB_CHROMIUM` to override), seeks to each marker plus 300 ms (`--after`) and each `--at` time, screenshots them (`replay-<label>.png`), describes the selectors inside the replayed document, plays to the end, and writes `verify.json`. It exits non-zero when playback did not finish or the page threw. Fonts load from Google Fonts, so an offline replay loses them; Chromium's text metrics differ slightly from WebKitGTK's.

## 5. Finish

Stop only your launcher (Ctrl+C in its terminal). Report platform, the recording and verify paths, what the diff or geometry showed, and what the recording could not show. Desktop capture is verified on Linux WebKitGTK; Android capture and playback are not verified yet. Native dialogs, Capacitor plugin internals, and Rust internals need separate instrumentation.
