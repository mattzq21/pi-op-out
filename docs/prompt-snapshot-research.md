# Filesystem checkpoints for branching before a prompt

Research date: 2026-09-07. Original research follows below.

Accepted policy: retain the latest **10** checkpoints per conversation, automatically expiring the oldest on successful capture. The implementation uses this bounded policy instead of the full-history recommendation below. Ten limits retained restore points, not immediate physical disk usage; Git garbage collection reclaims expired objects later.

## Recommendation

Keep an immutable filesystem checkpoint for every executed user prompt, associated with its stable conversation entry ID. Capture and persist it before that prompt can execute tools. Branching before a prompt should create a separate worktree from that checkpoint and fork conversation history at the matching point. The latest-checkpoint pointer can advance automatically; previous checkpoint records must remain available. Two prompts ago is the same operation as one prompt ago, using a different entry ID.

“Before this prompt” means the files on disk immediately before its execution. It includes the user's already-existing uncommitted changes and excludes subsequent agent edits. “Last committed revision” is a different starting point. Editor buffers that have never been saved are outside a filesystem checkpoint.

This recommendation is a design inference from the application's current behavior and the primary sources below, rather than a universal retention standard.

## Current application behavior

- `branchConversation` in [src/App.tsx](../src/App.tsx) selects the next user entry to fork before, or clones history. It does not restore project files. The new-worktree path creates the worktree before forking and passes no prompt checkpoint identity.
- `create_git_worktree` in [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) creates from current `HEAD`, then applies the current binary diff and copies untracked files. Both local and SSH paths use current project state. Branching during a response therefore inherits edits already made; an in-place conversation fork continues to share those files.
- [src/components/ChatView.tsx](../src/components/ChatView.tsx) exposes worktree branching after completed assistant responses, not directly before a user prompt. A historical pre-prompt action needs an explicit entry point; selecting an earlier response while a later turn runs still uses today's files.
- [src/lib/sessionRuntimePool.ts](../src/lib/sessionRuntimePool.ts) starts an asynchronous turn snapshot upon `agent_start` for displaying diffs. Those snapshots are temporary: [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) prunes by age/count, and loading diffs consumes them. They are neither a durable history nor an awaited pre-execution barrier.
- [pi-project-files-watch](../extensions/pi-project-files-watch/index.ts) maintains one private snapshot after each successful assistant message. Saving a replacement deletes its previous refs. The `input` hook compares live files with that baseline to inject project context; it does not retain a durable pre-prompt checkpoint. This behavior is documented in the [extension README](../extensions/pi-project-files-watch/README.md).

The existing successful-response baseline serves a separate purpose: noticing changes between messages. Keep that baseline separate from prompt history. Its overwrite policy can remain; reusing it as the prompt checkpoint would lose history and change the meaning of project-context diffs.

## Options

| Policy | Before current prompt | Two prompts ago | Cost and consequence |
| --- | --- | --- | --- |
| Last committed revision only | Excludes pre-existing uncommitted work | Only if a commit happens to match | Already available through Git, insufficient for this feature |
| One overwritten pre-prompt checkpoint | Yes | No | Small metadata footprint, but recovery disappears on the next prompt |
| Last N checkpoints | Yes | Until evicted | Predictable count, arbitrary loss in long conversations |
| Per-prompt checkpoints retained with the session | Yes | Yes, while retained | Best match for branching from conversation history; requires lifecycle cleanup |
| Snapshot every tool edit | Yes, with grouping | Yes, with grouping | More events and complexity than the requested prompt-level branching needs |

Git's content-addressed objects allow different checkpoint records to reuse unchanged blobs and trees. Per-prompt history therefore need not copy the entire project for every prompt, although newly changed large files and full working-tree scans can still be expensive. [Git object model](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)

## Relevant precedent

Claude Code creates a checkpoint for each user prompt, persists checkpoints across resumed sessions, and presents earlier prompts as restore points. It separates restoring code, conversation, or both. Its documented default cleanup follows session cleanup after 30 days, configurable. This supports the interaction model, without establishing that 30 days is appropriate for Piop. Its checkpointing only tracks its editing tools: shell-command and external edits have documented gaps. [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)

The Claude Agent SDK explicitly distinguishes keeping only the latest checkpoint UUID from retaining multiple UUIDs with metadata. Its file rewind does not itself rewind the conversation. That distinction is useful here: conversation position and filesystem checkpoint should be linked explicitly, while each remains a separate resource. [Claude Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)

## Proposed storage and execution design

1. **Capture at execution admission.** Allocate a stable prompt/entry identity, serialize admission for the workspace, and await snapshot persistence before the runtime can execute that prompt's first tool. An asynchronous UI listener after execution has started cannot guarantee this ordering. For queued prompts, capture when each is consumed. Verify the exact awaitable hook and durable user-entry binding against the installed runtime; do not assume `before_agent_start` covers queued or steering messages. Steering within an active response needs an explicit runtime boundary and must not reuse a stale checkpoint under a new entry ID. Synthetic resume messages in [session-broker.ts](../src-tauri/resources/session-broker.ts) must not replace the original prompt checkpoint.
2. **Record the coordinate and state.** Persist session ID, prompt entry ID, host/repository identity, captured `HEAD` (or unborn state), snapshot tree/commit, capture time, schema version, and capture status. Use entry IDs rather than “-2” offsets: forks, queued prompts, and conversation compaction can change offsets. Persist the reference before marking the record ready; make retries idempotent and reconcile orphaned refs after crashes.
3. **Reuse the private-index machinery.** `GIT_INDEX_FILE` selects an alternate staging area; loading `HEAD` into that private index and updating it from disk avoids disturbing the user's real staging area. Capture tracked paths, deletions, and non-ignored untracked paths. [Git environment variables](https://git-scm.com/docs/git), [git-read-tree](https://git-scm.com/docs/git-read-tree), [git-add](https://git-scm.com/docs/git-add)
4. **Store immutable objects and durable refs.** `write-tree` serializes the prepared index. `commit-tree` can wrap that tree in a parentless private commit without moving the user's branch. Give each retained checkpoint an app-owned ref, preferably in a namespace separate from the extension's overwritten baseline. Pin the captured base `HEAD` separately as well: the parentless snapshot does not keep that base reachable if the user later rewrites branch history. Record unborn `HEAD` explicitly. Create refs with `update-ref`, using its expected-value checks or transactions. [git-write-tree](https://git-scm.com/docs/git-write-tree), [git-commit-tree](https://git-scm.com/docs/git-commit-tree), [git-update-ref](https://git-scm.com/docs/git-update-ref)
5. **Materialize in a fresh worktree.** Create the destination branch at the recorded original `HEAD`, then materialize the checkpoint's captured file tree into that destination, preserving those differences as uncommitted work. Do not make the private parentless snapshot the new branch's history. Reproduce captured additions and deletions, rather than copying today's live files. Linked worktrees have independent `HEAD` and index while sharing repository objects. [git-worktree](https://git-scm.com/docs/git-worktree)
6. **Fork using the same identity.** Only advertise the completed historical branch after both conversation fork and filesystem preparation succeed. If either fails, retain the source and clean up only newly allocated destination resources. Historical snapshots must be pinned for a child before the parent can be deleted.

## Retention and availability

Retain checkpoints while their session is retained, including archived sessions if archive is intended to be reversible. Delete app-owned refs when their owning sessions are permanently deleted and no child depends on them. Expose storage use and an explicit cleanup policy if a cap becomes necessary. A rolling latest pointer is useful for navigation, but is not the only durable reference.

A commit hash written in JSON does not protect the underlying Git object from collection. Git preserves objects reachable through `refs/*`; removing a ref makes otherwise-unreachable data eligible for later collection, not immediate deletion. Avoid parent-linking every checkpoint if individual expiration is needed: a retained descendant would keep its ancestors alive. Do not run aggressive immediate pruning as part of prompt handling. [Git garbage collection](https://git-scm.com/docs/git-gc)

For older prompts without a captured checkpoint, show “Project snapshot unavailable” and offer an explicitly labeled conversation-only branch or current-files branch. Never silently substitute current files for a historical checkpoint. A capture failure should be visible; if execution continues, that prompt must remain marked unavailable rather than pretending capture succeeded.

## Limits that affect the implementation

- A Git-tree checkpoint captures repository file content and Git-supported modes, not editor buffers, processes, databases, filesystem timestamps, or all filesystem metadata. The existing extension also excludes ignored files and submodule worktree contents; communicate this scope and handle unsupported repositories explicitly.
- `git add` can normalize line endings and invoke clean filters, while checkout can run smudge filters. A Git snapshot is not automatically a byte-for-byte backup of every original on-disk representation. Either define the feature as restoring Git-represented project files or design a raw-content sidecar for exact-byte requirements. [Git attributes and filters](https://git-scm.com/docs/gitattributes)
- Filesystem scanning is not an atomic filesystem snapshot. Awaiting capture prevents this agent's first tools from racing it, but other processes or conversations can still write concurrently. Coordinate Piop writers per worktree and detect/retry unstable captures where practical; full external-writer isolation requires a stronger filesystem mechanism.
- The current private index captures working-tree content, not the user's staged/unstaged split. Restoring the captured tree as uncommitted files is sufficient for the requested alternate branch; preserving staging exactly needs an additional index snapshot.
- Store and restore on the host that owns the repository. A ref shared between linked worktrees is not automatically available on another machine. Local and SSH paths need equivalent capture and materialization behavior.
- Enforce explicit size/failure status. Existing snapshot size limits were written for a context baseline; verify them for recovery semantics rather than allowing partial checkpoints to appear complete.

## Suggested delivery boundary

Implement durable per-prompt capture and historical worktree branching together, with clear unavailable states. Keep the existing current-files branch option. Add storage settings after measuring real usage; do not introduce automatic overwrite of historical checkpoints as the default. No tests or application code were written for this research.
