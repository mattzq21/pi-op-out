**Plugins** - piop-wide extensions, usually based on pi extensions.  
**Extensions** - agent defined, work only in that agent's session.  
**Button tool** - a tool that has no parameters.  
**Debug mode** - the mode toggled in piop's UI.  
**Orchestration** - root agents messaging each other. Not to confuse with subagents.  
**Paired agent** - the agent that the voice agent talks to, also a root agent.  
**Root agent/session** - the regular agent/session. Might have auxiliary agents.  
**Auxiliary agent/session** - owned by root agent/session. E.g. subagents, reviewing agent.  
**Non-project session** - A session with no assigned project folder.  
**Folder-project session** - A session assigned to a folder that is not a Git repository root.  
**Repository-project session** - A session assigned to a Git repository root, including a linked worktree root. It can use either the main worktree or a linked worktree.  
**Main-worktree session** - A repository-project session assigned to the main worktree created by `git init` or `git clone`.  
**Subagents** - root agent and (grand/)children agents.  
**Turn** - what's commonly known as agent turn: a reasoning, tool call etc.  
**Task** - from agent prompted to final response. One task has at least one turn.
**Idle** - the session state before a task starts or after the agent responds. Work can still be queued, and a goal can remain active.  
**Ready** - an idle session with nothing queued, including no follow-up messages, and no active goal.

**Session tree** - a root session and all its subagent sessions. Avoid: conversation.  
**Storage transaction** - an archive, delete or restore of one or more sessions that fully happens or fully rolls back, also after a crash.  
**Host** - a machine that stores sessions and runs agents: the local machine or a remote machine over SSH. "Machine" is the UI word for it.  
**Anchor host** - the one Host that the mobile app connects to. The phone uses the anchor's added machines through it.  
**Host script** - a piop script that runs on a Host to read or change its stored data.  
**Restore receipt** - the saved result of a committed restore, used to answer a repeated restore of the same archived session tree.  
**Project tooling** - bun, cargo, uv, jest. Don't confuse with agent tools.
