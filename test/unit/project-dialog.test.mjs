import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { ProjectDialog } from '../../src/components/ProjectDialog.tsx';

describe('project directory palette', () => {
  let dom, view, props, opened, requested, cancelled;
  beforeEach(() => {
    dom = installDom(); opened = []; requested = []; cancelled = 0;
    HTMLElement.prototype.scrollIntoView = function () {};
    props = { initialPath: '', initialHostId: 'local', hosts: [{ id: 'remote', name: 'Remote' }], onHomeDirectory: async host => host === 'remote' ? '/remote' : '/home/me', onChooseDirectory: async (path, host) => { requested.push([path, host]); return { path, parent: '/home', directories: [`${path}alpha`, `${path}beta`, `${path}zalpha`] }; }, onOpen: async (...args) => opened.push(args), onCancel: () => cancelled++ };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; await dom.flushFrames(); dom.restore(); });
  const mount = async () => { view = await renderComponent(ProjectDialog, props); };
  const advance = async t => act(async () => t.mock.timers.tick(150));
  const input = () => document.querySelector('input');
  const key = async (key, extra = {}) => act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })));
  const options = () => [...document.querySelectorAll('[role=option]')];

  test('home-relative filtering ranks prefixes first and Enter opens the selected folder', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount();
    assert.equal(input().value, ''); assert.equal(input().getAttribute('aria-label'), 'Folder path relative to home');
    assert.match(document.body.textContent, /Finding folders/); await advance(t);
    assert.deepEqual(requested, [['/home/me/', 'local']]); assert.equal(options().length, 3);
    await enterText(input(), 'ALP'); assert.deepEqual(options().map(node => node.textContent), ['alpha', 'zalpha']);
    await key('ArrowDown'); assert.equal(options()[1].getAttribute('aria-selected'), 'true');
    await key('Enter'); assert.deepEqual(opened, [['/home/me/zalpha', 'local']]);
  });

  test('Tab completes a folder, parent navigation and undo/redo restore earlier queries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount(); await advance(t);
    await enterText(input(), 'al'); await key('Tab'); assert.equal(input().value, 'alpha/'); await advance(t);
    assert.equal(requested.at(-1)[0], '/home/me/alpha/');
    await key('Backspace', { altKey: true }); assert.equal(input().value, '/home/'); await advance(t);
    await key('z', { ctrlKey: true }); assert.equal(input().value, 'alpha/'); await advance(t);
    await key('y', { ctrlKey: true }); assert.equal(input().value, '/home/'); await advance(t);
    assert.equal(document.activeElement, input());
  });

  test('the current folder opens with Ctrl+Enter and duplicate open requests are suppressed', async t => {
    const pending = Promise.withResolvers(); props.onOpen = (...args) => { opened.push(args); return pending.promise; };
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount(); await advance(t);
    await key('Enter', { ctrlKey: true }); await key('Enter', { ctrlKey: true });
    assert.deepEqual(opened, [['/home/me/', 'local']]); assert.equal(input().readOnly, true);
    await act(async () => document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }))); assert.equal(cancelled, 0);
    await act(async () => pending.reject(new Error('cannot open'))); assert.equal(input().readOnly, false); assert.equal(document.querySelector('[role=alert]').textContent, 'cannot open');
    await act(async () => document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }))); assert.equal(cancelled, 1);
  });

  test('stale directory responses cannot replace the newly selected host', async t => {
    const pending = Promise.withResolvers(); props.onChooseDirectory = async (path, host) => host === 'local' ? pending.promise : { path, parent: '/', directories: ['/remote/new'] };
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount(); await advance(t);
    await act(async () => { const select = document.querySelector('select'); select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await advance(t);
    assert.deepEqual(options().map(node => node.textContent), ['new']);
    await act(async () => pending.resolve({ path: '/old', directories: ['/old/stale'] })); assert.deepEqual(options().map(node => node.textContent), ['new']);
    await key('Enter', { ctrlKey: true }); assert.deepEqual(opened, [['/remote/', 'remote']]);
  });

  test('home and listing failures explain the problem and do not enable opening', async t => {
    props.onHomeDirectory = async () => { throw new Error('home unavailable'); };
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount();
    assert.equal(document.querySelector('[role=alert]').textContent, 'home unavailable');
    assert.equal(document.querySelector('.directory-palette-open').disabled, true);
    await view.unmount(); view = undefined;
    props.onHomeDirectory = async () => '/home/me'; props.onChooseDirectory = async () => null;
    await mount(); await advance(t); assert.match(document.querySelector('[role=alert]').textContent, /Could not list this folder/);
    props.onChooseDirectory = async () => { throw 'listing failed'; }; await view.rerender(props);
    await enterText(input(), '/different/'); await advance(t); assert.equal(document.querySelector('[role=alert]').textContent, 'Could not list this folder. Try another path.');
  });

  test('Windows home paths expand separators and folders outside home open without suggestions', async t => {
    props.initialPath = '~/project'; props.onHomeDirectory = async () => 'C:\\Users\\Me'; props.onChooseDirectory = async path => { requested.push(path); return { path, directories: [] }; };
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount(); await advance(t);
    assert.equal(requested[0], 'C:\\Users\\Me\\project\\');
    assert.match(document.body.textContent, /No child folders/);
    await view.unmount(); view = undefined;
    props.initialPath = 'D:\\repo\\'; await mount(); await advance(t); await key('Enter');
    assert.deepEqual(opened, [['D:\\repo\\', 'local']]);
  });

  test('mouse selection browses folders and keyboard navigation wraps around the result list', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await mount(); await advance(t);
    await key('ArrowUp'); assert.equal(options().at(-1).getAttribute('aria-selected'), 'true');
    await key('ArrowDown'); assert.equal(options()[0].getAttribute('aria-selected'), 'true');
    await act(async () => options()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    assert.equal(options()[1].getAttribute('aria-selected'), 'true');
    await act(async () => options()[1].click()); assert.equal(input().value, 'beta/'); await advance(t);
    await act(async () => document.querySelector('.directory-palette-open').click()); assert.deepEqual(opened, [['/home/me/beta/', 'local']]);
    const dialog = document.querySelector('dialog'); dialog.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 });
    await act(async () => dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50 }))); assert.equal(cancelled, 0);
    await act(async () => dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 50 }))); assert.equal(cancelled, 1);
  });
});
