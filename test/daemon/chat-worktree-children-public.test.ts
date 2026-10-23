import { test, expect } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';
test('archiving a worktree chat and its child releases its worktree', async () => {
 const agents=await agentDaemon();
 try {
  await agents.enableAgentTools('spawn_subagents');
  agents.scripts.set('Initial question', messages => {
   if (!messages.some(m=>m.role==='user' && text(m)==='Delegate now')) return {text:'Initial answer'};
   if (!called(messages,'spawn_subagents')) return {tool:'spawn_subagents', arguments:{tasks:[{nickname:'Helper',task:'Child task'}]}};
   return {text:text(messages.at(-1)).includes('Child finished')?'All finished':'Waiting'};
  });
  agents.scripts.set('Child task',()=>({text:'Child finished'}));
  const source=await agents.rootChat({repository:true});
  await source.command({type:'prompt',message:'Initial question'});
  await source.until(messages=>text(messages.at(-1))==='Initial answer');
  const entry=(await source.command({type:'get_entries'})).entries.find((e:any)=>e.message?.role==='assistant');
  await source.command({type:'fork_after',entryId:entry.id});
  const branch=await source.command({type:'get_state'});
  await source.command({type:'prompt',message:'Delegate now'});
  await source.until(messages=>text(messages.at(-1))==='All finished');
  const child=(await agents.daemon.invoke('list_sessions')).find((s:any)=>s.subagentParentId===branch.sessionId);
  expect(child).toBeTruthy();
  writeFileSync(join(branch.cwd,'dirty.txt'),'after last commit');
  await agents.daemon.invoke('archive_session',{sessionPath:branch.sessionFile,hostId:'local',clientId:'laptop',terminalIds:[]});
  const report=await agents.daemon.invoke('storage_report');
  const archives=report.hosts.flatMap((h:any)=>h.archives);
  expect(archives.some((a:any)=>a.id===child.id)).toBe(true);
  const childArchive=archives.find((a:any)=>a.id===child.id);
  expect(childArchive.restorable).toBe(false);
  await expect(agents.daemon.invoke('restore_archived_session',{sessionPath:childArchive.path,hostId:'local',clientId:'laptop'})).rejects.toThrow('Auxiliary sessions can only be restored with their root session');
  expect(existsSync(branch.cwd)).toBe(false);
  const archived=archives.find((a:any)=>a.id===branch.sessionId);
  await agents.daemon.invoke('restore_archived_session',{sessionPath:archived.path,hostId:'local',clientId:'laptop'});
  expect(existsSync(join(branch.cwd,'dirty.txt'))).toBe(false);
  expect((await agents.daemon.invoke('list_sessions')).some((s:any)=>s.id===child.id)).toBe(true);
 } finally {await agents.close();}
},90000);
