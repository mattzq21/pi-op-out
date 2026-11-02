---
status: accepted
---

# Branch chats into separate worktrees and archive them with a snapshot

Branching creates an independent chat and Git worktree. Chat history stops at the selected response, and files come from the last commit of the source folder. Archiving saves a snapshot of the current files and protects it with an archive reference, so archived worktrees are restorable without depending on the branch name.

## Branch creation

- Show the button only under finished final assistant responses. Include the selected response and all history before it; exclude later history.
- Keep the original chat intact. Open the new chat with an empty input, focus the input, and leave the agent idle until the user sends a message.
- Use current settings. Give the new chat a clear name and a link to the original chat and selected message.
- Create the worktree from the last commit of the source folder. Do not copy uncommitted changes or untracked files. Do not restore files to the time of the selected response.
- Name the folder and the branch from the chat ID: use the shortest start of the ID, without hyphens and at least 4 characters long, that is free. A name is free when no folder or branch has it and no chat record uses it, including archived chats. The branch is `piop/<name>`. Do not generate descriptive branch text. Renaming a chat does not rename its branch.
- Put the worktree at `~/.piop/worktrees/<name>/` on the machine holding the repository, inside Piop's storage folder; debug builds use `~/.piop-dev/worktrees/<name>/`. No repository ID is needed in this path. Store the source repository location with the chat.
- Treat repeated clicks or retries during creation as one request until both the chat and worktree exist. A failed attempt must clean up its own partial results, including any branch it created. Show cleanup failures; do not silently leave them for a retry. After cleanup, a retry starts a new attempt.
- Share attachments between chats. Retain them until the last chat that uses them is permanently deleted. Archived chats still count.

## Repository detection

Check whether the project is in a Git repository when the project is added to Piop and whenever a new chat is created from that project. Save the result for the project. Do not check periodically or provide a manual recheck action. Branching into worktrees is unavailable for projects outside Git repositories; normal chats remain available. Report errors if a later Git operation fails.

Piop does not commit automatically. Only the user or the agent makes commits.

## Archive and restore

On archive, save a snapshot of the current files of the worktree: a commit on top of the current commit of the worktree that holds every file Git does not ignore. Do not change the branch, its history or the staging area. If no file changed since the last commit, use that commit as the snapshot. Removing the worktree deliberately discards ignored files.

Before removing a Piop-created worktree, protect the snapshot with `refs/piop/archives/<chat-id>` in the source repository's shared Git storage. Record the snapshot and the commit under it with the chat. If this protection cannot be saved, keep the worktree and report the error. Archiving a chat in the original project folder takes no snapshot and must never remove that folder.

The archive reference is independent of the branch and survives branch deletion or movement. It remains while the chat is archived. This is not a backup against deletion of the source repository itself.

Unarchiving restores the worktree at the commit under the snapshot, then puts the files of the snapshot back as uncommitted changes, before returning the chat to the active list. Do not open the chat or start its agent. Ignored files are not restored.

Reuse the original branch only if it still points to the commit under the snapshot and is available. Otherwise, create a branch with the next free name, as for a new chat. Reuse the previous folder path if free; otherwise, choose the next free name without overwriting an existing folder and update the stored path.

Repeated unarchive clicks use one restore request. On failure, the attempt cleans up anything it created, reports the error, and leaves the chat archived with its saved state intact. Keep the archive reference until restoration fully succeeds. Permanent deletion releases saved state only when no other chat needs it.
