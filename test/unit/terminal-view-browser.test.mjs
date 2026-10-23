import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

const requestedSize = (page, previousColumns) => page.evaluate(previousColumns => new Promise(resolve => {
  const output = document.querySelector('[aria-label="Requested terminal size"]');
  const observer = new MutationObserver(check);
  function check() {
    if (!output.textContent) return;
    const size = JSON.parse(output.textContent);
    if (size.cols === previousColumns) return;
    observer.disconnect();
    resolve(size);
  }
  observer.observe(output, { childList: true, characterData: true, subtree: true });
  check();
}), previousColumns);

const terminalReply = (page, previous = '') => page.evaluate(previous => new Promise(resolve => {
  const output = document.querySelector('[aria-label="Previous input"]');
  const observer = new MutationObserver(check);
  function check() {
    const text = JSON.parse(output.textContent);
    if (text === previous) return;
    observer.disconnect();
    resolve(text);
  }
  observer.observe(output, { childList: true, characterData: true, subtree: true });
  check();
}), previous);

test('starts the shell once with the displayed terminal size', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.goto(page.url() + '?new');
  await page.locator('.xterm-screen').waitFor();
  const starts = JSON.parse(await page.getByLabel('Shell starts').textContent());
  assert.equal(starts.length, 1);
  assert.equal(starts[0].id, 'shell');
  assert.ok(starts[0].cols > 0 && starts[0].rows > 0);
  await page.getByRole('button', { name: 'Report screen bounds' }).click();
  assert.equal(await terminalReply(page), `\u001b[${starts[0].rows};${starts[0].cols}R`);
  await page.setViewportSize({ width: 800, height: 720 });
  const resized = await requestedSize(page, starts[0].cols);
  assert.ok(resized.cols < starts[0].cols);
  assert.deepEqual(JSON.parse(await page.getByLabel('Shell starts').textContent()), starts);
});

test('closing the view saves parsed output with its size and output position', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Show greeting' }).click();
  const reply = await terminalReply(page);
  assert.equal(reply, '\u001b[1;6R');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved screen').textContent()), {
    text: '\u001b[8;25;90thello', end: 19,
  });
  assert.equal(await page.locator('.xterm-screen').count(), 0);
});

test('invalid server resize sequences preserve the terminal screen dimensions', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Show greeting' }).click();
  assert.equal(await terminalReply(page), '\u001b[1;6R');
  await page.getByRole('button', { name: 'Send invalid size' }).click();
  assert.equal(await terminalReply(page, '\u001b[1;6R'), '\u001b[1;6R\u001b[1;6R');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved screen').textContent()), {
    text: '\u001b[8;25;90thello', end: 32,
  });
});

test('server resize sequences set the terminal screen dimensions', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Show greeting' }).click();
  assert.equal(await terminalReply(page), '\u001b[1;6R');
  await page.getByRole('button', { name: 'Send smaller size' }).click();
  assert.equal(await terminalReply(page, '\u001b[1;6R'), '\u001b[1;6R\u001b[1;6R');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved screen').textContent()), {
    text: '\u001b[8;20;70thello', end: 33,
  });
});

test('appends only unseen output and resets when a truncated buffer creates a gap', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Show greeting' }).click();
  assert.equal(await terminalReply(page), '\u001b[1;6R');
  await page.getByRole('button', { name: 'Append output', exact: true }).click();
  assert.equal(await terminalReply(page, '\u001b[1;6R'), '\u001b[1;6R\u001b[1;12R');
  await page.getByRole('button', { name: 'Show output after gap' }).click();
  assert.equal(await terminalReply(page, '\u001b[1;6R\u001b[1;12R'), '\u001b[1;6R\u001b[1;12R\u001b[1;4R');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved screen').textContent()), {
    text: '\u001b[8;25;90txyz', end: 40,
  });
});

test('typing uses the current input callback after a render update', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Previous input').textContent(), '"ls\\r"');
  assert.equal(await page.getByLabel('Current input').textContent(), '""');
  await page.getByRole('button', { name: 'Change input handler' }).click();
  await input.focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Current input').textContent(), '"pwd\\r"');
  assert.equal(await page.getByLabel('Previous input').textContent(), '"ls\\r"');
});

test('copy shortcut copies selection and reports clipboard failures without intercepting ordinary keys', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('unchanged'));
  await page.getByRole('button', { name: 'Show greeting' }).click();
  assert.equal(await terminalReply(page), '\u001b[1;6R');
  const screen = await page.locator('.xterm-screen').boundingBox();
  const x = screen.x + screen.width * 2.5 / 90, y = screen.y + screen.height * .5 / 25;
  await page.mouse.dblclick(x, y);
  await page.keyboard.press('Control+c');
  assert.equal(await terminalReply(page, '\u001b[1;6R'), '\u001b[1;6R\u0003');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'unchanged');
  await page.mouse.dblclick(x, y);
  await page.keyboard.press('Control+Shift+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'hello');
  assert.equal(JSON.parse(await page.getByLabel('Previous input').textContent()), '\u001b[1;6R\u0003');
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard access denied', 'NotAllowedError'); };
    document.execCommand = () => false;
  });
  await page.keyboard.press('Control+Shift+c');
  const status = page.getByRole('status').filter({ hasText: 'Could not copy terminal selection' });
  await status.waitFor();
  assert.match(await status.textContent(), /Could not copy terminal selection/);
  await page.mouse.click(x + screen.width * 10 / 90, y);
  await page.keyboard.press('Control+Shift+c');
  assert.equal(await status.count(), 0);
});

test('multiline paste retains shell paste markers and normalizes line endings', { timeout: 15000 }, async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('echo one\necho two\r\n'));
  await page.getByRole('button', { name: 'Enable bracketed paste', exact: true }).click();
  assert.equal(await terminalReply(page), '\u001b[1;1R');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+v');
  assert.equal(await terminalReply(page, '\u001b[1;1R'), '\u001b[1;1R\u001b[200~echo one\recho two\r\u001b[201~');
});

test('restores snapshots before replaying new output and preserves unparsed snapshots when switching tabs', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-restore-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  assert.equal(await terminalReply(page), '\u001b[1;10R');
  await page.getByRole('button', { name: 'Briefly open second tab', exact: true }).click();
  const interrupted = JSON.parse(await page.getByLabel('Saved screens').textContent());
  assert.deepEqual(interrupted.second, { text: '\u001b[8;25;90tsecond', end: 20 });
  assert.deepEqual(interrupted.first, { text: '\u001b[8;25;90tscreennew', end: 17 });
  assert.equal(await terminalReply(page, '\u001b[1;10R'), '\u001b[1;10R\u001b[1;10R');
  await page.getByRole('button', { name: 'Open second tab', exact: true }).click();
  assert.equal(await terminalReply(page, '\u001b[1;10R\u001b[1;10R'), '\u001b[1;10R\u001b[1;10R\u001b[1;11R');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Saved screens').textContent()), {
    first: { text: '\u001b[8;25;90tscreennew', end: 17 },
    second: { text: '\u001b[8;25;90tsecondnext', end: 28 },
  });
});

test('requests the terminal size measured by the browser after starting', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  const initial = await requestedSize(page);
  assert.ok(initial.cols > 0 && initial.rows > 0);
  await page.setViewportSize({ width: 800, height: 720 });
  const smaller = await requestedSize(page, initial.cols);
  assert.ok(smaller.cols > 0 && smaller.cols < initial.cols);
  assert.equal(smaller.rows, initial.rows);
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.deepEqual(await requestedSize(page, smaller.cols), initial);
});

test('Restart terminal requests a shell for the selected tab after it exits', async t => {
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/terminal-view-browser.tsx', ready: '.xterm-screen', holdStorage: false,
  });
  await page.getByRole('button', { name: 'Report screen bounds', exact: true }).click();
  const bounds = /^\u001b\[(\d+);(\d+)R$/.exec(await terminalReply(page));
  assert.ok(bounds);
  await page.getByRole('button', { name: 'Report shell exited', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Shell starts').textContent()), []);
  await page.getByRole('button', { name: 'Restart terminal', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByLabel('Shell starts').textContent()), [
    { id: 'shell', cols: Number(bounds[2]), rows: Number(bounds[1]) },
  ]);
  assert.equal(await page.getByRole('button', { name: 'Restart terminal', exact: true }).count(), 0);
});
