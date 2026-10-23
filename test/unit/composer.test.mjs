import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeFileCommand } from '../native-file-command.mjs';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act, untilDom } from '../dom.mjs';
import { trackStorage } from '../storage-idle.mjs';
import { Composer } from '../../clients/ui/components/Composer.tsx';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';

describe('composer interactions', () => {
  let dom, view, props, sent, storage;
  beforeEach(() => {
    dom = installDom(); storage = trackStorage(indexedDB); HTMLElement.prototype.scrollIntoView = () => {};

    sent = [];
    props = { streaming: false, queued: 0, commands: [], agents: [], models: [], model: null, thinkingLevel: 'off', thinkingLevels: ['off', 'high'], onSend: async (message, behavior, images, submission) => { assert.equal(submission, undefined, 'unstaged sends carry no draft submission'); sent.push([message, behavior, images]); }, onPause: async () => {}, onResume: async () => {}, onAbort: async () => {}, onAgent: () => {}, onModel: () => {}, onThinking: () => {}, onToggleFastMode: async () => {} };
  });
  afterEach(async () => {
    if (view) await view.unmount(); view = undefined;
    await storage.settled(); storage.restore();
    clearMocks();

    dom.restore();
  });

  async function render(extra = {}) { props = { ...props, ...extra };

  if (view) await view.rerender(props); else view = await renderComponent(Composer, props); }

  const control = label => [...document.querySelectorAll('[aria-label]')].find(element => element.getAttribute('aria-label') === label) ?? null;
  const editor = () => control('Message piop');
  const click = async element => act(async () => element.click());

  const key = async (key, extra = {}, element = editor()) => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); await act(async () => element.dispatchEvent(event));

  return event; };

  const paste = async files => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files, items: [], getData: () => files.length ? '' : 'plain text' } }); await act(async () => editor().dispatchEvent(event));

  return event; };

  const drag = async (type, data = {}, target = editor()) => {
    const transfer = { types: ['Files'], files: [], getData: () => '', ...data };
    const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer });
    await act(async () => target.dispatchEvent(event));

    return { event, transfer };
  };

  test('choices retry appears only for a settled failure and clears after recovery', async () => {
    const retry = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry loading choices');
    await render({ refreshError: 'Could not refresh conversation: offline', capabilityErrors: [], capabilitiesLoading: false });
    assert.equal(retry(), undefined);
    assert.match(document.body.textContent, /Retry loading chat/);
    await render({ refreshError: undefined, capabilityErrors: [], capabilitiesLoading: true });
    assert.equal(retry(), undefined);
    await render({ capabilityErrors: ['Could not load models: offline'], capabilitiesLoading: false });
    assert.ok(retry());
    await render({ capabilitiesLoading: true });
    assert.equal(retry(), undefined);
    await render({ capabilityErrors: [], capabilitiesLoading: false });
    assert.equal(retry(), undefined);
  });

  test('a streaming draft has a clickable follow-up send action', async () => {
    await render({ streaming: true });
    await enterText(editor(), 'After this turn');
    assert.ok(control('Send message'));
    await click(control('Send message'));
    assert.deepEqual(sent, [['After this turn', 'followUp', []]]);
    assert.ok(control('Pause piop'));
  });

  test('restored drafts apply once without replacing user edits', async () => {
    await render({ restoredDraft: { id: 'a', value: 'Restore me' } }); assert.equal(editor().value, 'Restore me');
    await enterText(editor(), 'Edited'); await render({ restoredDraft: { id: 'b', value: 'Other text' } }); assert.equal(editor().value, 'Edited');
    await enterText(editor(), ''); await render({ restoredDraft: { id: 'b', value: 'Other text' } }); assert.equal(editor().value, '');
    await render({ restoredDraft: { id: 'c', value: 'Fresh' } }); assert.equal(editor().value, 'Fresh');
  });

  test('context indicators clamp percentages and describe unavailable usage', async () => {
    await render({ contextUsage: { tokens: 50, contextWindow: 200 } });
    assert.ok(control('25% of 200 context tokens used'));
    await render({ contextUsage: { tokens: null, contextWindow: 200 } }); assert.ok(control('Context usage unavailable; window is 200 tokens'));

    for (const [percent, expected] of [[-3, 0], [130, 100]]) { await render({ contextUsage: { percent, tokens: 50, contextWindow: 200 } }); assert.ok(control(`${expected}% of 200 context tokens used`)); }
  });

  test('pending messages display their text and labelled controls', async () => {
    await render({ pendingMessages: [{ id: 'steer', message: 'Steer now', behavior: 'steer' }, { id: 'later', message: 'Later task', behavior: 'followUp' }], onChangePending: async () => {} });
    assert.match(control('Pending messages').textContent, /Steer now/);
    assert.match(control('Pending messages').textContent, /Later task/);
    assert.ok(control('Remove queued message: Steer now'));
    assert.ok(control('Remove queued message: Later task'));
  });

  test('removing one of two queued messages with the same text targets the selected message after reordering and a failed attempt', async () => {
    const requests = []; let attempt;
    const onChangePending = (id, action) => { requests.push([id, action]); attempt = Promise.withResolvers(); return attempt.promise; };
    const first = { id: 'first', message: 'Same text', behavior: 'followUp' }, second = { id: 'second', message: 'Same text', behavior: 'followUp' };
    const removeButtons = () => [...document.querySelectorAll('[aria-label="Remove queued message: Same text"]')];
    await render({ pendingMessages: [first, second], onChangePending });
    await render({ pendingMessages: [second, first] });

    await click(removeButtons()[0]);
    assert.deepEqual(removeButtons().map(button => button.disabled), [true, true]);
    await act(async () => attempt.reject(new Error('queue changed')));
    assert.equal(document.querySelector('[role=alert]').textContent, 'queue changed');
    assert.deepEqual(removeButtons().map(button => button.disabled), [false, false]);

    await click(removeButtons()[0]);
    assert.equal(document.querySelector('[role=alert]'), null);
    await act(async () => attempt.resolve());
    await render({ pendingMessages: [first] });
    assert.equal(removeButtons().length, 1);
    await click(removeButtons()[0]);
    assert.deepEqual(requests, [['second', 'remove'], ['second', 'remove'], ['first', 'remove']]);
    await act(async () => attempt.resolve());
  });

  test('disabled controls preserve typed drafts and prevent submission', async () => {
    await render({ controlsDisabled: true, paused: true });
    assert.equal(control('Resume piop').disabled, true);
    await enterText(editor(), 'Draft while blocked'); await key('Enter');
    assert.deepEqual(sent, []);
    assert.equal(editor().value, 'Draft while blocked');
  });

  test("cache usage exposes the percentage and token counts", async () => {
    await render({ sessionCache: { rate: 20, low: true, cachedTokens: 20, promptTokens: 100 } });
    assert.match(control('Cache 20%, 20/100').textContent, /20%/);
  });

  test("the terminal control requests the terminal to open", async () => {
    let opens = 0;
    await render({ onOpenTerminal: () => opens++ });
    await click(control('Open terminal'));
    assert.equal(opens, 1);
  });

  test('URI drops attach local files and ignore remote or malformed URLs', async t => {
    const native = await nativeFileCommand(t);
    const first = join(native.directory, 'local file.txt'), second = join(native.directory, 'second.txt'), ignored = join(native.directory, 'ignored.txt');
    await Promise.all([writeFile(first, 'First'), writeFile(second, 'Second'), writeFile(ignored, 'Ignore')]);
    mockIPC((command, args) => native.invoke(command, args), { shouldMockEvents: true });
    await render();
    const remote = pathToFileURL(ignored); remote.hostname = 'remote';
    const localhost = pathToFileURL(second); localhost.hostname = 'localhost';
    await drag('drop', { getData: () => ['#comment', 'https://example.invalid/file', remote.href, pathToFileURL(first).href, localhost.href, 'file:///%ZZ'].join('\n') });
    await untilDom(() => control('Remove second.txt'));
    assert.ok(control('Remove local file.txt')); assert.equal(control('Remove ignored.txt'), null);
    assert.equal(document.querySelector('[role=alert]'), null);
    await key('Enter');
    assert.deepEqual(sent, [['<file name="local file.txt">\nFirst\n</file>\n\n<file name="second.txt">\nSecond\n</file>', undefined, []]]);
  });

  test('native URI batches respect the remaining attachment capacity', async t => {
    const native = await nativeFileCommand(t);
    const paths = Array.from({ length: 14 }, (_, index) => join(native.directory, `file${index}.txt`));
    await Promise.all(paths.map(path => writeFile(path, 'File content')));
    mockIPC((command, args) => native.invoke(command, args), { shouldMockEvents: true });
    await render(); await paste([new File(['One'], 'one.txt'), new File(['Two'], 'two.txt')]);
    await drag('drop', { getData: () => paths.map(path => pathToFileURL(path).href).join('\n') });
    await untilDom(() => control('Remove file9.txt'));
    assert.equal(document.querySelectorAll('button[aria-label^="Remove "]').length, 12);
    assert.ok(control('Remove one.txt')); assert.ok(control('Remove two.txt'));
    assert.equal(control('Remove file10.txt'), null); assert.equal(control('Remove file13.txt'), null);
    assert.match(document.querySelector('[role=alert]').textContent, /extra files were skipped/);
  });

});
