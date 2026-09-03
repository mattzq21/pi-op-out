# Pi Git change-context extension

This extension gives each Pi session a private Git snapshot after every completed
assistant message. Before the next user prompt, it compares the current worktree with
that snapshot and prepends a compact `<project_context>` block containing:

- changed paths relative to the repository root;
- a ready-to-run `git diff` command for the complete patch.

The block is inserted after the existing conversation history and immediately before
the user's new text. It is omitted until the session has a baseline snapshot and when
there are no changes to report.

Snapshots contain tracked files and non-ignored untracked files. They use a temporary
Git index, so the extension does not alter the real staging area, branch, `HEAD`, or
working tree. Ignored files and changes inside submodule worktrees are not captured.
When Pi's working directory is not inside a Git repository, the extension quietly
does nothing and leaves user input unchanged.

Each session owns one hidden ref:

```text
refs/pi-session-snapshots/<session-id>
```

The ref points to the session's latest hidden commit, whose message includes the
session ID and timestamp. Snapshots are deliberately not parent-linked, so replacing
a snapshot makes its predecessor eligible for normal Git garbage collection. Whenever
a snapshot is saved, refs belonging to sessions inactive for more than 30 days are
deleted. Hidden commits do not appear in normal branch history and are not pushed by
ordinary branch pushes.

Run it directly:

```bash
pi --extension ./extensions/pi-git-change-context/index.ts
```

To install it as an automatically discovered user extension:

```bash
mkdir -p ~/.pi/agent/extensions/pi-git-change-context
cp extensions/pi-git-change-context/index.ts \
  ~/.pi/agent/extensions/pi-git-change-context/index.ts
```

Restart Pi or run `/reload` after installing it.
