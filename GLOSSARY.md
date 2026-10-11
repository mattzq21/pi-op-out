**Plugins** - piop-wide extensions, usually based on pi extensions.  
**Extensions** - agent defined, work only in that agent's session.  
**Button tool** - a tool that has no parameters.  
**Debug mode** - the mode toggled in piop's UI.  
**Orchestration** - root agents messaging each other. Not to confuse with subagents.  
**Paired agent** - the agent that the voice agent talks to, also a root agent.  
**Root agent/session** - the regular agent/session. Might have auxiliary agents.  
**Auxiliary agent/session** - owned by root agent/session. E.g. subagents, reviewing agent.  
**Subagents** - root agent and (grand/)children agents.  
**Turn** - what's commonly known as agent turn: a reasoning, tool call etc.  
**Task** - from agent prompted to agent settled.  
**Session tree** - a root session and all its subagent sessions. Avoid: conversation.  
**Storage transaction** - an archive, delete or restore of one or more sessions that fully happens or fully rolls back, also after a crash.  
**Host** - a machine that stores sessions and runs agents: the local machine or a remote machine over SSH. "Machine" is the UI word for it.
