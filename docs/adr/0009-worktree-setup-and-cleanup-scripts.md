---
status: accepted
---

# Worktree setup and cleanup scripts

A chat worktree starts without ignored files, such as installed dependencies, and archive deletes them again. Users run the scripts that set up and clean up a chat worktree. Piop runs these scripts itself. This is part of the core, because chat worktrees are part of the core.

## Scripts

- Setup scripts are in `.piop/worktree-setup/`. Cleanup scripts are in `.piop/worktree-cleanup/`.
- Each folder has a global copy in Piop's storage folder (`~/.piop/`, `~/.piop-dev/` for debug builds) on the host that holds the repository. It also has a repository copy in the chat worktree.
- Piop merges the global and repository folders by file name. A repository file replaces a global file with the same name. Piop runs each file of the merged list in name order and stops at the first failure. A file that is not executable is a failure. Names that start with `.` are ignored.
- Setup scripts come from the files of the new chat worktree. Cleanup scripts come from the current files of the worktree, including uncommitted changes.
- The scripts run in the chat worktree. They get one environment variable: `PIOP_REPOSITORY`, the path of the main worktree.
- Repository scripts run without asking. An agent in that repository can already run any code.

## Setup

- Setup runs after Piop makes a chat worktree: branch, new worktree chat, peer branch-off, and unarchive. It never runs for the main worktree.
- The chat is available at once, and setup runs in the background. The first message to the chat waits until setup is done.
- The chat shows the setup output live in a collapsed block. The user can stop setup. There is no time limit.
- When setup ends, Piop adds its result to the transcript before the first message, so the chat keeps the block. Only a failed or stopped setup is sent to the model.
- If setup fails or stops, the chat and the worktree stay. The first message is then sent, with a short note about the failed script and the end of its output, so that the agent can fix it. Piop does not run setup again; the user or the agent runs it by hand. A daemon stop during setup counts as a failure.

## Cleanup

- Cleanup runs before Piop removes the folder of a chat worktree, also when no setup ran before. It is the first step of archive and permanent delete: it runs before the snapshot and before anything is final. It does not run when a failed creation removes its partial worktree, nor when other chats still use the folder.
- If cleanup fails, the worktree stays, the chat stays active, and Piop shows the error with the cleanup output. There is no bypass; the user fixes the script. If the daemon stops during cleanup, nothing was final, and the chat stays active.
- If a later step of archive or delete fails, the chat stays active with its cleaned worktree, and Piop reports the error. Piop does not run setup again.
- A chat is archived and deleted together with its subagent chats, so a cleanup failure in any of them stops the action. Other actions continue.

## Consequences

- A broken cleanup script blocks archive and permanent delete of chat worktrees in that repository until the user fixes it.
- Permanent delete of an archived chat runs no cleanup, because archive already removed the folder.
