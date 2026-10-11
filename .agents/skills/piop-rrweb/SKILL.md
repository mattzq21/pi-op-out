---
name: piop-rrweb
description: Record and replay Piop's Tauri desktop or Capacitor Android web UI with rrweb, including optional layout measurements.
---

1. Launch the requested worktree:
   - Desktop/Tauri: follow `~/.agents/skills/piop-wdio/SKILL.md`.
   - Android/Capacitor: follow the WDIO WebView section of `~/.agents/skills/mobile-piop/SKILL.md`; run `python3 ~/.agents/skills/mobile-piop/scripts/android-webdriver.py --project "$PWD"`. Read its live schemas and switch to the app's WebView context before executing JavaScript. Native broker tools cannot inject rrweb.
   Keep each launcher running; use its own session and current `execute_script` schema. For both platforms, launch the same worktree and export separate recordings.
2. Fetch `@rrweb/record@2.1.7` outside the repo. Inject `package/dist/record.umd.min.cjs` into the actual Tauri or Capacitor WebView through WebDriver; no app dependency changes needed.
3. Start recording before the interaction:
   ```js
   window.__rrwebEvents = [];
   window.__rrwebStop = rrwebRecord.record({
     emit: event => window.__rrwebEvents.push(event),
     maskAllInputs: true,
     inlineStylesheet: true,
   });
   ```
4. Perform the requested UI flow. For pixel measurements, separately sample `getBoundingClientRect()` and scroll positions on animation frames, retain changed states, and timestamp them alongside events. rrweb mutations alone do not measure geometry.
5. Call `window.__rrwebStop()`, retrieve the complete event array, and save JSON. Preserve the initial full snapshot and subsequent incremental events. Masked inputs do not hide message text rendered in the DOM.
6. For playback, load a matching rrweb replay bundle in a separate viewer and pass the events to `new rrweb.Replayer(events, { root })`; call `.play()`. Make recorded CSS, images, and fonts accessible; verify playback before claiming success.
7. Stop only your launchers when finished. Report platform, capture/replay errors, and artifact paths. Desktop capture was demonstrated on Linux WebKitGTK; verify Android capture and playback separately. Native dialogs, Capacitor plugin internals, and Rust internals require separate instrumentation.
