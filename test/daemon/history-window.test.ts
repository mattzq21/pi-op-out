import { expect, test } from 'bun:test';
import { olderHistory, recentHistory, turnWork } from '../../daemon/src/host/history_window';

function chat(turns: number, reply: string) {
  const entries: any[] = [];
  let parentId: string | null = null;
  const add = (entry: any) => { const id = 'e' + entries.length; entries.push({ ...entry, id, parentId }); parentId = id; };
  for (let index = 0; index < turns; index++) {
    add({ type: 'message', message: { role: 'user', content: 'Question ' + index } });
    add({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'toolCall', id: 'c' + index, name: 'read', arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
    add({ type: 'message', message: { role: 'toolResult', toolCallId: 'c' + index, content: 'File' } });
    add({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Done' }, { type: 'text', text: reply }], stopReason: 'stop' } });
  }
  return { entries, leafId: parentId };
}

const users = (history: any) => history.entries.filter((entry: any) => entry.message?.role === 'user').map((entry: any) => entry.message.content);

test('a chat opens with its last 5 turns, without their work', () => {
  const history = recentHistory(chat(8, 'x'.repeat(2000)), false);
  expect(users(history)).toEqual(['Question 3', 'Question 4', 'Question 5', 'Question 6', 'Question 7']);
  expect(history.entries.map((entry: any) => entry.message.role)).toEqual(Array(5).fill(['user', 'assistant']).flat());
  expect(history.entries[1].message).toMatchObject({ content: [{ type: 'text' }], deferredWork: { reasoningOnly: false, usage: { input: 1 } } });
  expect(history.entries[0].parentId).toBeNull();
  expect(history.leafId).toBe(history.entries.at(-1).id);
  expect(history.before).toBe('e12');
});

test('short answers extend the first view to about 5000 characters', () => {
  expect(users(recentHistory(chat(8, 'x'.repeat(800)), false))).toHaveLength(7);
});

test('a running turn keeps its work', () => {
  const history = recentHistory(chat(2, 'x'), true);
  expect(history.entries.slice(-4).map((entry: any) => entry.message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
});

test('older history and the work of a turn load on request', () => {
  const source = chat(8, 'x'.repeat(2000));
  const older = olderHistory(source, 'e12');
  expect(users(older)).toEqual(['Question 0', 'Question 1', 'Question 2']);
  expect(older.before).toBeNull();
  expect(turnWork(source, 'e31').entries.map((entry: any) => entry.message.role)).toEqual(['assistant', 'toolResult', 'assistant']);
});
