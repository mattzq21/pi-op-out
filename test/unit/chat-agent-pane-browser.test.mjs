import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('/agent opens this conversation\'s agent in the side pane, and Apply changes only this conversation', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await composer.fill('/agent');
  await composer.press('Enter');
  const tab = page.getByRole('tab', { name: /^Agent: / });
  await tab.waitFor({ timeout: 30000 });
  const pane = page.getByRole('region', { name: 'Agent of this conversation' });
  const systemPrompt = pane.getByRole('textbox', { name: 'System prompt', exact: true });
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="System prompt"]')?.value.length > 0, undefined, { timeout: 30000 });
  assert.equal(await pane.getByRole('textbox', { name: 'Agent name', exact: true }).inputValue(), 'general');
  const apply = pane.getByRole('button', { name: 'Apply', exact: true });
  assert.equal(await apply.isDisabled(), true);
  const effortAlert = pane.getByRole('alert').filter({ hasText: 'is unavailable for this model' });
  await effortAlert.waitFor();

  const cap = pane.getByRole('textbox', { name: 'Agent context cap', exact: true });
  await cap.pressSequentially('abc');
  await pane.getByRole('alert').filter({ hasText: 'Invalid context cap' }).waitFor();
  assert.equal(await apply.isDisabled(), true);
  await pane.getByRole('button', { name: 'Discard', exact: true }).click();
  assert.equal(await cap.inputValue(), '');
  assert.equal(await pane.getByRole('alert').filter({ hasText: 'Invalid context cap' }).count(), 0);
  await effortAlert.waitFor();
  await pane.getByRole('combobox', { name: 'Agent default effort', exact: true }).selectOption('off');
  await effortAlert.waitFor({ state: 'detached' });

  const name = pane.getByRole('textbox', { name: 'Agent name', exact: true });
  await name.fill('');
  await name.pressSequentially('po et!');
  assert.equal(await name.inputValue(), 'poet');
  await systemPrompt.fill('');
  await systemPrompt.pressSequentially('You are a poet.');
  assert.equal(await systemPrompt.inputValue(), 'You are a poet.');
  await apply.click();
  await pane.getByRole('button', { name: 'Applied', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await systemPrompt.inputValue(), 'You are a poet.');
  await page.getByRole('button', { name: 'Agent', exact: true }).filter({ hasText: 'poet' }).waitFor();

  const definitions = await page.daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog' } });
  assert.equal(definitions.config.agents.some(agent => agent.name === 'poet'), false);

  await page.getByRole('button', { name: /^Close Agent: / }).press('Enter');
  await tab.waitFor({ state: 'detached' });
});
