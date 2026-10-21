# Pi session-cost-limit extension

Stops a conversation once its spend reaches a per-conversation amount in API
prices (the same `usage.cost.total` totals piop shows per conversation).

There is no global setting. Manage the limit for the current conversation
with the `/cost` command:

- `/cost 5` (or `/cost $5`) caps this conversation at $5.00
- `/cost clear` removes the cap for this conversation

The amount is US dollars between 0.01 and 100000. New conversations start
without a limit. The limit is stored in the conversation and travels with
forks and branches; conversations that already have a saved limit keep it.

Run the extension directly:

```bash
pi --extension ./daemon/plugins/cost/index.ts
```

When the session cost on the current branch reaches the limit, new prompts
are swallowed with a warning (slash commands still work) and further tool
calls are blocked, so the agent winds down instead of spending more. The
live `Session $cost / $limit` status is published through
`ctx.ui.setStatus`, which piop renders above the composer.

piop stages this extension for local and remote sessions.
