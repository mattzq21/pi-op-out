**Plugins** - piop-wide extensions. A Plugin is a folder with `plugin.json`, and its built Pi extension and app part. The built-in ones are in `plugins/`; a user adds others in `~/.piop/plugins/`.  
**Pi extension** - code that uses Pi's extension API. piop's core ones are in `pi-extensions/` and `daemon/resources/`; a Plugin's is in its folder.  
**Client server** - the daemon's WebSocket server (`daemon/src/clients/`), which all clients use: the desktop app, the Android app and other daemons.  
**Debug mode** - the mode toggled in piop's UI.  
**Orchestration** - Root agents messaging each other. Not to confuse with subagents.  
**Paired agent** - the agent that the voice agent talks to, also a Root agent.  
**Root agent/session** - the regular agent/session. Might have Auxiliary agents.  
**Auxiliary agent/session** - owned by Root agent/session. E.g. subagents, reviewing agent, Side chat. Shown in the side pane, not in the sidebar.  
**Side chat** - an Auxiliary chat that /btw makes: a copy of the Root chat's history through its last finished answer. It sends results to the Root chat with send_to_main.  
**Non-project session** - A session with no assigned project folder.  
**Folder-project session** - A session assigned to a folder that is not a Git repository root.  
**Repository-project session** - A session assigned to a Git repository root, including a linked worktree root. It can use either the main worktree or a linked worktree.  
**Main-worktree session** - A Repository-project session assigned to the main worktree created by `git init` or `git clone`.  
**Turn** - what's commonly known as agent turn: a reasoning, tool call etc.  
**Task** - from agent prompted to final response. One task has at least one Turn.
**Idle** - the session state before a Task starts or after the agent responds. Work can still be queued, and a goal can remain active.  
**Ready** - an Idle session with nothing queued, or queue stopped.
**Host** - a computer that stores sessions and runs agents.
**Anchor host** - the Host to which the client is connected. The client uses Remote hosts through it. 
**Remote host** - Host that Anchor host can connect to and run the daemon on over ssh.
**Project tooling** - bun, cargo, uv, jest etc. Don't confuse with agent tools.  
**Chat worktree** - a linked worktree that Piop made for a chat. Not the main worktree.  
**Setup scripts** - the user's scripts that Piop runs in a Chat worktree after it makes or restores it.  
**Cleanup scripts** - the user's scripts that Piop runs in a Chat worktree before it removes its folder.  

