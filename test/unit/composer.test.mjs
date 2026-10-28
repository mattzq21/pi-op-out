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
    props = { streaming: false, queued: 0, commands: [], agents: [], models: [], model: null, thinkingLevel: 'off', thinkingLevels: ['off', 'high'], onSend: async (message, behavior, images, submission) => { assert.equal(submission, undefined, 'unstaged sends carry no draft submission'); sent.push([message, behavior, images]); }, onAbort: async () => {}, onAgent: () => {}, onModel: () => {}, onThinking: () => {}, onToggleFastMode: async () => {} };
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

  test('Send becomes available again when a stop finishes after the reply has already ended', async () => {
    let finishStop;
    await render({ streaming: true, onAbort: () => new Promise(resolve => { finishStop = resolve; }) });
    await click(control('Stop piop'));
    await render({ streaming: false });
    await act(async () => finishStop());
    await enterText(editor(), 'Next prompt');
    assert.equal(control('Send message').disabled, false);
    await click(control('Send message'));
    assert.deepEqual(sent, [['Next prompt', undefined, []]]);
  });


  test('a queued message is edited in place: Enter saves, Escape cancels, and a failed save keeps the editor open', async () => {
    const changes = [];
    let failure;
    const pendingMessages = [{ id: '1', message: 'Fix the typo', behavior: 'followUp' }, { id: 'goal', message: 'Ship it', behavior: 'followUp', goal: true }];
    await render({ streaming: true, queued: 1, pendingMessages, onChangePending: async (id, action) => { changes.push([id, action]); if (failure) throw new Error(failure); } });
    assert.equal(control('Edit queued message: Ship it'), null, 'the goal entry is edited with /goal edit');
    await click(control('Edit queued message: Fix the typo'));
    const field = () => document.querySelector('.pending-edit');
    await key('Escape', {}, field());
    assert.equal(field(), null);
    assert.deepEqual(changes, []);
    await click(control('Edit queued message: Fix the typo'));
    failure = 'This message is being sent and can no longer be edited.';
    await enterText(field(), 'Fix the typo in the title');
    await key('Enter', {}, field());
    await untilDom(() => document.body.textContent.includes(failure));
    assert.ok(field(), 'the editor stays open after a failed save');
    failure = undefined;
    await key('Enter', {}, field());
    await untilDom(() => !field());
    const edit = { type: 'edit', message: 'Fix the typo in the title', images: { keep: [], add: [] } };
    assert.deepEqual(changes, [['1', edit], ['1', edit]]);
  });

  test('a queued message is edited with its images and text files, a pasted file is attached, and a queued /compact has no edit button', async () => {
    const changes = [];
    const message = 'Review these\n\n<file name="notes.md">\nFirst note\n</file>\n\n<file name="old.txt">\nOld text\n</file>';
    const pendingMessages = [
      { id: '1', goalSubmissionId: 'submission-1', message, behavior: 'followUp', images: [{ type: 'image', mimeType: 'image/png', name: 'first.png', id: 'image-1' }, { type: 'image', mimeType: 'image/png', name: 'second.png', id: 'image-2' }] },
      { id: '2', goalSubmissionId: 'submission-2', message: '/compact keep it short', behavior: 'followUp' },
    ];
    await render({ streaming: true, queued: 2, pendingMessages, loadPendingImage: async () => ({ data: 'AAAA', mimeType: 'image/png' }), onChangePending: async (id, action) => { changes.push([id, action]); } });
    assert.equal(control('Edit queued message: /compact keep it short'), null, 'a queued /compact runs as it is');
    await click(control('Edit queued message: ' + message));
    const field = () => document.querySelector('.pending-edit');
    assert.equal(field().value, 'Review these', 'the text files show as attachments, not as text');
    await click(control('Remove old.txt'));
    await click(control('Remove first.png'));
    const pasted = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasted, 'clipboardData', { value: { files: [new File(['New text'], 'new.txt', { type: 'text/plain' })], items: [], getData: () => '' } });
    await act(async () => field().dispatchEvent(pasted));
    await untilDom(() => control('Remove new.txt'));
    await enterText(field(), 'Review these again');
    await key('Enter', {}, field());
    await untilDom(() => !field());
    assert.deepEqual(changes, [['1', { type: 'edit', message: 'Review these again\n\n<file name="notes.md">\nFirst note\n</file>\n\n<file name="new.txt">\nNew text\n</file>', images: { keep: [1], add: [] } }]]);
  });


  test('a streaming draft has a clickable follow-up send action', async () => {
    await render({ streaming: true });
    await enterText(editor(), 'After this turn');
    assert.ok(control('Send message'));
    await click(control('Send message'));
    assert.deepEqual(sent, [['After this turn', 'followUp', []]]);
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
    await render({ controlsDisabled: true });
    assert.equal(control('Send message').disabled, true);
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
  test('the hold button shows with an empty queue, so the queue can be held before sending, and then offers resume', async () => {
    const holds = [];
    const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label);
    await render({ onHoldQueue: async held => { holds.push(held); } });
    assert.equal(control('Pending messages'), null);
    await click(button('Hold queue'));
    assert.deepEqual(holds, [true]);
    await render({ queueHeld: true });
    assert.ok(control('Pending messages'));
    assert.match(document.body.textContent, /Queue on hold/);
    await click(button('Resume queue'));
    assert.deepEqual(holds, [true, false]);
    await render({ queueHeld: false, onHoldQueue: undefined });
    assert.equal(button('Hold queue'), undefined);
  });

});
