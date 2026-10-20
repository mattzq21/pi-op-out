---
status: accepted
---

# Fork only the main chat

Both regular forks and worktree forks copy only the main chat's history through the selected response, including any subagent results already in that history. They do not copy subagent or review chats; those remain owned by the original main chat, so copied history does not give the new chat ownership of existing auxiliary sessions.

Only main chats may be forked. Auxiliary sessions, including subagent and review chats, have no fork actions, and the backend rejects requests to fork them. Keep their parent records intact; removing those records to permit a fork would break this ownership rule.

This applies to both fork types described alongside [ADR 0006](0006-chat-branches-and-restorable-worktrees.md). Regular forks share the current folder; worktree forks create a separate worktree. Neither copies the session tree.
