import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { HooksSettings } from '../../src/components/HooksSettings.tsx';
import { StorageSettings } from '../../src/components/StorageSettings.tsx';
import { PromptContextBar } from '../../src/components/PromptContextBar.tsx';

describe('settings panels', () => {
  let dom, views, calls, responses;
  beforeEach(() => {
    dom = installDom(); views = []; calls = []; responses = new Map();
    mockIPC(async (command, args) => { calls.push({ command, args }); const value = responses.get(command); if (value instanceof Error) throw value; return typeof value === 'function' ? value(args) : value; });
  });
  afterEach(async () => { for (const view of views) await view.unmount(); clearMocks(); dom.restore(); });
  async function render(Component, props) { const view = await renderComponent(Component, props); views.push(view); return view; }
  const button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
  const click = async element => act(async () => element.click());
  const select = async (element, value) => act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
  const listing = { directory: '/hooks', exists: true, hooks: [{ name: 'alpha', entry: 'alpha.ts', path: '/hooks/alpha.ts' }, { name: 'beta', entry: 'package/index.js', path: '/hooks/package/index.js' }] };
  const archive = (name, extra = {}) => ({ name, path: `/${name}.jsonl`, cwd: '/repo', byteSize: 42, modifiedAt: 100, deletable: true, ...extra });
  const host = (extra = {}) => ({ hostId: 'local', hostName: 'Local', categories: [], archives: [], warnings: [], ...extra });

  test('hook filtering matches paths case-insensitively and opening a folder reports failures', async () => {
    responses.set('list_hooks', listing); responses.set('open_project_directory', new Error('open failed'));
    await render(HooksSettings, { hosts: [] });
    assert.equal(document.querySelectorAll('.config-row').length, 2);
    await enterText(document.querySelector('input'), ' PACKAGE '); assert.equal(document.querySelectorAll('.config-row').length, 1); assert.match(document.querySelector('.config-row').textContent, /beta/);
    await enterText(document.querySelector('input'), 'missing'); assert.match(document.body.textContent, /No hooks match/);
    await click(button('Open folder')); assert.match(document.querySelector('[role=alert]').textContent, /open failed/);
    assert.deepEqual(calls.at(-1), { command: 'open_project_directory', args: { cwd: '/hooks', hostId: 'local' } });
    responses.set('list_hooks', { directory: '/hooks', exists: false, hooks: [] });
    await click(button('Refresh')); assert.match(document.body.textContent, /No hooks found/); assert.equal(button('Open folder').disabled, true);
  });

  test('switching hook hosts rejects stale load results and hides local-only folder actions', async () => {
    const old = Promise.withResolvers(); responses.set('list_hooks', args => args.hostId === 'local' ? old.promise : { ...listing, directory: '/remote/hooks', hooks: [] });
    await render(HooksSettings, { hosts: [{ id: 'remote', name: 'Remote' }] });
    assert.match(document.querySelector('[role=status]').textContent, /Loading hooks/);
    await select(document.querySelector('select'), 'remote'); assert.equal(button('Open folder'), undefined);
    await act(async () => old.resolve(listing)); assert.equal(document.querySelector('.hooks-directory').textContent, '/remote/hooks');
    responses.set('list_hooks', new Error('remote offline')); await click(button('Refresh'));
    assert.match(document.querySelector('[role=alert]').textContent, /remote offline/);
  });

  test('late folder-open failures cannot replace the newly selected host state', async () => {
    const pending = Promise.withResolvers(); responses.set('list_hooks', listing); responses.set('open_project_directory', () => pending.promise);
    await render(HooksSettings, { hosts: [{ id: 'remote', name: 'Remote' }] }); await click(button('Open folder'));
    assert.equal(button('Open folder').disabled, true);
    await select(document.querySelector('select'), 'remote');
    await act(async () => pending.reject(new Error('old failure')));
    assert.equal(document.querySelector('[role=alert]'), null);
  });

  test('storage scan renders per-host categories, approximate totals, warnings and inaccessible hosts', async () => {
    const pending = Promise.withResolvers(); responses.set('storage_report', () => pending.promise);
    await render(StorageSettings); assert.match(document.querySelector('[role=status]').textContent, /Scanning storage/);
    const categories = [{ id: 'active-conversations', byteSize: 500, itemCount: 1 }, { id: 'archived-conversations', byteSize: 2048, itemCount: 2 }, { id: 'project-checkpoints', byteSize: 1024 ** 2, itemCount: 1, estimated: true }, { id: 'git-diff-snapshots', byteSize: 12 * 1024 ** 3, itemCount: 3 }, { id: 'temporary-chats', byteSize: 1024 ** 4, itemCount: 1 }];
    await act(async () => pending.resolve({ hosts: [host({ categories, warnings: ['Repository missing'] }), host({ hostId: 'remote', hostName: 'Remote', error: 'offline' })] }));
    const text = document.body.textContent;
    for (const expected of ['About ', '500 B', '2.00 KiB', '1.00 MiB', '12.0 GiB', '1.00 TiB', '1 conversation', '2 conversations', '1 checkpoint location', 'Storage unavailable', 'offline']) assert.ok(text.includes(expected), expected);
    assert.equal(document.querySelector('.storage-warning').title, 'Repository missing');
    assert.equal(button('Refresh').disabled, false);
  });

  test('single archive deletion requires confirmation and refreshes the host report', async () => {
    const item = archive('Old chat'); responses.set('storage_report', { hosts: [host({ archives: [item] })] });
    const confirmations = []; window.confirm = text => { confirmations.push(text); return false; };
    await render(StorageSettings);
    const remove = document.querySelector('[aria-label="Permanently delete Old chat"]'); await click(remove);
    assert.equal(calls.filter(call => call.command === 'delete_archived_session').length, 0);
    const pending = Promise.withResolvers(); responses.set('delete_archived_session', () => pending.promise); window.confirm = () => true;
    await click(remove); assert.equal(remove.disabled, true); assert.equal(button('Refresh').disabled, true);
    assert.deepEqual(calls.at(-1), { command: 'delete_archived_session', args: { sessionPath: '/Old chat.jsonl', hostId: 'local' } });
    responses.set('storage_report', { hosts: [host()] }); await act(async () => pending.resolve());
    assert.equal(document.querySelector('.archive-row'), null); assert.equal(button('Refresh').disabled, false);
    assert.match(confirmations[0], /diff history and project checkpoint refs/);
  });

  test('bulk archive deletion skips unsafe archives, continues after failures and names each failed item', async () => {
    const items = [archive('good'), archive('failed'), archive('unsafe', { deletable: false, deleteError: 'invalid data' })];
    responses.set('storage_report', { hosts: [host({ archives: items })] });
    responses.set('delete_archived_session', args => { if (args.sessionPath === '/failed.jsonl') throw new Error('locked'); });
    const confirmations = []; window.confirm = text => { confirmations.push(text); return true; };
    await render(StorageSettings);
    assert.equal(document.querySelector('[aria-label^="Cannot safely delete"]').disabled, true);
    responses.set('storage_report', { hosts: [host({ archives: items.slice(1) })] });
    await click(button('Delete available'));
    assert.deepEqual(calls.filter(call => call.command === 'delete_archived_session').map(call => call.args.sessionPath), ['/good.jsonl', '/failed.jsonl']);
    assert.match(document.querySelector('[role=alert]').textContent, /failed: locked/);
    assert.match(confirmations[0], /2 safely readable/);
    assert.equal(document.querySelectorAll('.archive-row').length, 2);
  });

  test('storage refresh errors are visible and an all-readable bulk deletion uses the full count', async () => {
    responses.set('storage_report', new Error('scan failed')); await render(StorageSettings);
    assert.equal(document.querySelector('[role=alert]').textContent, 'scan failed');
    responses.set('storage_report', { hosts: [host({ archives: [archive('one'), archive('two')] })] }); await click(button('Refresh'));
    let prompt; window.confirm = text => { prompt = text; return false; };
    await click(button('Delete all')); assert.match(prompt, /all 2 archived conversations on Local/);
    assert.equal(calls.filter(call => call.command === 'delete_archived_session').length, 0);
  });

  test('prompt context percentages sum to 100 and each section exposes its source details', async () => {
    const context = { tokens: { system: 1, instructions: 1, tools: 1, skills: 0 }, systemPrompt: 'System content', instructions: [{ path: '/AGENTS.md', content: 'Instructions content' }], tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }], skills: [{ name: 'skill', description: 'Skill description', filePath: '/SKILL.md' }] };
    const view = await render(PromptContextBar, { context });
    assert.deepEqual([...document.querySelectorAll('button small')].map(node => node.textContent), ['34%', '33%', '33%', '0%']);
    for (const [section, content] of [['system', 'System content'], ['instructions', '/AGENTS.md'], ['tools', 'Read file'], ['skills', '/SKILL.md']]) {
      const control = document.querySelector(`button.${section}`); await click(control); assert.equal(control.getAttribute('aria-expanded'), 'true'); assert.match(document.querySelector('.prompt-context-content').textContent, new RegExp(content));
      await click(control); assert.equal(document.querySelector('.prompt-context-content'), null);
    }
    await view.rerender({ context: { tokens: { system: 0, instructions: 0, tools: 0, skills: 0 }, systemPrompt: '', instructions: [], tools: [], skills: [] } });
    assert.ok([...document.querySelectorAll('button small')].every(node => node.textContent === '0%'));
    for (const [section, text] of [['system', 'No system prompt'], ['instructions', 'No project instructions'], ['tools', 'No active tools'], ['skills', 'No model-invoked skills']]) { await click(document.querySelector(`button.${section}`)); assert.equal(document.querySelector('.prompt-context-content').textContent, text); }
  });
});
