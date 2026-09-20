import { JSDOM } from 'jsdom';
import { createComponent, createRoot, createSignal } from 'solid-js';
import { render } from 'solid-js/web';

export async function act(action) { await action(); await Promise.resolve(); }

export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator };
  for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'KeyboardEvent', 'MouseEvent', 'Event']) values[key] = dom.window[key];
  values.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const frames = new Map(); let frame = 0;
  const pointerCaptures = new Map();
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) { pointerCaptures.set(id, this); };
  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) { return pointerCaptures.get(id) === this; };
  dom.window.HTMLElement.prototype.releasePointerCapture = function (id) { if (pointerCaptures.get(id) === this) pointerCaptures.delete(id); };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  values.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  values.cancelAnimationFrame = id => frames.delete(id);
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    frames,
    async flushFrames() { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); }); },
    restore() {
      pointerCaptures.clear();
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}

export async function renderHook(hook, initialProps) {
  const [props, setProps] = createSignal(initialProps);
  let value, dispose;
  await act(() => createRoot(stop => { dispose = stop; value = hook(props); }));
  return { get current() { return value; }, async rerender(next) { await act(() => setProps(() => next)); }, async unmount() { await act(dispose); } };
}

export async function renderComponent(Component, props) {
  const container = document.createElement('div'); document.body.append(container);
  const [current, setCurrent] = createSignal(props);
  const liveProps = new Proxy({}, { get: (_, key) => current()[key], has: (_, key) => key in current(), ownKeys: () => Reflect.ownKeys(current()), getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
  let dispose;
  await act(() => { dispose = render(() => createComponent(Component, liveProps), container); });
  const rerender = async next => { await act(() => setCurrent(() => next)); };
  return { container, rerender, async unmount() { await act(dispose); container.remove(); } };
}

export async function enterText(input, value) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
