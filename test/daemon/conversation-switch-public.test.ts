import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const held = <T>() => { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; };

test.concurrent('a new conversation cannot start while the agent works, and afterwards starts empty while the old one keeps its history', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Draft the plan', messages => text(messages.at(-1)) === 'Draft the plan' ? busy.promise : { text: 'Fresh start.' });
  agents.scripts.set('Start fresh', () => ({ text: 'Fresh start.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Draft the plan' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Draft the plan'));
  try {
    expect(await chat.command({ type: 'new_session' }).then(() => 'switched', (error: Error) => error.message)).toBe('Stop or pause the response and finish queued messages before switching');
  } finally { busy.release({ text: 'Plan drafted.' }); }
  await chat.until(history => text(history.at(-1)) === 'Plan drafted.');
  const before = (await chat.command({ type: 'get_state' })).sessionId;
  await chat.command({ type: 'new_session' });
  const state = await chat.command({ type: 'get_state' });
  expect(state.sessionId).not.toBe(before);
  expect(await chat.history()).toEqual([]);
  await chat.command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  await chat.command({ type: 'prompt', message: 'Start fresh' });
  await chat.until(history => text(history.at(-1)) === 'Fresh start.');
  const old = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === before);
  expect(old).toMatchObject({ name: 'Draft the plan', preview: 'Plan drafted.', isRunning: false });
}, 60000);

test.concurrent('switching back to an earlier conversation shows its history and continues it', async () => {
  agents.scripts.set('Name the project', messages => ({ text: text(messages.at(-1)) === 'Name the project' ? 'Call it Comet.' : 'We called it Comet.' }));
  agents.scripts.set('Unrelated question', () => ({ text: 'Unrelated answer.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Name the project' });
  await chat.until(history => text(history.at(-1)) === 'Call it Comet.');
  const earlier = await chat.command({ type: 'get_state' });
  await chat.command({ type: 'new_session' });
  await chat.command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  await chat.command({ type: 'prompt', message: 'Unrelated question' });
  await chat.until(history => text(history.at(-1)) === 'Unrelated answer.');
  await chat.command({ type: 'switch_session', sessionPath: earlier.sessionFile });
  expect((await chat.command({ type: 'get_state' })).sessionId).toBe(earlier.sessionId);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Name the project', 'Call it Comet.']);
  await chat.command({ type: 'prompt', message: 'What did we call it?' });
  const messages = await chat.until(history => text(history.at(-1)) === 'We called it Comet.');
  expect(messages.filter(message => message.role === 'user').map(text)).toEqual(['Name the project', 'What did we call it?']);
}, 60000);

test.concurrent('switching to a conversation another device has open only watches it, and cannot send to it', async () => {
  agents.scripts.set('Phone conversation', () => ({ text: 'Phone answer.' }));
  const phone = await agents.daemon.connect();
  try {
    const owned = await phone.invoke('create_temporary_chat', { hostId: 'local' });
    await phone.invoke('start_pi', { runtimeId: 'phone-runtime', clientId: 'phone', cwd: owned.cwd, sessionId: owned.sessionId });
    const phoneCommand = (value: any) => phone.invoke('pi_command', { runtimeId: 'phone-runtime', command: value });
    await phoneCommand({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await phoneCommand({ type: 'prompt', message: 'Phone conversation' });
    for (let tries = 0; tries < 50 && text((await phoneCommand({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').at(-1)?.message) !== 'Phone answer.'; tries++) await Bun.sleep(100);
    const path = (await phoneCommand({ type: 'get_state' })).sessionFile;
    const laptop = await agents.rootChat();
    await laptop.command({ type: 'switch_session', sessionPath: path });
    const lost = agents.daemon.events.some(event => event.payload?.runtimeId === laptop.runtimeId && event.payload.event?.type === 'ownership_lost');
    expect(lost).toBe(true);
    expect(await laptop.command({ type: 'prompt', message: 'Taking over?' }).then(() => 'sent', (error: Error) => error.message)).toBe('Take ownership of this conversation before changing it');
    expect(text((await phoneCommand({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').at(-1).message)).toBe('Phone answer.');
  } finally { phone.close(); }
}, 60000);

test.concurrent('branching after an answer opens a new conversation with the history up to that answer and leaves the original intact', async () => {
  agents.scripts.set('First question', messages => ({ text: 'Answer to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat({ repository: true });
  await chat.command({ type: 'prompt', message: 'First question' });
  await chat.until(history => text(history.at(-1)) === 'Answer to First question');
  await chat.command({ type: 'prompt', message: 'Second question' });
  await chat.until(history => text(history.at(-1)) === 'Answer to Second question');
  const original = await chat.command({ type: 'get_state' });
  const firstAnswer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Answer to First question');
  await chat.command({ type: 'fork_after', entryId: firstAnswer.id });
  const branch = await chat.command({ type: 'get_state' });
  expect(branch.sessionId).not.toBe(original.sessionId);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['First question', 'Answer to First question']);
  await chat.command({ type: 'prompt', message: 'Different second question' });
  await chat.until(history => text(history.at(-1)) === 'Answer to Different second question');
  const sessions = await agents.daemon.invoke('list_sessions');
  expect(sessions.find((session: any) => session.id === original.sessionId)).toMatchObject({ preview: 'Answer to Second question' });
  expect(sessions.find((session: any) => session.id === branch.sessionId)).toMatchObject({ preview: 'Answer to Different second question' });
  expect(sessions.find((session: any) => session.id === branch.sessionId).forkSourceId).toBe(original.sessionId);
  expect(sessions.find((session: any) => session.id === original.sessionId).forkSourceId).toBeUndefined();
}, 60000);

test.concurrent('copying after an answer outside a Git repository opens a new conversation in the same folder, without a worktree', async () => {
  agents.scripts.set('Copy question', messages => ({ text: 'Copy answer to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Copy question' });
  await chat.until(history => text(history.at(-1)) === 'Copy answer to Copy question');
  await chat.command({ type: 'prompt', message: 'Later question' });
  await chat.until(history => text(history.at(-1)) === 'Copy answer to Later question');
  const original = await chat.command({ type: 'get_state' });
  const answer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Copy answer to Copy question');
  await expect(chat.command({ type: 'fork_after', entryId: answer.id })).rejects.toThrow('not a Git repository');
  await chat.command({ type: 'copy_after', entryId: answer.id });
  const copy = await chat.command({ type: 'get_state' });
  expect(copy.sessionId).not.toBe(original.sessionId);
  expect(copy.cwd).toBe(original.cwd);
  expect(copy.forkSource).toEqual({ sessionId: original.sessionId, sessionPath: original.sessionFile, entryId: answer.id });
  expect(existsSync(join(agents.daemon.home, '.local/share/piop/worktrees', copy.sessionId))).toBe(false);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Copy question', 'Copy answer to Copy question']);
  await chat.command({ type: 'prompt', message: 'Other question' });
  await chat.until(history => text(history.at(-1)) === 'Copy answer to Other question');
  const sessions = await agents.daemon.invoke('list_sessions');
  expect(sessions.find((session: any) => session.id === original.sessionId)).toMatchObject({ preview: 'Copy answer to Later question' });
  expect(sessions.find((session: any) => session.id === copy.sessionId)).toMatchObject({ preview: 'Copy answer to Other question' });
  // The chat list names the source, so the copy takes the source's sidebar group without any client write.
  expect(sessions.find((session: any) => session.id === copy.sessionId).forkSourceId).toBe(original.sessionId);
}, 60000);

test.concurrent('fork and forget goes back to an earlier answer in the same conversation, and the model no longer sees what came after', async () => {
  agents.scripts.set('Pick a color', messages => ({ text: 'Reply to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Pick a color' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Pick a color');
  await chat.command({ type: 'prompt', message: 'Forgotten detour' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Forgotten detour');
  const before = (await chat.command({ type: 'get_state' })).sessionId;
  const firstAnswer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Reply to Pick a color');
  expect(await chat.command({ type: 'fork_and_forget', entryId: firstAnswer.id })).toMatchObject({ cancelled: false });
  expect((await chat.command({ type: 'get_state' })).sessionId).toBe(before);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Pick a color', 'Reply to Pick a color']);
  await chat.command({ type: 'prompt', message: 'Pick a shade' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Pick a shade');
  const request = agents.model.requests.findLast(request => request.messages.some((message: any) => message.role === 'user' && text(message) === 'Pick a shade'));
  const sent = JSON.stringify(request.messages);
  expect(sent).toContain('Reply to Pick a color');
  expect(sent).not.toContain('Forgotten detour');
}, 60000);

test.concurrent('after fork and forget, the chat list shows the chat as it is now, without what came after the earlier answer', async () => {
  agents.scripts.set('Choose a fruit', messages => ({ text: 'Reply to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Choose a fruit' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Choose a fruit');
  await chat.command({ type: 'prompt', message: 'Discarded detour' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Discarded detour');
  const listed = async () => (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId);
  for (let tries = 0; (await listed())?.preview !== 'Reply to Discarded detour' && tries < 50; tries++) await Bun.sleep(100);
  const firstAnswer = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Reply to Choose a fruit');
  await chat.command({ type: 'fork_and_forget', entryId: firstAnswer.id });
  for (let tries = 0; (await listed())?.preview !== 'Reply to Choose a fruit' && tries < 50; tries++) await Bun.sleep(100);
  expect(await listed()).toMatchObject({ preview: 'Reply to Choose a fruit', messageCount: 3, name: 'Choose a fruit' });
  const original = await chat.command({ type: 'get_state' });
  await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
  await agents.daemon.invoke('start_pi', { runtimeId: chat.runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionPath: original.sessionFile, presence: { readOnly: true } });
  expect((await chat.command({ type: 'get_snapshot' })).history.leafId).toBe(firstAnswer.id);
  await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
  await agents.daemon.invoke('start_pi', { runtimeId: chat.runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionPath: original.sessionFile });
  expect((await chat.command({ type: 'get_snapshot' })).history.leafId).toBe(firstAnswer.id);
  expect(await listed()).toMatchObject({ preview: 'Reply to Choose a fruit', messageCount: 3 });

}, 60000);
