**Plugins** - piop-wide extensions. 
**Debug mode** - the mode toggled in piop's UI.  
**Orchestration** - root agents messaging each other. Not to confuse with subagents.  
**Paired agent** - the agent that the voice agent talks to, also a root agent.  
**Root agent/session** - the regular agent/session. Might have auxiliary agents.  
**Auxiliary agent/session** - owned by root agent/session. E.g. subagents, reviewing agent, btw chat. Shown in the side pane, not in the sidebar.  
**Side chat** - an auxiliary chat that /btw makes: a copy of the root chat's history through its last finished answer. It sends results to the root chat with send_to_main.  
**Non-project session** - A session with no assigned project folder.  
**Folder-project session** - A session assigned to a folder that is not a Git repository root.  
**Repository-project session** - A session assigned to a Git repository root, including a linked worktree root. It can use either the main worktree or a linked worktree.  
**Main-worktree session** - A repository-project session assigned to the main worktree created by `git init` or `git clone`.  
**Turn** - what's commonly known as agent turn: a reasoning, tool call etc.  
**Task** - from agent prompted to final response. One task has at least one turn.
**Idle** - the session state before a task starts or after the agent responds. Work can still be queued, and a goal can remain active.  
**Ready** - an idle session with nothing queued, including no follow-up messages, and no active goal.
**Host** - a computer that stores sessions and runs agents: the local host or a remote host over SSH.
**Anchor host** - the one Host that the mobile app connects to. The phone uses the anchor's added hosts through it. 
**Project tooling** - bun, cargo, uv, jest. Don't confuse with agent tools.  

