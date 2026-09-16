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

When a chat is forked into another worktree of the same repository, the new chat
pins the parent chat's current baseline commit under its own snapshot ref as the fork
starts. Copied
unstaged and untracked files are therefore reported on the first user message when
they differ from that baseline. From the new chat's first completed response onward,
its snapshots advance independently; replacing its snapshot never changes the parent
chat's snapshot. This also works when the worktrees use different filesystem paths,
because linked Git worktrees share the repository's object database and refs.
If the same chat is moved instead of forked, it keeps its existing snapshot ref and
uses the new worktree path in the injected diff command.

Each session owns exactly one change-reporting baseline ref, separate from its prompt checkpoints. Every snapshot has its own timestamped name:

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
pi --extension ./extensions/piop-project-files-watch/index.ts
```

To install it as an automatically discovered user extension:

```bash
mkdir -p ~/.pi/agent/extensions/piop-project-files-watch
cp extensions/piop-project-files-watch/index.ts \
  ~/.pi/agent/extensions/piop-project-files-watch/index.ts
```

Restart Pi or run `/reload` after installing it.

## Before-prompt checkpoints

The extension also retains the latest **10** filesystem checkpoints per conversation.
It awaits capture when a user message starts, including consumed steering and queued
follow-up messages, before the agent can execute tools for that message. Synthetic
pause/resume messages do not consume checkpoint slots. Capture failures are reported
and marked unavailable; a failed capture never reuses an earlier prompt's files.

Use **Branch before this prompt** beside a user message to create a separate worktree
and conversation at that point. The original conversation can keep running. The
selected prompt is put back in the new conversation's composer for editing. Existing
assistant-response worktree actions continue to copy current files.

Checkpoint refs live under
`refs/pi-session-snapshots/chats/<session-id>/prompts/`. A new checkpoint removes the
oldest retained ref when the count exceeds 10. Unchanged content shares Git objects;
expired objects are reclaimed by normal Git maintenance, so 10 checkpoints is a
history limit, not a hard byte limit or an immediate disk-space reclamation promise.
Snapshots persist across restart and archive. Forks independently pin available
inherited checkpoints; permanent conversation deletion removes that conversation's refs.

A checkpoint preserves tracked files, deletions, and non-ignored untracked files,
including uncommitted work already present before the prompt. Historical branching
starts at the captured Git HEAD and restores captured differences as uncommitted
files without changing the original staging area. Unsaved editor buffers, ignored
files, and submodule working directories are not captured. Existing file and snapshot
size limits apply. Older or failed checkpoints show an unavailable error instead of
silently copying current files. Git capture is not atomic against external writers.
