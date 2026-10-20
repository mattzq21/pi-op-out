---
status: accepted
---

# Branch chats into separate worktrees and archive from saved commits

Branching creates an independent chat and Git worktree. Chat history stops at the selected response, but files come from the current working state. Automatic commits and a protected archive reference make archived worktrees restorable without depending on the original branch name.

## Branch creation

- Show the button only under finished final assistant responses. Include the selected response and all history before it; exclude later history.
- Keep the original chat intact. Open the new chat with an empty input, focus the input, and leave the agent idle until the user sends a message.
- Use current settings. Give the new chat a clear name and a link to the original chat and selected message.
- Create a separate worktree from current files, including uncommitted changes and untracked files. Exclude ignored files. Do not restore files to the time of the selected response.
- Name the Git branch `piop/<chat-id>`, using a full UUID: 36 characters including hyphens. Do not generate descriptive branch text. The UI may display a shortened ID; Git uses the full ID. Renaming a chat does not rename its branch.
- Put the worktree at `~/.local/share/piop/worktrees/<chat-id>/` on the machine holding the repository. No repository ID is needed in this path. Store the source repository location with the chat.
- Treat repeated clicks or retries during creation as one request until both the chat and worktree exist. A failed attempt must clean up its own partial results, including any branch it created. Show cleanup failures; do not silently leave them for a retry. After cleanup, a retry starts a new attempt.
- Share attachments between chats. Retain them until the last chat that uses them is permanently deleted. Archived chats still count.

## Repository detection and automatic commits

Check whether the project is in a Git repository when the project is added to Piop and whenever a new chat is created from that project. Save the result for the project. Do not check periodically or provide a manual recheck action. Branching into worktrees is unavailable for projects outside Git repositories; normal chats remain available. Report errors if a later Git operation fails.

Apply automatic commits to all chats in repositories, including chats in the original project folder. Use Pi's `turn_end` event, with this condition:

```ts
pi.on("turn_end", async (event) => {
  const message = event.message;

  if (
    message.role !== "assistant" ||
    message.stopReason !== "stop" ||
    message.content.some(part => part.type === "toolCall")
  ) return;

  // Await the save here, before a follow-up starts.
});
```

Save after each qualifying final assistant response and before processing a follow-up, including a queued follow-up. Do not wait for the agent to settle. Responses that end with tool calls, cancellation, failure, or a stop reason other than `stop` do not trigger a save.

For each save, run `git add .` from the repository root and commit changed content with the message `Piop saving progress`. Await this operation in the event handler. Skip empty commits and report save failures. Chats that share a folder can have their changes saved in the same commit; this is accepted. Git's normal ignore rules apply: ignored untracked files are excluded, but already tracked files remain tracked.

## Archive and restore

Archive from the last available commit. Do not create a final commit or save uncommitted changes at archive time. Removing the worktree deliberately discards changes after that commit and ignored files.

Before removing a Piop-created worktree, protect the selected commit with `refs/piop/archives/<chat-id>` in the source repository's shared Git storage. Record the restoration details with the chat. If this protection cannot be saved, keep the worktree and report the error. Archiving a chat in the original project folder must never remove that folder.

The archive reference is independent of the branch and survives branch deletion or movement. It remains while the chat is archived. This is not a backup against deletion of the source repository itself.

Unarchiving restores the worktree from the protected commit before returning the chat to the active list. Do not open the chat or start its agent. Restore no uncommitted or ignored files.

Reuse the original branch only if it still points to the saved commit and is available. Otherwise, create `piop/<chat-id>-<restore-id>` with a fresh full UUID for the restore attempt. Keep that ID throughout the attempt; later restores replace the suffix rather than append to it. The branch name is at most 78 ASCII characters. Reuse the previous folder path if free; otherwise, choose a fresh path without overwriting an existing folder and update the stored path.

Repeated unarchive clicks use one restore request. On failure, the attempt cleans up anything it created, reports the error, and leaves the chat archived with its saved state intact. Keep the archive reference until restoration fully succeeds. Permanent deletion releases saved state only when no other chat needs it.

This records the decision; implementation remains.
