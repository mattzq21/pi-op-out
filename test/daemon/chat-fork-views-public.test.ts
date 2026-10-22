import { test, expect } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
for (const mode of ['copy_after', 'fork_after']) test.concurrent(mode + ' switches both requesting views', async () => {
 const agents=await agentDaemon();
 try {
  agents.scripts.set('Question', () => ({text:'Answer'}));
  const source=await agents.rootChat({repository:true});
  await source.command({type:'prompt',message:'Question'});
  await source.until(messages=>text(messages.at(-1))==='Answer');
  const original=await source.command({type:'get_state'});
  const entry=(await source.command({type:'get_entries'})).entries.find((e:any)=>e.message?.role==='assistant');
  await agents.daemon.invoke('start_pi',{runtimeId:'second',clientId:'laptop',cwd:source.cwd,sessionPath:original.sessionFile});
  const second=(command:any)=>agents.daemon.invoke('pi_command',{runtimeId:'second',command});
  const results=await Promise.all([source.command({type:mode,entryId:entry.id}), second({type:mode,entryId:entry.id}), source.command({type:mode,entryId:entry.id})]);
  expect(results[2].state.sessionId).toBe(results[0].state.sessionId);
  const states=await Promise.all([source.command({type:'get_state'}),second({type:'get_state'})]);
  expect(results[0].state.sessionId).not.toBe(results[1].state.sessionId);
  expect(states[0].sessionId).toBe(results[0].state.sessionId);
  expect(states[1].sessionId).toBe(results[1].state.sessionId);
 } finally {await agents.close();}
},60000);
