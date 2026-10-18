import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

async function searchPage(t) {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/find-in-page-browser.tsx', ready: '#chat button', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Conversation focus' }).focus();
  return page;
}

async function openSearch(page, text) {
  await page.keyboard.press('Control+f');
  const input = page.getByRole('textbox', { name: 'Find in page' });
  await input.waitFor();
  await input.evaluate(element => new Promise(resolve => {
    if (document.activeElement === element) { resolve(); return; }
    element.addEventListener('focus', () => resolve(), { once: true });
  }));
  if (text !== undefined) await input.fill(text);
  return input;
}

const count = page => page.getByRole('search').getByRole('status').textContent();

test('Find leaves another focused conversation for its own search to handle', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/find-other-conversation-browser.tsx', ready: '[aria-label="Copy message"]', holdStorage: false,
  });
  await trackShortcut(page);
  const copy = page.getByRole('button', { name: 'Copy message', exact: true });
  await copy.focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
  assert.equal(await copy.evaluate(node => node === document.activeElement), true);
});

test('recording Ctrl+F in Settings does not open conversation search', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/find-settings-browser.tsx', ready: '[aria-label="New conversation shortcut"]', holdStorage: false,
  });
  const recorder = page.getByRole('textbox', { name: 'New conversation shortcut', exact: true });
  await recorder.focus();
  await page.keyboard.press('Control+f');
  assert.equal(await recorder.inputValue(), 'Ctrl+F');
  assert.equal(await page.getByRole('search').count(), 0);
  assert.equal(await recorder.evaluate(node => node === document.activeElement), true);
});

const waitForCount = (page, expected) => page.evaluate(expected => new Promise((resolve, reject) => {
  const status = document.querySelector('[role="search"] [role="status"]');
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => {
    observer.disconnect();
    reject(new Error(`Count stayed "${status.textContent}", expected "${expected}"`));
  }, 15000);
  function check() {
    if (status.textContent !== expected) return;
    observer.disconnect();
    clearTimeout(timer);
    resolve();
  }
  observer.observe(status, { subtree: true, childList: true, characterData: true });
  check();
}), expected);

test('live DOM changes rescan matches and retain the current match when its text node survives', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  await page.keyboard.press('Enter');
  assert.equal(await count(page), '2 / 2');
  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'alpha';
    document.querySelector('#chat .messages').prepend(paragraph);
  });
  await waitForCount(page, '3 / 3');
  await page.evaluate(() => { document.querySelector('#chat .messages').innerHTML = '<p>gone</p>'; });
  await waitForCount(page, 'No matches');
  assert.equal(await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(), true);
});

test('toggling hidden text during a search updates matches and keeps the current match', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  await page.keyboard.press('Enter');
  assert.equal(await count(page), '2 / 2');
  await page.evaluate(() => { document.querySelector('#chat p[hidden]').hidden = false; });
  await waitForCount(page, '2 / 3');
  await page.evaluate(() => { document.querySelectorAll('#chat .messages > p')[2].hidden = true; });
  await waitForCount(page, '2 / 2');
});

test('search matches query whitespace across normal and preformatted text', async t => {
  const page = await searchPage(t);
  await page.evaluate(() => {
    document.querySelector('#chat .messages').innerHTML = '<p>one \n\t <em> two</em>  three</p><pre style="white-space:pre">one  two</pre>';
  });
  const input = await openSearch(page, 'one two three');
  assert.equal(await count(page), '1 / 1');
  await input.fill('one  two');
  assert.equal(await count(page), '1 / 2');
  await input.fill('one two');
  assert.equal(await count(page), '1 / 2');
});

test('Enter during text composition preserves the current search result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  await page.keyboard.press('Enter');
  assert.equal(await count(page), '2 / 2');
  await page.evaluate(() => {
    window.addEventListener('keydown', event => {
      if (event.key === 'Enter') queueMicrotask(() => {
        window.compositionKey = { composing: event.isComposing, prevented: event.defaultPrevented };
      });
    });
  });
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.imeSetComposition', { text: 'alpha', selectionStart: 5, selectionEnd: 5, replacementStart: 0, replacementEnd: 5 });
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.compositionKey), { composing: true, prevented: false });
    assert.equal(await count(page), '2 / 2');
    await input.send('Input.insertText', { text: 'alpha' });
    await page.keyboard.press('Enter');
    assert.equal(await count(page), '1 / 2');
  } finally { await input.detach(); }
});

async function trackShortcut(page) {
  await page.evaluate(() => {
    window.addEventListener('keydown', event => {
      if (event.key.toLowerCase() === 'f') queueMicrotask(() => {
        window.findShortcutPrevented = event.defaultPrevented;
        window.findShortcutComposing = event.isComposing;
      });
    });
  });
}

test('Find during text composition leaves search closed', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.getByRole('textbox', { name: 'Example editor' }).focus();
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press('Control+f');
    assert.equal(await page.evaluate(() => window.findShortcutComposing), true);
    assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
    assert.equal(await page.getByRole('search').count(), 0);
    await input.send('Input.insertText', { text: '日本' });
    const search = await openSearch(page);
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
  } finally { await input.detach(); }
});

test('an open modal dialog leaves the Find shortcut unhandled', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    const button = document.createElement('button');
    button.textContent = 'Dialog control';
    dialog.append(button);
    document.body.append(dialog);
    dialog.showModal();
  });
  assert.equal(await page.getByRole('button', { name: 'Dialog control' }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
  await page.keyboard.press('Escape');
  // Closing the dialog gives focus back to the earlier element a moment later, so Find may need a moment to take it.
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  const input = await openSearch(page);
  await input.evaluate(node => new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const check = () => node === document.activeElement ? resolve() : performance.now() > deadline ? reject(new Error('The search box never took focus')) : requestAnimationFrame(check);
    check();
  }));
});

test('Find focuses the search input when it opens', async t => {
  const page = await searchPage(t);
  assert.equal(await page.getByRole('search').count(), 0);
  const input = await openSearch(page);
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
});

test('search counts visible text and excludes hidden text and editing fields', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
});

test('search finds a phrase across inline formatting', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha beta');
  assert.equal(await count(page), '1 / 1');
});

test('search treats regular expression symbols as literal text', async t => {
  const page = await searchPage(t);
  await openSearch(page, '[a+b]');
  assert.equal(await count(page), '1 / 1');
});

test('a phrase split between paragraphs has no matches to navigate', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'separate blocks');
  assert.equal(await count(page), 'No matches');
  assert.equal(await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Previous match', exact: true }).isDisabled(), true);
});

test('clearing the query clears the result count', async t => {
  const page = await searchPage(t);
  const input = await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await input.fill('');
  assert.equal(await count(page), '');
});

test('Enter advances through search results and wraps to the first result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.keyboard.press('Enter');
  assert.equal(await count(page), '2 / 2');
  await page.keyboard.press('Enter');
  assert.equal(await count(page), '1 / 2');
});

test('Shift+Enter moves backward and wraps to the last search result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await count(page), '2 / 2');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await count(page), '1 / 2');
});

test('F3 advances through search results and wraps to the first result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.keyboard.press('F3');
  assert.equal(await count(page), '2 / 2');
  await page.keyboard.press('F3');
  assert.equal(await count(page), '1 / 2');
});

test('Shift+F3 moves backward and wraps to the last search result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.keyboard.press('Shift+F3');
  assert.equal(await count(page), '2 / 2');
  await page.keyboard.press('Shift+F3');
  assert.equal(await count(page), '1 / 2');
});

test('Next match advances through results and wraps to the first result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  assert.equal(await count(page), '2 / 2');
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  assert.equal(await count(page), '1 / 2');
});

test('Previous match moves backward and wraps to the last result', async t => {
  const page = await searchPage(t);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.getByRole('button', { name: 'Previous match', exact: true }).click();
  assert.equal(await count(page), '2 / 2');
  await page.getByRole('button', { name: 'Previous match', exact: true }).click();
  assert.equal(await count(page), '1 / 2');
});

test('Escape closes search and restores the previous focus', async t => {
  const page = await searchPage(t);
  const input = await openSearch(page, 'alpha');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('search').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Conversation focus' }).evaluate(node => node === document.activeElement), true);
});

test('Close find closes the search and restores the previous focus', async t => {
  const page = await searchPage(t);
  const input = await openSearch(page, 'alpha');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  await page.getByRole('button', { name: 'Close find', exact: true }).click();
  assert.equal(await page.getByRole('search').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Conversation focus' }).evaluate(node => node === document.activeElement), true);
});

test('Ctrl+Alt+F remains available for other shortcuts', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.keyboard.press('Control+Alt+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
});

test('Ctrl+Shift+F remains available for other shortcuts', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.keyboard.press('Control+Shift+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
});

test('disabled search leaves the Find shortcut available to the browser', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.getByRole('checkbox', { name: 'Enable search' }).uncheck();
  await page.getByRole('button', { name: 'Conversation focus' }).focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
});

test('an inactive search outside the focused conversation leaves Find unhandled', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.getByRole('checkbox', { name: 'Active conversation' }).uncheck();
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
});

test('Find opens an inactive search when its conversation has focus', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await page.getByRole('checkbox', { name: 'Active conversation' }).uncheck();
  await page.getByRole('button', { name: 'Conversation focus' }).focus();
  const input = await openSearch(page);
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
});

test('disabling an open search removes its controls and releases Find', async t => {
  const page = await searchPage(t);
  await trackShortcut(page);
  await openSearch(page, 'alpha');
  assert.equal(await count(page), '1 / 2');
  await page.getByRole('checkbox', { name: 'Enable search' }).uncheck();
  assert.equal(await page.getByRole('search').count(), 0);
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => window.findShortcutPrevented), false);
  assert.equal(await page.getByRole('search').count(), 0);
});
