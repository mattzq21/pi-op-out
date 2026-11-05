import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appBrowser } from '../app-browser-fixture.mjs';

test('Ctrl+Alt+S opens a btw side chat, and settings list it under its plugin', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await composer.focus();
  await page.keyboard.press('Control+Alt+s');
  await page.locator('#sidepane-panel').waitFor();
  for (const deadline = Date.now() + 20000; !(await page.daemon.invoke('list_sessions')).some(session => session.auxiliaryKind === 'btw') && Date.now() < deadline;) await page.waitForTimeout(100);
  assert.ok((await page.daemon.invoke('list_sessions')).some(session => session.auxiliaryKind === 'btw'));
  const side = page.locator('#sidepane-panel');
  await side.getByRole('separator').filter({ hasText: 'Side chat' }).waitFor();
  assert.equal(await side.getByText('Reply to Hello there').count(), 0);
  await page.screenshot({ path: '/tmp/btw-divider.png' });

  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Keybinds', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Open side chat shortcut', exact: true });
  assert.equal(await field.inputValue(), 'Ctrl+Alt+S');
  const order = await page.locator('.settings-section .keybind-input, .settings-section h3').evaluateAll(nodes => nodes.map(node => node.tagName === 'H3' ? node.textContent : node.getAttribute('aria-label')));
  assert.deepEqual(order.slice(-2), ['Side chats', 'Open side chat shortcut']);
});

test('pressing the side chat shortcut again while one opens shows no start error', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await composer.focus();
  for (let press = 0; press < 3; press++) { await page.keyboard.press('Control+Alt+s'); await page.waitForTimeout(150); }
  await page.locator('#sidepane-panel').waitFor();
  await page.getByRole('textbox', { name: 'Message piop' }).nth(1).waitFor();
  await page.waitForTimeout(3000);
  assert.equal(await page.getByText(/^Could not start/).count(), 0);
});

test('the side chat shortcut does nothing in an empty chat', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('textbox', { name: 'Message piop' }).focus();
  await page.keyboard.press('Control+Alt+s');
  await page.waitForTimeout(1000);
  assert.equal(await page.getByText(/^Could not run/).count(), 0);
  assert.equal(await page.locator('#sidepane-panel').isVisible(), false);
});

test('the side chat shortcut fails when this window does not control the chat', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.evaluate(() => {
    const deliver = window.deliverNativeEvent;
    window.runtimeIds = new Set();
    window.deliverNativeEvent = (event, payload) => { if (event === 'pi://event' && payload?.runtimeId) window.runtimeIds.add(payload.runtimeId); return deliver(event, payload); };
  });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' });
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await page.evaluate(async () => { for (const runtimeId of window.runtimeIds) await window.deliverNativeEvent('pi://event', { runtimeId, event: { type: 'ownership_lost' } }); });
  await page.waitForFunction(() => document.querySelector('piop-composer-field')?.readOnly === true);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+Alt+s');
  await page.getByText('Could not run “Open side chat”').waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#sidepane-panel').isVisible(), false);
  assert.equal((await page.daemon.invoke('list_sessions')).some(session => session.auxiliaryKind === 'btw'), false);
});

test('another client taking the main chat also takes its side chat, and taking the side chat back takes both', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' }).first();
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });
  await composer.focus();
  await page.keyboard.press('Control+Alt+s');
  const side = page.locator('#sidepane-panel');
  await side.getByRole('separator').filter({ hasText: 'Side chat' }).waitFor();
  const fields = page.locator('piop-composer-field');
  await side.getByText('scripted-model').waitFor();

  const sessions = await page.daemon.invoke('list_sessions');
  const root = sessions.find(session => !session.auxiliaryKind);
  await page.daemon.invoke('start_pi', { runtimeId: 'phone-root', clientId: 'phone', cwd: root.cwd, sessionId: root.id });
  await page.daemon.invoke('pi_command', { runtimeId: 'phone-root', command: { type: 'take_ownership' } });
  await page.waitForFunction(() => [...document.querySelectorAll('piop-composer-field')].every(field => field.readOnly));

  await side.locator('piop-composer-field').focus();
  await page.waitForFunction(() => [...document.querySelectorAll('piop-composer-field')].every(field => !field.readOnly));
  assert.equal(await fields.count(), 2);
});

test('a side chat opened from the queue leaves the cursor in the main chat, the shortcut moves it', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'agents' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' }).first();
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await composer.fill('/btw Side question');
  await composer.press('Enter');
  const side = page.locator('#sidepane-panel');
  await side.getByText('Side question').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);

  await page.keyboard.press('Control+Alt+s');
  const sideComposer = side.getByRole('textbox', { name: 'Message piop' });
  for (const deadline = Date.now() + 20000; !(await sideComposer.evaluate(element => element === document.activeElement).catch(() => false)) && Date.now() < deadline;) await page.waitForTimeout(100);
  assert.equal(await sideComposer.evaluate(element => element === document.activeElement), true);
});

test('a queued side chat that opens while you type in another side chat stays in the background', { timeout: 120000 }, async t => {
  const page = await appBrowser(t, { model: 'echo' });
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: /scripted-model/ }).click();
  const composer = page.getByRole('textbox', { name: 'Message piop' }).first();
  await composer.fill('Hello there');
  await composer.press('Enter');
  await page.getByText('Reply to Hello there').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop piop', exact: true }).waitFor({ state: 'detached' });

  await composer.focus();
  await page.keyboard.press('Control+Alt+s');
  const side = page.locator('#sidepane-panel');
  const sideComposer = side.getByRole('textbox', { name: 'Message piop' });
  await sideComposer.waitFor();
  const tabs = page.getByRole('tablist', { name: 'Side chats' }).getByRole('tab');
  await tabs.first().waitFor();
  const first = await tabs.first().getAttribute('id');

  await composer.fill('Slow first');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Stop piop', exact: true }).first().waitFor();
  await composer.fill('/btw Hidden question');
  await composer.press('Enter');
  await sideComposer.click();
  for (const letter of 'Draft for the first side chat') { await page.keyboard.type(letter); await page.waitForTimeout(150); }
  await tabs.nth(1).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  assert.equal(await side.getAttribute('aria-labelledby'), first);
  assert.equal(await sideComposer.inputValue().catch(() => sideComposer.textContent()), 'Draft for the first side chat');
  assert.equal(await sideComposer.evaluate(element => element === document.activeElement), true);

  await tabs.nth(1).click();
  await side.getByText('Reply to Hidden question').waitFor({ timeout: 30000 });
});
