# Pi context-window cap extension

Limits the context window that Pi uses for a session. Pi's auto-compaction then
uses the limited value. A cap larger than the model window uses the model window.

The cap of a session comes from, in this order:

1. A cap set in the session with `/cap`.
2. The agent cap (Settings → Agents → Context cap).
3. The model cap (Settings → General, next to each model).
4. The general cap (Settings → General → Context window cap).

A cap is a token count from 100k to 50m, for example `300000`, `300k` or
`0.3m`. `model_default` uses the full model window.

Commands:

- `/cap` shows the current cap.
- `/cap <value>` sets a cap for this session.
- `/cap model_default` uses the full model window for this session.
- `/cap reset` removes the session cap.

While the agent works, a change is kept and applied when the agent stops.
The session log records only changes to the applied cap.
