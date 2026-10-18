import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoot } from 'solid-js';
import { installDom } from '../dom.mjs';
import { createAppExtensions } from '../../clients/ui/appExtensions.ts';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';

const request = id => ({ type: 'extension_ui_request', id, method: 'confirm', title: id });

// Records every response sent to Pi for each transport; fails the response for one chosen request.
function piTransport(failingId) {
  const transport = new NativeTransport({});
  const responses = [];
  transport.command = async command => {
    if (command.type !== 'extension_ui_response') return undefined;
    responses.push(command);
    if (command.id === failingId) throw new Error('Pi did not accept the cancellation');
  };

  return { transport, responses };
}

test('a failed dialog cancellation does not skip other requests or affect another chat', { timeout: 15000 }, async t => {
  const dom = installDom();
  const selected = piTransport('first');
  const other = piTransport();
  const { extensions, dispose } = createRoot(dispose => {
    const chatSession = useChatSession(() => selected.transport, undefined, { poll: false });

    return { extensions: createAppExtensions({ transport: () => selected.transport, chatSession: () => chatSession }), dispose };
  });
  t.after(() => { dispose(); dom.restore(); });

  extensions.queueExtensionDialog(request('first'), selected.transport, 'Main conversation');
  extensions.queueExtensionDialog(request('second'), selected.transport, 'Main conversation');
  extensions.queueExtensionDialog(request('third'), selected.transport, 'Main conversation');
  extensions.queueExtensionDialog(request('first'), other.transport, 'Split conversation');

  await assert.rejects(extensions.cancelTransportDialogs(selected.transport), { message: 'Pi did not accept the cancellation' });

  assert.deepEqual([...selected.responses].sort((a, b) => a.id.localeCompare(b.id)), [
    { type: 'extension_ui_response', id: 'first', cancelled: true },
    { type: 'extension_ui_response', id: 'second', cancelled: true },
    { type: 'extension_ui_response', id: 'third', cancelled: true },
  ]);
  assert.deepEqual(other.responses, []);
  assert.deepEqual(extensions.dialogs().map(dialog => [dialog.transport === other.transport, dialog.request.id, dialog.owner]), [[true, 'first', 'Split conversation']]);
});

test('a repeated dialog request keeps its queue identity per chat and gets a new one after it resolves', { timeout: 15000 }, async t => {
  const dom = installDom();
  const selected = piTransport();
  const other = piTransport();
  const { extensions, dispose } = createRoot(dispose => {
    const chatSession = useChatSession(() => selected.transport, undefined, { poll: false });

    return { extensions: createAppExtensions({ transport: () => selected.transport, chatSession: () => chatSession }), dispose };
  });
  t.after(() => { dispose(); dom.restore(); });
  const original = request('ask');

  extensions.queueExtensionDialog(original, selected.transport, 'Main conversation');
  const [queued] = extensions.dialogs();
  extensions.queueExtensionDialog({ ...request('ask'), title: 'Repeated' }, selected.transport, 'Repeated owner');
  assert.deepEqual(extensions.dialogs(), [queued]);
  assert.equal(queued.request, original);
  assert.equal(queued.owner, 'Main conversation');

  extensions.queueExtensionDialog(request('ask'), other.transport, 'Split conversation');
  const [, split] = extensions.dialogs();
  assert.equal(extensions.dialogs().length, 2);
  assert.equal(split.transport, other.transport);
  assert.equal(split.request.id, queued.request.id);
  assert.equal(typeof split.queueId, 'string');
  assert.notEqual(split.queueId, queued.queueId);

  extensions.resolveExtensionDialog(selected.transport, 'ask');
  assert.deepEqual(extensions.dialogs(), [split]);

  extensions.queueExtensionDialog(request('ask'), selected.transport, 'Main conversation');
  const requeued = extensions.dialogs().find(dialog => dialog.transport === selected.transport);
  assert.deepEqual(extensions.dialogs(), [split, requeued]);
  assert.equal(typeof requeued.queueId, 'string');
  assert.equal(new Set([queued.queueId, split.queueId, requeued.queueId]).size, 3);
  assert.deepEqual([selected.responses, other.responses], [[], []]);
});
