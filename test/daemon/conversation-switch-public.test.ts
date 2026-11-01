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
    expect(await chat.command({ type: 'new_session' }).then(() => 'switched', (error: Error) => error.message)).toBe('Stop the response and finish queued messages before switching');
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
  expect(sessions.find((session: any) => session.id === branch.sessionId)).toMatchObject({ forkSourceId: original.sessionId, forkEntryId: firstAnswer.id });
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
  expect(existsSync(join(agents.daemon.home, '.piop/worktrees', copy.sessionId))).toBe(false);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Copy question', 'Copy answer to Copy question']);
  await chat.command({ type: 'prompt', message: 'Other question' });
  await chat.until(history => text(history.at(-1)) === 'Copy answer to Other question');
  const sessions = await agents.daemon.invoke('list_sessions');
  expect(sessions.find((session: any) => session.id === original.sessionId)).toMatchObject({ preview: 'Copy answer to Later question' });
  expect(sessions.find((session: any) => session.id === copy.sessionId)).toMatchObject({ preview: 'Copy answer to Other question' });
  expect(sessions.find((session: any) => session.id === copy.sessionId).forkSourceId).toBe(original.sessionId);
}, 60000);

test.concurrent('an edited message replaces the sent one in the same conversation, keeps the chosen images, and the model no longer sees what came after', async () => {
  const png = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
  const red = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const black = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  agents.scripts.set('Pick a color', messages => ({ text: 'Reply to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Pick a color' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Pick a color');
  await chat.command({ type: 'prompt', message: 'Forgotten detour', images: [png(red), png(black)] });
  await chat.until(history => text(history.at(-1)) === 'Reply to Forgotten detour');
  const before = (await chat.command({ type: 'get_state' })).sessionId;
  const detour = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && entry.message.role === 'user' && text(entry.message).startsWith('Forgotten detour'));
  await chat.command({ type: 'edit_message', entryId: detour.id, message: 'Pick a shade', keepImages: [1] });
  await chat.until(history => text(history.at(-1)) === 'Reply to Pick a shade');
  expect((await chat.command({ type: 'get_state' })).sessionId).toBe(before);
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Pick a color', 'Reply to Pick a color', 'Pick a shade', 'Reply to Pick a shade']);
  const request = agents.model.requests.findLast(request => text(request.messages.at(-1)) === 'Pick a shade');
  expect(request.messages.at(-1).content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url)).toEqual(['data:image/png;base64,' + black]);
  const sent = JSON.stringify(request.messages);
  expect(sent).toContain('Reply to Pick a color');
  expect(sent).not.toContain('Forgotten detour');
}, 60000);

test.concurrent('a sent message cannot be edited while the agent works, into a goal, or into a command', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Write the report', messages => text(messages.at(-1)) === 'Write the report' ? busy.promise : { text: 'Done.' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write the report' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Write the report'));
  const prompt = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && entry.message.role === 'user');
  const edit = (message: string) => chat.command({ type: 'edit_message', entryId: prompt.id, message }).then(() => 'edited', (error: Error) => error.message);
  try { expect(await edit('Write the summary')).toBe('Wait for the current response and queued messages to finish first'); }
  finally { busy.release({ text: 'Report written.' }); }
  await chat.until(history => text(history.at(-1)) === 'Report written.');
  expect(await edit('/goal Write the summary')).toBe('A goal cannot replace a sent message. Send /goal as a new message.');
  expect(await edit('/compact')).toBe('A command cannot replace a sent message. Send it as a new message.');
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(['Write the report', 'Report written.']);
}, 60000);

test.concurrent('after an edit, the chat list and a reopened chat show the edited message', async () => {
  agents.scripts.set('Choose a fruit', messages => ({ text: 'Reply to ' + text(messages.at(-1)) }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Choose a fruit' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Choose a fruit');
  await chat.command({ type: 'prompt', message: 'Discarded detour' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Discarded detour');
  const listed = async () => (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId);
  for (let tries = 0; (await listed())?.preview !== 'Reply to Discarded detour' && tries < 50; tries++) await Bun.sleep(100);
  const detour = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === 'Discarded detour');
  await chat.command({ type: 'edit_message', entryId: detour.id, message: 'Choose a berry' });
  await chat.until(history => text(history.at(-1)) === 'Reply to Choose a berry');
  for (let tries = 0; (await listed())?.preview !== 'Reply to Choose a berry' && tries < 50; tries++) await Bun.sleep(100);
  expect(await listed()).toMatchObject({ preview: 'Reply to Choose a berry', name: 'Choose a fruit' });
  const edited = ['Choose a fruit', 'Reply to Choose a fruit', 'Choose a berry', 'Reply to Choose a berry'];
  const original = await chat.command({ type: 'get_state' });
  await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
  await agents.daemon.invoke('start_pi', { runtimeId: chat.runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionPath: original.sessionFile, presence: { readOnly: true } });
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(edited);
  await agents.daemon.invoke('stop_pi', { runtimeId: chat.runtimeId });
  await agents.daemon.invoke('start_pi', { runtimeId: chat.runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionPath: original.sessionFile });
  expect((await chat.history()).filter(message => message.role !== 'system').map(text)).toEqual(edited);
}, 60000);
