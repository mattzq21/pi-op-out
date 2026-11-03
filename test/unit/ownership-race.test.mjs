import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { installDom } from '../dom.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';

test('a take of control that answers after another client took control leaves the view read-only', async t => {
  const dom = installDom();
  t.after(() => { clearMocks(); dom.restore(); });
  const sessionId = crypto.randomUUID();
  let runtimeId, answerTake;
  const calls = [];
  mockWindows('main');
  mockIPC(async (command, args) => {
    const name = command === 'daemon_invoke' ? args.command : command;
    calls.push(name);
    const values = command === 'daemon_invoke' ? args.args : args;
    if (name === 'locate_conversation' || name === 'broker_request') return { sessionId, sessionPath: '/tmp/chat.jsonl', cwd: '/tmp', archived: false, revision: 'r' };
    if (name === 'start_pi') { runtimeId = values.runtimeId; return { attached: true, owned: false }; }
    if (name === 'pi_command' && values.command.type === 'take_ownership') return new Promise(resolve => { answerTake = () => resolve({ attached: true, owned: true }); });
    return null;
  }, { shouldMockEvents: true });
  const view = new NativeTransport({ sessionId, sessionPath: '/tmp/chat.jsonl', cwd: '/tmp', hostId: 'local' });
  await view.connect();
  assert.equal(view.ownsConversation(), false, JSON.stringify(calls));

  const taking = view.takeOwnership();
  while (!answerTake) await new Promise(resolve => setTimeout(resolve, 5));
  await emit('pi://event', { runtimeId, event: { type: 'ownership_lost' } });
  answerTake();
  await taking;
  assert.equal(view.ownsConversation(), false);
});
