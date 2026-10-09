import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { StorageSettings } from '../../clients/ui/components/StorageSettings.tsx';
import { PromptContextBar } from '../../clients/ui/components/PromptContextBar.tsx';

describe('settings panels', () => {
  let dom, views, calls, responses;
  beforeEach(() => {
    dom = installDom(); views = []; calls = []; responses = new Map();
    mockIPC(async (command, args) => { calls.push({ command, args }); const value = responses.get(command);

    if (value instanceof Error) throw value;

    return value instanceof Function ? value(args) : value; });
  });
  afterEach(async () => { for (const view of views) await view.unmount(); clearMocks(); dom.restore(); });

  async function render(Component, props) { const view = await renderComponent(Component, props); views.push(view);

  return view; }

  const button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
  const click = async element => act(async () => element.click());
  const archive = (name, extra = {}) => ({ id: name, name, path: `/${name}.jsonl`, cwd: '/repo', byteSize: 42, modifiedAt: 100, deletable: true, ...extra });
  const host = (extra = {}) => ({ hostId: 'local', hostName: 'Local', categories: [], archives: [], warnings: [], ...extra });

  test('storage scan renders per-host categories, approximate totals, warnings and inaccessible hosts', async () => {
    const pending = Promise.withResolvers(); responses.set('storage_report', () => pending.promise);
    await render(StorageSettings); assert.match(document.querySelector('[role=status]').textContent, /Scanning storage/);
    const categories = [{ id: 'active-conversations', byteSize: 500, itemCount: 1 }, { id: 'archived-conversations', byteSize: 2048, itemCount: 2 }, { id: 'project-checkpoints', byteSize: 1024 ** 2, itemCount: 1, estimated: true }, { id: 'temporary-chats', byteSize: 1024 ** 4, itemCount: 1 }];
    await act(async () => pending.resolve({ hosts: [host({ categories, warnings: ['Repository missing'] }), host({ hostId: 'remote', hostName: 'Remote', error: 'offline' })] }));
    const text = document.body.textContent;

    for (const expected of ['About ', '500 B', '2.00 KiB', '1.00 MiB', '1.00 TiB', '1 conversation', '2 conversations', '1 ref', 'Storage unavailable', 'offline']) assert.ok(text.includes(expected), expected);
    assert.equal(document.querySelector('.storage-warning').dataset.tooltip, 'Repository missing');
    assert.equal(button('Refresh').disabled, false);
  });

  test('single archive deletion requires confirmation and refreshes the host report', async () => {
    const item = archive('Old chat'); responses.set('storage_report', { hosts: [host({ archives: [item] })] });
    const confirmations = []; window.confirm = text => { confirmations.push(text);

    return false; };

    await render(StorageSettings);
    const remove = document.querySelector('[aria-label="Permanently delete Old chat"]'); await click(remove);
    assert.equal(calls.filter(call => call.command === 'delete_archived_session').length, 0);
    const pending = Promise.withResolvers(); responses.set('delete_archived_session', () => pending.promise); window.confirm = () => true;
    await click(remove); assert.equal(remove.disabled, true); assert.equal(button('Refresh').disabled, true);
    assert.deepEqual(calls.at(-1), { command: 'delete_archived_session', args: { sessionPath: '/Old chat.jsonl', sessionPaths: ['/Old chat.jsonl'], hostId: 'local' } });
    responses.set('storage_report', { hosts: [host()] }); await act(async () => pending.resolve(['/Old chat.jsonl']));
    assert.equal(document.querySelector('.archive-row'), null); assert.equal(button('Refresh').disabled, false);
    assert.match(confirmations[0], /diff histories, project checkpoint refs/);
  });

  test('bulk archive deletion excludes unsafe archives and reports a failed batch after refreshing', async () => {
    const items = [archive('good'), archive('failed'), archive('unsafe', { deletable: false, deleteError: 'invalid data' })];
    responses.set('storage_report', { hosts: [host({ archives: items })] });
    responses.set('delete_archived_session', new Error('failed: locked'));

    await render(StorageSettings);
    assert.equal(document.querySelector('[aria-label^="Cannot safely delete"]').disabled, true);
    responses.set('storage_report', { hosts: [host({ archives: items.slice(1) })] });
    await click(button('Delete available'));
    assert.match(document.querySelector('dialog').textContent, /2 archived conversations on Local/);
    assert.equal(calls.some(call => call.command === 'delete_archived_session'), false);
    await click(document.querySelector('dialog .primary-button'));
    assert.deepEqual(calls.find(call => call.command === 'delete_archived_session').args, { sessionPath: '/good.jsonl', sessionPaths: ['/good.jsonl', '/failed.jsonl'], hostId: 'local' });
    assert.match(document.querySelector('[role=alert]').textContent, /failed: locked/);
    assert.equal(document.querySelectorAll('.archive-row').length, 2);
  });

  test('storage refresh errors are visible and an all-readable bulk deletion uses the full count', async () => {
    responses.set('storage_report', new Error('scan failed')); await render(StorageSettings);
    assert.equal(document.querySelector('[role=alert]').textContent, 'scan failed');
    responses.set('storage_report', { hosts: [host({ archives: [archive('one'), archive('two')] })] }); await click(button('Refresh'));
    await click(button('Delete all')); assert.match(document.querySelector('dialog').textContent, /2 archived conversations on Local/);
    await click(button('Cancel'));
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(calls.filter(call => call.command === 'delete_archived_conversations').length, 0);
  });

  test('prompt context percentages sum to 100 and each section exposes its source details', async () => {
    const context = { tokens: { system: 1, instructions: 1, tools: 1, skills: 0 }, systemPrompt: 'System content', instructions: [{ path: '/AGENTS.md', content: 'Instructions content' }], tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }], skills: [{ name: 'skill', description: 'Skill description', filePath: '/SKILL.md' }] };
    const view = await render(PromptContextBar, { context, inputTokens: 3 });
    assert.deepEqual([...document.querySelectorAll('button small')].map(node => node.textContent), ['34%', '33%', '33%', '0%']);

    for (const [section, content] of [['system', 'System content'], ['instructions', '/AGENTS.md'], ['tools', 'Read file'], ['skills', '/SKILL.md']]) {
      const control = document.querySelector(`button.${section}`); await click(control); assert.equal(control.getAttribute('aria-expanded'), 'true'); assert.match(document.querySelector('.prompt-context-content').textContent, new RegExp(content));
      await click(control); assert.equal(document.querySelector('.prompt-context-content'), null);
    }

    await view.rerender({ inputTokens: 0, context: { tokens: { system: 0, instructions: 0, tools: 0, skills: 0 }, systemPrompt: '', instructions: [], tools: [], skills: [] } });
    assert.ok([...document.querySelectorAll('button small')].every(node => node.textContent === '0%'));

    for (const [section, text] of [['system', 'No system prompt'], ['instructions', 'No project instructions'], ['tools', 'No active tools'], ['skills', 'Defined 0%Invoked 0%Tax 0%No defined skills']]) { await click(document.querySelector(`button.${section}`)); assert.equal(document.querySelector('.prompt-context-content').textContent, text); }
  });
});
