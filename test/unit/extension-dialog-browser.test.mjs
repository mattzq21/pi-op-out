import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

test('clicking inside an extension dialog preserves it while clicking the backdrop cancels it', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]' });
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await page.getByText('Confirm this action', { exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await page.getByLabel('Dialog response').textContent(), 'No response');
  const bounds = await page.getByRole('dialog').boundingBox();
  assert.ok(bounds.x > 5 && bounds.y > 5, 'a point outside the dialog must be available');
  await page.mouse.click(bounds.x - 5, bounds.y - 5);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByLabel('Dialog response').textContent(), '{"cancelled":true}');
});

test('closing an extension dialog returns keyboard focus to its launcher', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]' });
  const launcher = page.getByRole('button', { name: 'Open confirmation' });
  await launcher.click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).focus();
  assert.equal(await launcher.evaluate(element => document.activeElement === element), false);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await launcher.evaluate(element => document.activeElement === element), true);
  assert.equal(await page.getByLabel('Dialog response').textContent(), '{"cancelled":true}');
});

test('Escape cancels an extension editor without submitting the edited text', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]' });
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('textbox', { name: 'Instructions' }).fill('Unsaved\nchanges');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Dialog response').textContent(), '{"cancelled":true}');
});

test('choosing an option in an extension selection sends that option', async t => {
  const page = await startupPage(t, 'production', { entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]' });
  await page.getByRole('button', { name: 'Open selection' }).click();
  await page.getByRole('dialog', { name: 'Pick a branch' }).getByRole('button', { name: 'release', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Dialog response').textContent(), '{"value":"release"}');
});

test('Escape during a pending extension input keeps the dialog open to show the response failure', async t => {
  const pending = Promise.withResolvers();
  const received = Promise.withResolvers();
  const responses = [];
  const page = await startupPage(t, 'production', {
    entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]',
    prepare: page => page.exposeFunction('respondToExampleInput', response => {
      responses.push(response); received.resolve(); return pending.promise;
    }),
  });
  await page.getByRole('button', { name: 'Open input' }).click();
  const input = page.getByRole('textbox', { name: 'Name', exact: true });
  await input.press('Enter');
  await received.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await input.evaluate(element => element.disabled && document.activeElement !== element), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Name' }).isVisible(), true);
  pending.resolve({ error: 'offline' });
  await page.getByRole('dialog', { name: 'Name' }).getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').textContent(), 'offline');
  assert.deepEqual(responses, [{ value: 'initial' }]);
  assert.equal(await page.getByLabel('Dialog response').textContent(), 'No response');
});

test('extension input waits for composition, prevents duplicate submission and shows response failures', async t => {
  const pending = Promise.withResolvers();
  const received = Promise.withResolvers();
  const responses = [];
  const page = await startupPage(t, 'production', {
    entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]',
    prepare: page => page.exposeFunction('respondToExampleInput', response => {
      responses.push(response); received.resolve(); return pending.promise;
    }),
  });
  await page.getByRole('button', { name: 'Open input' }).click();
  const input = page.getByRole('textbox', { name: 'Name', exact: true });
  assert.equal(await input.inputValue(), 'initial');
  await input.fill('edited');
  const keyboard = await page.context().newCDPSession(page);
  await keyboard.send('Input.imeSetComposition', { text: '文字', selectionStart: 2, selectionEnd: 2 });
  await page.keyboard.press('Enter');
  assert.equal(await input.isEnabled(), true);
  assert.deepEqual(responses, []);
  await keyboard.send('Input.insertText', { text: '文字' });
  assert.equal(await input.inputValue(), 'edited文字');
  await page.keyboard.press('Enter');
  await received.promise;
  await page.keyboard.press('Enter');
  assert.deepEqual(responses, [{ value: 'edited文字' }]);
  assert.equal(await input.isDisabled(), true);
  pending.resolve({ error: 'offline' });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').textContent(), 'offline');
  assert.equal(await input.isEnabled(), true);
  assert.equal(await input.inputValue(), 'edited文字');
});

test('a failed extension selection blocks other choices while pending and accepts one retry with a different option', { timeout: 15000 }, async t => {
  const replies = [Promise.withResolvers(), Promise.withResolvers()];
  const received = [Promise.withResolvers(), Promise.withResolvers()];
  const responses = [];
  const page = await startupPage(t, 'production', {
    entryPoint: 'test/fixtures/extension-dialog-browser.tsx', ready: '[aria-label="Dialog response"]',
    prepare: page => page.exposeFunction('respondToExampleSelection', response => {
      const index = responses.push(response) - 1; received[index].resolve(); return replies[index].promise;
    }),
  });
  await page.getByRole('button', { name: 'Open selection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pick a branch' });
  const option = name => dialog.getByRole('button', { name, exact: true });
  await option('release').click();
  await received[0].promise;
  for (const name of ['main', 'release', 'hotfix']) assert.equal(await option(name).isDisabled(), true);
  const bounds = await dialog.boundingBox();
  await page.mouse.click(bounds.x - 5, bounds.y - 5);
  assert.equal(await dialog.isVisible(), true);
  replies[0].resolve({ error: 'branch locked' });
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('alert').textContent(), 'branch locked');
  await option('hotfix').click();
  await received[1].promise;
  replies[1].resolve({});
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(responses, [{ value: 'release' }, { value: 'hotfix' }]);
  assert.equal(await page.getByLabel('Dialog response').textContent(), '{"value":"hotfix"}');
});
