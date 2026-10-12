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
**Anchor host** - the one Host that the mobile app connects to. The phone uses the anchor's added machines through it.  
**Host script** - a piop script that runs on a Host to read or change its stored data.
**Restore receipt** - the saved result of a committed restore, used to answer a repeated restore of the same archived session tree.

**Fast-mode choice**:
The session's saved on/off choice to request fast mode. An on choice does not prove that the model supports it or that the provider uses it.
_Avoid_: Active fast mode

**Fast-model support**:
Whether a model supports fast mode for the applicable provider and account.
_Avoid_: Fast-mode choice

**Model scan**:
An attempt to obtain current model information from its source. A refresh check can reuse saved information without starting a scan.
_Avoid_: Refresh check
