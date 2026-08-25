# Pi context-window cap extension

Makes Pi treat every model whose advertised context window exceeds a configured
limit as if its context window were that limit. Pi's normal auto-compaction then
uses the capped value.

Set the limit in `config.json`, which is read when Pi loads the extension:

```json
{
  "contextWindowCap": 200000
}
```

The value must be a positive integer. Restart Pi or run `/reload` after changing
it.

Run the extension directly:

```bash
pi --extension ./extensions/pi-context-window-cap/index.ts
```

To install it as an automatically discovered user extension:

```bash
mkdir -p ~/.pi/agent/extensions/pi-context-window-cap
cp extensions/pi-context-window-cap/{index.ts,config.json} \
  ~/.pi/agent/extensions/pi-context-window-cap/
```

Once installed globally, start Pi normally. Edit the installed `config.json` to
change the limit.

Pi Desktop stages its own copy of this extension and generates its `config.json`
from **Settings → General → Context window cap** for local and remote sessions.
