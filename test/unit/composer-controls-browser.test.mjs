import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { testBrowserName } from '../test-browser.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';

async function controlsPage(t) {
  const native = await nativeFileCommand(t, { desktop: true });
  return startupPage(t, 'development', {
    entryPoint: 'test/fixtures/composer-controls-browser.tsx', ready: '[aria-label="Message piop"]', holdStorage: false,
    prepare: page => page.exposeFunction('nativeCommand', (command, args) => native.invoke(command, args)),
  });
}

test('an agent with an unavailable model is disabled until repaired', async t => {
  const page = await controlsPage(t);
  await page.getByRole('checkbox', { name: 'Review model unavailable', exact: true }).check();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const review = page.getByRole('option', { name: /review/ });
  assert.equal(await review.isDisabled(), true);
  assert.match(await review.textContent(), /Model missing\/model is unavailable/);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Review model unavailable', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  assert.equal(await review.isDisabled(), false);
  await review.click();
  assert.deepEqual(await choices(page), ['review']);
});

test('an explicit focus request focuses the message editor', async t => {
  const page = await controlsPage(t);
  const button = page.getByRole('button', { name: 'Focus message editor', exact: true });
  await button.focus();
  assert.equal(await button.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Message piop' }).evaluate(node => new Promise(resolve => {
    if (node === document.activeElement) resolve();
    else node.addEventListener('focus', resolve, { once: true });
  }));
  assert.equal(await page.getByRole('textbox', { name: 'Message piop' }).evaluate(node => node === document.activeElement), true);
});

const choices = async page => JSON.parse(await page.getByLabel('Selected values').textContent());
const focused = locator => locator.evaluate(node => node === document.activeElement);

test('model, agent and thinking pickers return selected values and restore trigger focus', async t => {
  const page = await controlsPage(t);
  const agent = page.getByRole('button', { name: 'Agent', exact: true });
  const model = page.getByRole('button', { name: 'Model', exact: true });
  const thinking = page.getByRole('button', { name: 'Thinking level', exact: true });
  await agent.click();
  assert.equal(await focused(page.getByRole('option', { name: 'default', exact: true })), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(page.getByRole('option', { name: 'review', exact: true })), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await choices(page), ['review']);
  assert.equal(await focused(agent), true);
  await model.click();
  await page.getByRole('option', { name: 'Small provider', exact: true }).click();
  assert.deepEqual(await choices(page), ['review', { provider: 'provider', id: 'gpt-small', name: 'gpt-Small' }]);
  assert.equal(await focused(model), true);
  await thinking.click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  assert.deepEqual(await choices(page), ['review', { provider: 'provider', id: 'gpt-small', name: 'gpt-Small' }, 'high']);
  assert.equal(await focused(thinking), true);
  await agent.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('listbox', { name: 'Agent options', exact: true }).count(), 0);
  assert.equal(await focused(agent), true);
  await model.click();
  await page.getByRole('listbox', { name: 'Model options', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Disable controls', exact: true }).evaluate(node => node.click());
  assert.equal(await page.getByRole('listbox', { name: 'Model options', exact: true }).count(), 0);
  assert.equal(await model.isDisabled(), true);
});

test('an empty model picker explains that no options are available', async t => {
  const page = await controlsPage(t);
  await page.getByRole('checkbox', { name: 'Models available', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const options = page.getByRole('listbox', { name: 'Model options', exact: true });
  assert.match(await options.textContent(), /No options available/);
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await choices(page), []);
  assert.equal(await options.getByRole('option').count(), 0);
});

test('window resizing closes the model picker without selecting a model', async t => {
  const page = await controlsPage(t);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const options = page.getByRole('listbox', { name: 'Model options', exact: true });
  await options.waitFor();
  await page.setViewportSize({ width: 1000, height: 600 });
  await options.waitFor({ state: 'detached' });
  assert.deepEqual(await choices(page), []);
});

test('an outside click closes the agent picker without selecting an agent', async t => {
  const page = await controlsPage(t);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const options = page.getByRole('listbox', { name: 'Agent options', exact: true });
  await options.waitFor();
  await page.getByRole('button', { name: 'Focus message editor', exact: true }).click();
  assert.equal(await options.count(), 0);
  assert.deepEqual(await choices(page), []);
});

test('clicking the agent picker trigger again closes it without selection', async t => {
  const page = await controlsPage(t);
  const trigger = page.getByRole('button', { name: 'Agent', exact: true });
  const options = page.getByRole('listbox', { name: 'Agent options', exact: true });
  await trigger.click();
  await options.waitFor();
  await trigger.click();
  assert.equal(await options.count(), 0);
  assert.deepEqual(await choices(page), []);
  assert.equal(await focused(trigger), true);
});

const sent = async page => JSON.parse(await page.getByLabel('Sent messages').textContent());

test('an unavailable agent shows an error and blocks sending, but another agent can be chosen', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('Keep this draft');
  await page.getByRole('checkbox', { name: 'Agent unavailable', exact: true }).check();
  assert.equal(await page.getByRole('alert').textContent(), 'Agent "default" is unavailable. This conversation cannot start.');
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Agent', exact: true }).isDisabled(), false);
  await editor.press('Enter');
  assert.deepEqual(await sent(page), []);
  assert.equal(await editor.inputValue(), 'Keep this draft');
  await page.getByRole('checkbox', { name: 'Agent unavailable', exact: true }).uncheck();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  assert.equal((await sent(page))[0][0], 'Keep this draft');
});

test('command palette navigation completes and sends the selected command', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('/c');
  const commands = page.getByRole('listbox', { name: 'piop commands' });
  await commands.waitFor();
  assert.equal(await commands.getByRole('option').count(), 3);
  await page.keyboard.press('ArrowUp');
  assert.equal(await commands.getByRole('option', { selected: true }).textContent(), '/skill:Research');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await editor.inputValue(), '/compact ');
  assert.equal(await commands.count(), 0);
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['/compact', null, []]]);
});

test('skill mentions complete before expanding on send', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('Please $res');
  await page.keyboard.press('Enter');
  assert.equal(await editor.inputValue(), 'Please $Research ');
  assert.deepEqual(await sent(page), []);
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['/skill:Research Please $Research', null, []]]);
});

test('Escape dismisses the command palette without sending', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('/');
  const commands = page.getByRole('listbox', { name: 'piop commands' });
  await commands.waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await commands.count(), 0);
  assert.equal(await editor.inputValue(), '/');
  assert.deepEqual(await sent(page), []);
});

test('the command and its arguments stay above the message box while the command is written', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('/review');
  assert.deepEqual(await page.getByRole('listbox', { name: 'piop commands' }).getByRole('option').allTextContents(), ['/review [scope]']);
  await editor.fill('/review ');
  const review = page.getByLabel('/review arguments');
  await review.waitFor();
  assert.equal(await review.textContent(), '/review [scope]');
  await editor.fill('/review src');
  assert.equal(await review.textContent(), '/review [scope]');
  await editor.fill('/fast o');
  const fast = page.getByLabel('/fast arguments');
  assert.equal(await fast.textContent(), '/fast [on | off | toggle]');
  assert.equal(await page.getByRole('listbox', { name: 'piop commands' }).count(), 0);
  await editor.fill('/fast off');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['/fast off', null, []]]);
});

test('an outside click dismisses the command palette without sending', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('/cl');
  const commands = page.getByRole('listbox', { name: 'piop commands' });
  await commands.waitFor();
  await page.getByRole('checkbox', { name: 'Models available', exact: true }).click();
  assert.equal(await commands.count(), 0);
  assert.equal(await editor.inputValue(), '/cl');
  assert.deepEqual(await sent(page), []);
  await editor.click();
  await commands.waitFor();
});

test('submission trims text, ignores blank and composed input, and respects newline and delivery shortcuts', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await editor.fill('  ');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), []);
  await editor.fill('  Build it  ');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await editor.inputValue(), '  Build it  \n');
  assert.deepEqual(await sent(page), []);
  const input = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => window.addEventListener('keydown', event => {
      if (event.key === 'Enter') window.composingEnter = { composing: event.isComposing, trusted: event.isTrusted };
    }));
    await input.send('Input.imeSetComposition', { text: '  Build it  ', selectionStart: 12, selectionEnd: 12, replacementStart: 0, replacementEnd: 13 });
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.composingEnter), testBrowserName === 'webkit' ? undefined : { composing: true, trusted: true });
    assert.deepEqual(await sent(page), []);
    await input.send('Input.insertText', { text: '  Build it  ' });
    await page.keyboard.press('Enter');
    assert.deepEqual(await sent(page), [['Build it', null, []]]);
    assert.equal(await editor.inputValue(), '');
  } finally { await input.detach(); }
  await page.getByRole('checkbox', { name: 'Streaming response', exact: true }).check();
  await editor.fill('Steer now');
  await page.keyboard.press('Control+Enter');
  await editor.fill('Next turn');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['Build it', null, []], ['Steer now', 'steer', []], ['Next turn', 'followUp', []]]);
});

test('in-flight submission is deduplicated and failed sends preserve newer typing', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  const mode = page.getByRole('combobox', { name: 'Send result', exact: true });
  await mode.selectOption('hold');
  await editor.fill('Original');
  await page.keyboard.press('Enter');
  assert.equal(await editor.inputValue(), 'Original');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['Original', null, []]]);
  await editor.fill('Original\n\nNew thought');
  await page.getByRole('button', { name: 'Reject send', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'connection lost' }).waitFor();
  assert.equal(await editor.inputValue(), 'Original\n\nNew thought');
  await mode.selectOption('refuse');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Message was not submitted' }).waitFor();
  assert.equal(await editor.inputValue(), 'Original\n\nNew thought');
  await mode.selectOption('hold');
  await editor.focus();
  await page.keyboard.press('Enter');
  await editor.fill('Typed while sending');
  await page.getByRole('button', { name: 'Complete send', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Typed while sending');
  assert.equal(await page.getByRole('alert').count(), 0);
  await editor.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Complete send', exact: true }).click();
  assert.equal(await editor.inputValue(), '');
});

test('fast mode prevents repeated requests and reports failures while preserving server state', async t => {
  const page = await controlsPage(t);
  const fast = page.getByRole('button', { name: 'Fast mode', exact: true });
  assert.equal(await fast.count(), 0);
  await page.getByRole('button', { name: 'Enable Fast mode control', exact: true }).click();
  await fast.dblclick();
  assert.equal(await page.getByLabel('Fast mode requests', { exact: true }).textContent(), '1');
  assert.equal(await fast.getAttribute('aria-busy'), 'true');
  await page.getByRole('button', { name: 'Reject Fast mode request', exact: true }).click();
  const error = page.getByRole('alert');
  await error.waitFor();
  assert.equal(await error.textContent(), 'Could not toggle Fast mode: offline');
  assert.equal(await fast.getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Report Fast mode on', exact: true }).click();
  await fast.click();
  assert.equal(await error.count(), 0);
  assert.equal(await fast.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('Fast mode requests', { exact: true }).textContent(), '2');
});


test('a failed stop shows its error', async t => {
  const page = await controlsPage(t);
  await page.getByRole('checkbox', { name: 'Streaming response', exact: true }).check();
  await page.getByRole('button', { name: 'Stop piop', exact: true }).click();
  assert.equal(await page.getByRole('alert').textContent(), 'cannot stop');
  assert.equal(await page.getByLabel('Control requests', { exact: true }).textContent(), '["stop"]');
});

test('on a narrow screen the chat settings sit behind one button that opens and closes like a menu', async t => {
  const page = await controlsPage(t);
  await page.setViewportSize({ width: 600, height: 800 });
  const trigger = page.getByRole('button', { name: /^Chat settings: / });
  const agent = page.getByRole('group', { name: 'Chat settings' }).getByRole('button', { name: /^Agent/ });
  assert.equal(await agent.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: /^Thinking level/ }).isVisible(), true, 'effort stays outside the menu');

  await trigger.click();
  await agent.click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'detached' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await agent.waitFor();
  await agent.focus();
  await page.keyboard.press('Escape');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape gives focus back to the button');
  assert.equal(await agent.isVisible(), false);

  await trigger.click();
  await agent.waitFor();
  await page.getByRole('textbox', { name: 'Message piop' }).click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a click outside closes it');
  await trigger.click();
  await agent.waitFor();
  await page.mouse.click(590, 790);
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'a click on an empty spot closes it');
});

test('on a wide screen the chat settings show in the message bar without a menu button', async t => {
  const page = await controlsPage(t);
  await page.setViewportSize({ width: 1200, height: 800 });
  assert.equal(await page.getByRole('button', { name: /^Chat settings: / }).isVisible(), false);
  assert.equal(await page.getByRole('group', { name: 'Chat settings' }).getByRole('button', { name: /^Thinking level/ }).isVisible(), true);
});

test('every used skill reference is highlighted while it stays editable text', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.click();
  await page.keyboard.type('Make a $research then $grill-me on $research');
  await page.keyboard.press('Escape');
  const marks = () => editor.evaluate(node => [...node.querySelectorAll('.composer-skill')].map(mark => mark.textContent));
  assert.deepEqual(await marks(), ['$research', '$grill-me', '$research']);
  assert.equal(await editor.evaluate(node => node.value), 'Make a $research then $grill-me on $research');
  await editor.evaluate(node => node.setSelectionRange(16, 16));
  await page.keyboard.type('x');
  assert.equal(await editor.evaluate(node => node.value), 'Make a $researchx then $grill-me on $research');
  assert.deepEqual(await marks(), ['$grill-me', '$research']);
  assert.equal(await editor.evaluate(node => node.selectionStart), 17);
});

test('a dropped chat link goes where the pointer is, and a selected link shows as selected', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.click();
  await page.keyboard.type('alpha omega');
  const link = '[Other](piop://session/local/other)';
  const point = await editor.evaluate(node => { const range = document.createRange(); range.setStart(node.firstChild, 6); const rect = range.getClientRects()[0]; return { x: rect.left + 1, y: rect.top + rect.height / 2 }; });
  const offset = await editor.evaluate((node, { x, y }) => node.dropOffset(x, y), point);
  assert.equal(offset, 6);
  await editor.evaluate((node, offset) => { node.showDropCaret(offset); }, offset);
  assert.equal(await editor.evaluate(node => node.hasAttribute('data-drop-caret')), true);
  await editor.evaluate((node, { offset, link }) => { node.showDropCaret(undefined); node.insertAt(offset, link + ' '); }, { offset, link });
  assert.equal(await editor.inputValue(), `alpha ${link} omega`);
  assert.equal(await editor.evaluate(node => node.dropOffset(-100, -100)), 6 + link.length + 1, 'away from the box it uses the caret');
  await editor.evaluate((node, end) => node.setSelectionRange(6, end), 6 + link.length);
  await page.waitForFunction(() => document.querySelector('.composer-session-link')?.classList.contains('selected'));
  await editor.evaluate(node => node.setSelectionRange(0, 3));
  await page.waitForFunction(() => !document.querySelector('.composer-session-link')?.classList.contains('selected'));
  await page.keyboard.press('Control+z');
  assert.equal(await editor.inputValue(), 'alpha omega');
});

test('the caret after a chat link at the end stays on its line, and typing goes after the link', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.click();
  const link = '[Other](piop://session/local/other)';
  await editor.evaluate((node, link) => node.insertAt(0, link), link);
  const caret = await editor.evaluate(node => { const rect = document.getSelection().getRangeAt(0).getClientRects()[0]; const box = node.querySelector('.composer-session-link').getBoundingClientRect(); return { top: rect?.top, linkTop: box.top, left: rect?.left, linkRight: box.right }; });
  assert.ok(Math.abs(caret.top - caret.linkTop) < 4 && caret.left >= caret.linkRight - 1, JSON.stringify(caret));
  await page.keyboard.type('x');
  assert.equal(await editor.inputValue(), `${link}x`);
  await editor.evaluate((node, end) => node.setSelectionRange(0, end), link.length);
  assert.equal(await editor.evaluate(node => node.selectionEnd), link.length);
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.equal(await editor.inputValue(), '');
});

test('each arrow and delete key press next to a chat link has an effect', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.click();
  const a = '[A](piop://session/local/a)';
  const b = '[B](piop://session/local/b)';
  await editor.evaluate((node, text) => node.insertAt(0, text), a + b);
  const caret = () => editor.evaluate(node => [node.selectionStart, node.selectionEnd]);
  await editor.evaluate((node, at) => node.setSelectionRange(at, at), a.length);
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await caret(), [a.length + b.length, a.length + b.length]);
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await caret(), [a.length, a.length]);
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await caret(), [0, 0]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await caret(), [a.length, a.length + b.length]);
  await page.keyboard.press('ArrowLeft');
  await editor.evaluate((node, at) => node.setSelectionRange(at, at), a.length);
  await page.keyboard.press('Delete');
  assert.equal(await editor.inputValue(), a);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  assert.equal(await editor.inputValue(), '');
});

test('Ctrl+Z and Ctrl+Y undo and redo typing separated by a pause', async t => {
  const page = await controlsPage(t);
  await page.clock.install();
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.click();
  await page.keyboard.type('hello');
  await page.clock.fastForward(1100);
  await page.keyboard.type('world');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.inputValue(), 'helloworld\n');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.inputValue(), 'helloworld');
  await page.keyboard.press('Control+z');
  assert.equal(await editor.inputValue(), 'hello');
  await page.keyboard.press('Control+y');
  assert.equal(await editor.inputValue(), 'helloworld');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await editor.inputValue(), 'helloworld');
  await page.keyboard.press('Control+y');
  assert.equal(await editor.inputValue(), 'helloworld\n');
  await page.keyboard.type('!');
  assert.equal(await editor.inputValue(), 'helloworld\n!');
  await page.keyboard.press('Control+y');
  assert.equal(await editor.inputValue(), 'helloworld\n!');
});

test('Enter sends a fully typed command instead of completing it, Tab still completes', async t => {
  const page = await controlsPage(t);
  const editor = page.getByRole('textbox', { name: 'Message piop' });
  await editor.fill('/review');
  await page.getByRole('listbox', { name: 'piop commands' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await editor.inputValue(), '/review ');
  assert.deepEqual(await sent(page), []);
  await editor.fill('/review');
  await page.getByRole('listbox', { name: 'piop commands' }).waitFor();
  await page.keyboard.press('Enter');
  assert.deepEqual(await sent(page), [['/review', null, []]]);
});
