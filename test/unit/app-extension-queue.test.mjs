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
