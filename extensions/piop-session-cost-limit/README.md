# Pi session-cost-limit extension

Stops a session once its spend reaches a configured amount in API prices
(the same `usage.cost.total` totals piop shows per conversation).

Set the limit in `config.json`, which is read when Pi loads the extension:

```json
{
  "sessionCostLimit": 5,
  "enabled": false
}
```

`sessionCostLimit` is US dollars between 0.01 and 100000. Set `enabled` to
`false` to spend without a cap; omitting it keeps the limit enabled.
Restart Pi or run `/reload` after changing it.

Run the extension directly:

```bash
pi --extension ./extensions/piop-session-cost-limit/index.ts
```

When the session cost on the current branch reaches the limit, new prompts
are swallowed with a warning (slash commands still work) and further tool
calls are blocked, so the agent winds down instead of spending more. The
live `Session $cost / $limit` status is published through
`ctx.ui.setStatus`, which piop renders above the composer.

piop stages its own copy of this extension and generates its `config.json`
from **Settings \u2192 General \u2192 Session cost limit** for local and remote sessions.
Each conversation keeps the limit it started with, including whether it is
enabled. Saving settings applies the change to new conversations.
