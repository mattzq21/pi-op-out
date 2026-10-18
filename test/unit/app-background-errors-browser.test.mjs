import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('when the prompt history cannot be saved, the window tells the user why', async t => {
  const page = await appBrowser(t, { nativeFailures: { sync_prompt_history: 'The disk is full' } });
  const notice = page.getByRole('alert').filter({ hasText: 'Could not save prompt history' });
  await notice.waitFor();
  assert.match(await notice.textContent(), /The disk is full/);
});
