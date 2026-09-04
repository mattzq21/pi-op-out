# Pi project files watch extension

This extension gives each Pi session a private Git snapshot after every successfully
completed assistant message. Before the next user prompt, it compares the current
worktree with that snapshot and prepends a compact `<project_context>` block containing:

- changed paths relative to the repository root;
- a ready-to-run `git diff` command for the complete patch.

The block is injected as a hidden custom message after the existing conversation
history and positioned immediately before the user's new message in model context. It
does not appear in the chat transcript. It is omitted until the session has a baseline
snapshot and when there are no changes to report.

Pi emits `message_end` for more than successful answers. The extension snapshots only
assistant messages whose `stopReason` is `stop`. It deliberately ignores intermediate
tool-use messages, user aborts, provider or network errors, truncated responses,
deferred responses, and recoverable failures that Pi may retry. If tools changed files
before an abort or error, the previous baseline remains in place, so those changes are
reported with the next user message.

Snapshots contain tracked files and non-ignored untracked files. They use a temporary
Git index, so the extension does not alter the real staging area, branch, `HEAD`, or
working tree. Ignored files and changes inside submodule worktrees are not captured.
When Pi's working directory is not inside a Git repository, the extension quietly
does nothing and leaves user input unchanged.

Each session owns exactly one hidden ref. Every snapshot has its own timestamped name:

```text
refs/pi-session-snapshots/chats/<session-id>/<timestamp>-<commit-prefix>-<nonce>
```

Creating a snapshot and deleting that chat's previous ref happen in one Git ref
transaction. Snapshots are not parent-linked, so the replaced commit becomes eligible
for normal Git garbage collection. There is no retention window: one ref remains for
each chat unless it is explicitly removed.

The extension also writes the current snapshot identity as a custom session entry.
Custom entries are excluded from LLM context but remain in the session JSONL, so when
the chat is archived its snapshot association is archived with it. Hidden commits do
not appear in normal branch history and are not pushed by ordinary branch pushes.

Run it directly:

```bash
pi --extension ./extensions/pi-project-files-watch/index.ts
```

To install it as an automatically discovered user extension:

```bash
mkdir -p ~/.pi/agent/extensions/pi-project-files-watch
cp extensions/pi-project-files-watch/index.ts \
  ~/.pi/agent/extensions/pi-project-files-watch/index.ts
```

Restart Pi or run `/reload` after installing it.
