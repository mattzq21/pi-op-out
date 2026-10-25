import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshHostModels, registerModelSession } from '../../clients/ui/lib/modelReports.ts';
import { ConversationChangedError } from '../../clients/ui/lib/conversationChanged.ts';

test('refreshing the models of a host ignores conversations that changed, and reports other failures', async t => {
  const stops = [
    registerModelSession(() => 'local', async () => { throw new ConversationChangedError(); }),
    registerModelSession(() => 'local', async () => {}),
  ];
  t.after(() => stops.forEach(stop => stop()));
  await refreshHostModels('local');
  stops.push(registerModelSession(() => 'local', async () => { throw new Error('Pi is not running'); }));
  await assert.rejects(refreshHostModels('local'), /Pi is not running/);
});
