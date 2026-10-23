import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

describe('startup behavior', { concurrency: 4 }, () => {
  test('production startup uses the orange link palette', async t => {
    const page = await startupPage(t, 'production');
    const color = await page.getByRole('link', { name: 'Reference' }).evaluate(link => getComputedStyle(link).color);
    assert.equal(color, 'rgb(212, 106, 36)');
  });

  test('production startup shows that the workspace is still loading', async t => {
    const page = await startupPage(t, 'production');
    assert.equal(await page.getByRole('status').textContent(), 'Restoring workspace…');
  });

  test('production startup enables undo in an editable field', async t => {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Draft');
      document.body.append(input);
      window.unhandledKeys = [];
      window.addEventListener('keydown', event => window.unhandledKeys.push(event.key));
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click();
    await editor.pressSequentially('Unsent text');
    assert.equal(await editor.inputValue(), 'Unsent text');
    await page.evaluate(() => { window.unhandledKeys = []; });
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '');
    assert.ok(!(await page.evaluate(() => window.unhandledKeys)).includes('z'));
  });

  test('development startup uses the yellow link palette', async t => {
    const page = await startupPage(t, 'development');
    const color = await page.getByRole('link', { name: 'Reference' }).evaluate(link => getComputedStyle(link).color);
    assert.equal(color, 'rgb(215, 184, 77)');
  });

  test('development startup shows that the workspace is still loading', async t => {
    const page = await startupPage(t, 'development');
    assert.equal(await page.getByRole('status').textContent(), 'Restoring workspace…');
  });

  test('development startup enables undo in an editable field', async t => {
    const page = await startupPage(t, 'development');
    await page.evaluate(() => {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Draft');
      document.body.append(input);
      window.unhandledKeys = [];
      window.addEventListener('keydown', event => window.unhandledKeys.push(event.key));
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click();
    await editor.pressSequentially('Unsent text');
    assert.equal(await editor.inputValue(), 'Unsent text');
    await page.evaluate(() => { window.unhandledKeys = []; });
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '');
    assert.ok(!(await page.evaluate(() => window.unhandledKeys)).includes('z'));
  });

  test('development reload removes the old startup keyboard handler', async t => {
    const page = await startupPage(t, 'development');
    const result = await page.evaluate(() => {
      const input = document.createElement('textarea'); document.body.append(input); input.focus();
      const pressUndo = () => {
        const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const before = pressUndo();
      window.disposeStartup();
      return { before, after: pressUndo() };
    });
    assert.deepEqual(result, { before: true, after: false });
    assert.equal(await page.getByRole('status').count(), 0);
  });

  test('e2e startup uses the orange link palette', async t => {
    const page = await startupPage(t, 'e2e');
    const color = await page.getByRole('link', { name: 'Reference' }).evaluate(link => getComputedStyle(link).color);
    assert.equal(color, 'rgb(212, 106, 36)');
  });

  test('e2e startup shows that the workspace is still loading', async t => {
    const page = await startupPage(t, 'e2e');
    assert.equal(await page.getByRole('status').textContent(), 'Restoring workspace…');
  });

  test('e2e startup enables undo in an editable field', async t => {
    const page = await startupPage(t, 'e2e');
    await page.evaluate(() => {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Draft');
      document.body.append(input);
      window.unhandledKeys = [];
      window.addEventListener('keydown', event => window.unhandledKeys.push(event.key));
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click();
    await editor.pressSequentially('Unsent text');
    assert.equal(await editor.inputValue(), 'Unsent text');
    await page.evaluate(() => { window.unhandledKeys = []; });
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '');
    assert.ok(!(await page.evaluate(() => window.unhandledKeys)).includes('z'));
  });

  test('startup enables Ctrl+Y redo without sending the shortcut to other handlers', async t => {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Draft'); document.body.append(input);
      window.unhandledKeys = [];
      window.addEventListener('keydown', event => window.unhandledKeys.push(event.key));
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click(); await editor.pressSequentially('Restore this text');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '');
    await page.evaluate(() => { window.unhandledKeys = []; });
    await editor.press('Control+y');
    assert.equal(await editor.inputValue(), 'Restore this text');
    assert.ok(!(await page.evaluate(() => window.unhandledKeys)).includes('y'));
  });

  test('startup enables Meta+Shift+Z redo without sending the shortcut to other handlers', async t => {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Draft'); document.body.append(input);
      window.unhandledKeys = [];
      window.addEventListener('keydown', event => window.unhandledKeys.push(event.key));
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click(); await editor.pressSequentially('Restore this text');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), '');
    await page.evaluate(() => { window.unhandledKeys = []; });
    await editor.press('Meta+Shift+z');
    assert.equal(await editor.inputValue(), 'Restore this text');
    assert.ok(!(await page.evaluate(() => window.unhandledKeys)).some(key => key.toLowerCase() === 'z'));
  });

  test('startup enables undo in a contenteditable field', async t => {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const field = document.createElement('div');
      field.contentEditable = 'true';
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-label', 'Editable draft');
      document.body.append(field);
    });
    const editor = page.getByRole('textbox', { name: 'Editable draft' });
    await editor.click();
    await editor.pressSequentially('Unsent text');
    assert.equal(await editor.textContent(), 'Unsent text');
    await editor.press('Control+z');
    assert.equal(await editor.textContent(), '');
  });

  test('typing z remains ordinary text after startup', async t => {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Draft'); document.body.append(input);
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click();
    await editor.pressSequentially('z');
    assert.equal(await editor.inputValue(), 'z');
  });

  async function ignoredHistoryKey(t, options, alreadyHandled = false) {
    const page = await startupPage(t, 'production');
    await page.evaluate(() => {
      const field = document.createElement('textarea'); field.setAttribute('aria-label', 'Draft'); document.body.append(field);
    });
    const editor = page.getByRole('textbox', { name: 'Draft' });
    await editor.click(); await editor.pressSequentially('Keep this text');
    return page.evaluate(({ options, alreadyHandled }) => {
      const input = document.activeElement;
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...options });
      if (alreadyHandled) event.preventDefault();
      let propagated = false;
      window.addEventListener('keydown', () => { propagated = true; }, { once: true });
      input.dispatchEvent(event);
      return { prevented: event.defaultPrevented, propagated, text: input.value };
    }, { options, alreadyHandled });
  }

  test('startup leaves composing keyboard input unchanged', async t => {
    assert.deepEqual(await ignoredHistoryKey(t, { isComposing: true }), { prevented: false, propagated: true, text: 'Keep this text' });
  });

  test('startup leaves Ctrl+Alt+Z available to other handlers', async t => {
    assert.deepEqual(await ignoredHistoryKey(t, { altKey: true }), { prevented: false, propagated: true, text: 'Keep this text' });
  });

  test('startup leaves Ctrl+Shift+Y available to other handlers', async t => {
    assert.deepEqual(await ignoredHistoryKey(t, { key: 'Y', shiftKey: true }), { prevented: false, propagated: true, text: 'Keep this text' });
  });

  test('startup leaves Ctrl+A available to other handlers', async t => {
    assert.deepEqual(await ignoredHistoryKey(t, { key: 'a' }), { prevented: false, propagated: true, text: 'Keep this text' });
  });

  test('startup does not undo an event already handled by another listener', async t => {
    assert.deepEqual(await ignoredHistoryKey(t, {}, true), { prevented: true, propagated: true, text: 'Keep this text' });
  });

  test('startup leaves undo available to a read-only textarea', async t => {
    const page = await startupPage(t, 'production');
    const result = await page.evaluate(() => {
      const field = document.createElement('textarea'); field.readOnly = true;
      if (!field.isConnected) document.body.append(field);
      field.focus();
      field.value = 'Keep this value';
      let received = false;
      window.addEventListener('keydown', () => { received = true; }, { once: true });
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, received, value: field.value };
    });
    assert.deepEqual(result, { prevented: false, received: true, value: 'Keep this value' });
  });

  test('startup leaves undo available to a disabled input', async t => {
    const page = await startupPage(t, 'production');
    const result = await page.evaluate(() => {
      const field = document.createElement('input'); field.disabled = true;
      if (!field.isConnected) document.body.append(field);
      field.focus();
      field.value = 'Keep this value';
      let received = false;
      window.addEventListener('keydown', () => { received = true; }, { once: true });
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, received, value: field.value };
    });
    assert.deepEqual(result, { prevented: false, received: true, value: 'Keep this value' });
  });

  test('startup leaves undo available to a checkbox', async t => {
    const page = await startupPage(t, 'production');
    const result = await page.evaluate(() => {
      const field = document.createElement('input'); field.type = 'checkbox';
      if (!field.isConnected) document.body.append(field);
      field.focus();
      field.value = 'Keep this value';
      let received = false;
      window.addEventListener('keydown', () => { received = true; }, { once: true });
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, received, value: field.value };
    });
    assert.deepEqual(result, { prevented: false, received: true, value: 'Keep this value' });
  });

  test('startup leaves undo available to a button', async t => {
    const page = await startupPage(t, 'production');
    const result = await page.evaluate(() => {
      const field = document.createElement('button');
      if (!field.isConnected) document.body.append(field);
      field.focus();
      field.value = 'Keep this value';
      let received = false;
      window.addEventListener('keydown', () => { received = true; }, { once: true });
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, received, value: field.value };
    });
    assert.deepEqual(result, { prevented: false, received: true, value: 'Keep this value' });
  });

  test('startup leaves undo available to a terminal input', async t => {
    const page = await startupPage(t, 'production');
    const result = await page.evaluate(() => {
      const terminal = document.createElement('div'); terminal.className = 'xterm'; document.body.append(terminal); const field = document.createElement('textarea'); terminal.append(field);
      if (!field.isConnected) document.body.append(field);
      field.focus();
      field.value = 'Keep this value';
      let received = false;
      window.addEventListener('keydown', () => { received = true; }, { once: true });
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return { prevented: event.defaultPrevented, received, value: field.value };
    });
    assert.deepEqual(result, { prevented: false, received: true, value: 'Keep this value' });
  });
});
