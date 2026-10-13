import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

async function messagePage(t, message, extra = {}) {
  return startupPage(t, 'development', {
    entryPoint: 'test/fixtures/message-behavior-browser.tsx', ready: '.tool-event', holdStorage: false,
    prepare: page => page.exposeFunction('initialMessageProps', () => ({ message: { id: 'message-id', ...message }, ...extra })),
  });
}

test('debug tool results reveal input and output only when opened', async t => {
  const page = await messagePage(t, { role: 'tool', toolName: 'read', content: 'private output', toolInput: { path: '/repo/a' } }, { debug: true });
  assert.equal(await page.locator('details').evaluate(node => node.open), false);
  assert.equal(await page.getByLabel('Tool arguments', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Tool output', { exact: true }).count(), 0);
  await page.locator('summary').click();
  await page.getByLabel('Tool arguments', { exact: true }).waitFor();
  assert.match(await page.getByLabel('Tool arguments', { exact: true }).textContent(), /"path": "\/repo\/a"/);
  assert.equal(await page.getByLabel('Tool output', { exact: true }).textContent(), 'private output');
});


test('failed tools show their failure status and preserve null input when expanded', async t => {
  const page = await messagePage(t, { role: 'tool', toolName: 'read', toolStatus: 'error', toolInput: null, content: 'read failed' }, { debug: true });
  await page.locator('summary').click();
  await page.getByLabel('Tool arguments', { exact: true }).waitFor();
  assert.match(await page.locator('summary').textContent(), /Failed/);
  assert.equal(await page.locator('details').evaluate(node => node.open), true);
  assert.equal(await page.getByLabel('Tool arguments', { exact: true }).textContent(), 'null');
  assert.equal(await page.getByLabel('Tool output', { exact: true }).textContent(), 'read failed');
});


test('unnamed tools have a readable label without empty input or output fields', async t => {
  const page = await messagePage(t, { role: 'tool', content: '' }, { debug: true });
  await page.locator('summary').click();
  await page.locator('details[open]').waitFor();
  assert.match(await page.locator('summary').textContent(), /tool/);
  assert.equal(await page.getByLabel('Tool arguments', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Tool output', { exact: true }).count(), 0);
});


test('tool status changes keep requested input and output open', async t => {
  const message = { id: 'tool', role: 'tool', toolName: 'read', content: 'partial output', toolInput: { path: '/repo/a' }, toolStatus: 'running' };
  const page = await messagePage(t, message, { debug: true });
  await page.locator('summary').click();
  await page.getByLabel('Tool output', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Tool output', { exact: true }).textContent(), 'partial output');
  await page.evaluate(message => window.updateMessageProps({ message, debug: true }), { ...message, toolStatus: 'error', content: 'read failed', toolInput: null });
  assert.equal(await page.locator('details').evaluate(node => node.open), true);
  assert.match(await page.locator('summary').textContent(), /Failed/);
  assert.equal(await page.getByLabel('Tool arguments', { exact: true }).textContent(), 'null');
  assert.equal(await page.getByLabel('Tool output', { exact: true }).textContent(), 'read failed');
});
