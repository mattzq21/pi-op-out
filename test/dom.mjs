import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
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

// React detects browser event support when react-dom is first imported.
const bootstrap = installDom();
const { createRoot } = await import('react-dom/client');
bootstrap.restore();

export async function renderHook(hook, initialProps) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); let value;
  function Probe({ props }) { value = hook(props); return null; }
  const render = async props => { await act(async () => root.render(createElement(Probe, { props }))); };
  await render(initialProps);
  return { get current() { return value; }, rerender: render, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}

export { act };

export async function renderComponent(Component, props) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const rerender = async next => { await act(async () => root.render(createElement(Component, next))); };
  await rerender(props);
  return { container, rerender, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}

export async function enterText(input, value) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
