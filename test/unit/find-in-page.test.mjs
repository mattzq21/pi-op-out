import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, enterText, act } from '../dom.mjs';
import { FindInPage } from '../../clients/ui/components/FindInPage.tsx';

describe('in-page search', () => {
  let dom, view, root, launcher, props, observers;
  const bounds = { left: 0, right: 500, top: 0, bottom: 300, width: 500, height: 300 };
  beforeEach(() => {
    dom = installDom(); observers = [];
    globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
    HTMLElement.prototype.getBoundingClientRect = () => bounds;
    HTMLElement.prototype.getClientRects = () => [bounds];
    window.Range.prototype.getBoundingClientRect = () => ({ left: 10, right: 110, top: 20, bottom: 40, width: 100, height: 20 });
    window.Range.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };

    root = document.createElement('section'); root.id = 'chat'; root.className = 'chat-shell';
    root.innerHTML = '<div class="messages"><p>Alpha <em>beta</em> alpha</p><p>literal [a+b]</p><p hidden>alpha</p><p aria-hidden="true">alpha</p><p style="visibility:hidden">alpha</p><textarea>alpha</textarea><script>alpha</script><p>separate</p><p>blocks</p></div>';
    document.body.append(root); launcher = document.createElement('button'); root.append(launcher); launcher.focus();
    props = { selector: '#chat', scopeKey: 'one' };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; delete globalThis.ResizeObserver; dom.restore(); });
  const render = async () => { view = await renderComponent(FindInPage, props); };

  const press = async (key, extra = {}, target = document.activeElement) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    await act(async () => target.dispatchEvent(event));

    return event;
  };

  const open = async () => { await press('f', { ctrlKey: true }); await dom.flushFrames(); };

  const input = () => document.querySelector('.find-bar input');
  const count = () => document.querySelector('.find-count').textContent;
  const click = async label => act(async () => document.querySelector(`[aria-label="${label}"]`).click());

  test('search matches visible text across inline markup, escapes regex syntax and does not cross blocks', async () => {
    await render(); assert.equal(input(), null); await open(); assert.equal(document.activeElement, input());
    await enterText(input(), 'alpha'); assert.equal(count(), '1 / 2'); assert.equal(document.querySelectorAll('.find-highlights span').length, 2);
    await enterText(input(), 'alpha beta'); assert.equal(count(), '1 / 1');
    await enterText(input(), '[a+b]'); assert.equal(count(), '1 / 1');
    await enterText(input(), 'separate blocks'); assert.equal(count(), 'No matches');
    assert.equal(document.querySelector('[aria-label="Next match"]').disabled, true);
    await enterText(input(), ''); assert.equal(count(), '');
  });

  test('Enter, F3 and buttons cycle matches in both directions while IME Enter is ignored', async () => {
    await render(); await open(); await enterText(input(), 'alpha');
    await press('Enter'); assert.equal(count(), '2 / 2');
    await press('Enter'); assert.equal(count(), '1 / 2');
    await press('Enter', { shiftKey: true }); assert.equal(count(), '2 / 2');
    await press('Enter', { isComposing: true }); assert.equal(count(), '2 / 2');
    await press('F3'); assert.equal(count(), '1 / 2');
    await press('F3', { shiftKey: true }); assert.equal(count(), '2 / 2');
    await click('Next match'); assert.equal(count(), '1 / 2'); await click('Previous match'); assert.equal(count(), '2 / 2');
    assert.equal(document.querySelectorAll('.find-highlights .active').length, 1);
    await press('Escape'); assert.equal(input(), null); assert.equal(document.activeElement, launcher);
  });

  test('search shortcuts respect modal dialogs, keybinding capture and other chat scopes', async () => {
    await render();
    const dialog = document.createElement('dialog'); dialog.open = true; document.body.append(dialog);
    assert.equal((await press('f', { ctrlKey: true })).defaultPrevented, false); assert.equal(input(), null); dialog.remove();
    launcher.className = 'keybind-input'; await open(); assert.equal(input(), null); launcher.className = '';
    await press('f', { ctrlKey: true, isComposing: true }); await press('f', { ctrlKey: true, altKey: true }); await press('f', { ctrlKey: true, shiftKey: true }); assert.equal(input(), null);
    const other = document.createElement('section'); other.className = 'chat-shell'; const button = document.createElement('button'); other.append(button); document.body.append(other); button.focus();
    await open(); assert.equal(input(), null);
    launcher.focus(); await open(); assert.ok(input());
  });

  test('disabled and inactive searches do not claim global shortcuts and closing restores focus', async () => {
    props.enabled = false; await render(); await open(); assert.equal(input(), null);
    await view.rerender({ ...props, enabled: true, active: false }); launcher.blur(); await open(); assert.equal(input(), null);
    launcher.focus(); await open(); assert.ok(input());
    await click('Close find'); assert.equal(input(), null); assert.equal(document.activeElement, launcher);
    await view.rerender({ ...props, enabled: true }); await open(); await enterText(input(), 'alpha');
    await view.rerender({ ...props, enabled: false }); assert.equal(document.querySelector('.find-highlights'), null);
  });

  test('search matches query whitespace across normal and preformatted text', async () => {
    root.querySelector('.messages').innerHTML = '<p>one \n\t <em> two</em>  three</p><pre style="white-space:pre">one  two</pre>';
    await render(); await open(); await enterText(input(), 'one two three'); assert.equal(count(), '1 / 1');
    await enterText(input(), 'one  two'); assert.equal(count(), '1 / 2');
    await enterText(input(), 'one two'); assert.equal(count(), '1 / 2');
  });

  test('live DOM changes rescan matches and retain the current match when its text node survives', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); await render(); await open(); await enterText(input(), 'alpha');
    await press('Enter'); assert.equal(count(), '2 / 2');
    await act(async () => { const paragraph = document.createElement('p'); paragraph.textContent = 'alpha'; root.querySelector('.messages').prepend(paragraph); });
    await act(async () => t.mock.timers.tick(100)); assert.equal(count(), '3 / 3');
    await act(async () => { root.querySelector('.messages').innerHTML = '<p>gone</p>'; });
    await act(async () => t.mock.timers.tick(100)); assert.equal(count(), 'No matches');
  });

  test('scrollable containers reveal offscreen results and clip highlight boxes below the composer', async () => {
    const messages = root.querySelector('.messages'); messages.style.overflowY = 'auto'; messages.style.overflowX = 'auto';
    const composer = document.createElement('div'); composer.className = 'composer-stack'; composer.getBoundingClientRect = () => ({ ...bounds, top: 100 }); root.append(composer);
    window.Range.prototype.getBoundingClientRect = () => ({ left: -10, right: 110, top: 90, bottom: 120, width: 120, height: 30 });
    await render(); await open(); await enterText(input(), 'alpha');
    assert.ok(messages.scrollTop > 0); assert.ok(messages.scrollLeft < 0);
    const highlight = document.querySelector('.find-highlights span'); assert.equal(highlight.style.height, '10px'); assert.equal(highlight.style.left, '0px');
    await act(async () => { window.dispatchEvent(new Event('resize')); document.dispatchEvent(new Event('scroll')); });
    assert.equal(dom.frames.size, 1); await dom.flushFrames();
    await click('Close find'); assert.ok(observers.every(observer => observer.disconnected));
  });
});
