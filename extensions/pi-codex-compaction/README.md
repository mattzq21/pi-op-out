# piop Codex compaction

Bundles [@ogulcancelik/pi-codex-compaction](https://github.com/ogulcancelik/pi-extensions/tree/451e49da38e117f11f4b8e622c2bc432444f8a3a/packages/pi-codex-compaction) **0.1.5**, pinned at commit `451e49da38e117f11f4b8e622c2bc432444f8a3a`, under its MIT license. Source is vendored so desktop builds and SSH startup do not need npm registry access or a second copy of the Pi SDK.

`upstream/index.ts` and `upstream/native-compaction.ts` have one integration change: an optional message transform runs before converting saved branch messages into provider input. The desktop entry point uses it to exclude paused partial responses, translate authorized resume markers with the session broker's shared helper, and preserve project context ordering. Checkpoint storage, provider requests, authentication, and compaction triggers remain upstream behavior.

Run `npm run build:extensions` after updating the vendored source. The generated bundle is embedded in the native binary, staged on local and SSH hosts, and passed to managed sessions and side conversations. Pi runtime imports stay external and resolve through the host's extension loader. The upstream license is included in the bundle.

Pi 0.84.4 or newer is recommended. Native compaction applies to `openai-codex` models using `openai-codex-responses`; other providers keep Pi's standard compaction. The app's existing auto-compaction setting, context cap, and `/compact` command control the normal Pi lifecycle. Native checkpoints require the same Codex model that created them; switching to another provider cannot recover the encrypted portion of the history. See [upstream documentation](upstream/README.md) for details and legacy Pi behavior.
