# Pi context-window cap extension

Makes Pi treat every model whose advertised context window exceeds a configured
limit as if its context window were that limit. Pi's normal auto-compaction then
uses the capped value.

Set the limit in `config.json`, which is read when Pi loads the extension:

```json
{
  "enabled": true,
   "contextWindowCap": 300000
}
```

The value must be a positive integer. Restart Pi or run `/reload` after changing
it. Set `enabled` to `false` to use the model’s full context window; omitting it keeps the cap enabled.

Run the extension directly:

```bash
pi --extension ./extensions/piop-context-window-cap/index.ts
```

To install it as an automatically discovered user extension:

```bash
mkdir -p ~/.pi/agent/extensions/piop-context-window-cap
cp extensions/piop-context-window-cap/{index.ts,config.json} \
  ~/.pi/agent/extensions/piop-context-window-cap/
```

Once installed globally, start Pi normally. Edit the installed `config.json` to
change the limit.

piop stages its own copy of this extension and generates its `config.json`
from **Settings → General → Context window cap** for local and remote sessions.
The toggle enables or disables the cap while preserving the configured limit.
Saving settings applies the change to reconnected sessions.

The extension also saves one prompt-context snapshot when the initial user
message first reaches the model. Later tool steps and pause/resume reuse that
snapshot, including after reopening the conversation. Debug mode displays one
bar above the response, using the initial snapshot throughout. A new user
message starts a new snapshot.
