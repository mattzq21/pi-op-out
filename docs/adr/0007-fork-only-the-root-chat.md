---
status: accepted
---

# Fork only the root chat, with copies of its auxiliary chats

Only root chats may be forked. Auxiliary chats, including subagent, review and btw chats, have no fork actions, and the backend rejects requests to fork them. Keep their parent records intact; removing those records to permit a fork would break this ownership rule.

Regular forks, worktree forks and fork and forget copy the root chat's history through the selected response. They also copy the auxiliary chats of the root chat that are not archived and were made at or before that response, with the auxiliary chats of those chats that are not archived. Each copy belongs to the fork and gets a new ID. Copied history that names a copied chat, such as a review link, names the copy. Archived auxiliary chats are not copied, and their copied rows keep naming the original chat.

A copy of a chat that was working ends with its last prompt and a fork error. When the fork starts, it sends that prompt again: a subagent through its new parent's subagent run, so the result goes to that parent, and other auxiliary chats as a message.

This applies to both fork types described alongside [ADR 0006](0006-chat-branches-and-restorable-worktrees.md). Regular forks share the current folder; worktree forks create a separate worktree, and the copies move to it.
