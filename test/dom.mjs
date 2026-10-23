import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createComponent, createComputed, createEffect, createRoot, createSignal, mergeProps } from 'solid-js';
import { clearDelegatedEvents, render } from 'solid-js/web';
import { mockIPC, clearMocks } from './mock-ipc.mjs';

export async function act(action) { await action(); await new Promise(resolve => setImmediate(resolve)); }

/** Retries an assertion. Only for state without a change signal, such as values stored in IndexedDB. */
export async function retryUntil(check, timeout = 2000) {
  const deadline = Date.now() + timeout;

  for (;;) {
    try { return await check(); }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Resolves with the first truthy result of `read()`, a reactive Solid expression re-run on each change. */
export function whenReactive(read, timeout = 2000) {
  return new Promise((resolve, reject) => createRoot(stop => {
    let latest;
    const timer = setTimeout(() => { stop(); reject(new Error(`Reactive value never satisfied: ${read}; last ${JSON.stringify(latest)}`)); }, timeout);
    createEffect(() => { latest = read(); if (!latest) return; clearTimeout(timer); queueMicrotask(stop); resolve(latest); });
  }));
}

/** Resolves with the first truthy result of `check()`, re-checked on every DOM mutation. */
export function untilDom(check, timeout = 2000) {
  const first = check();

  if (first) return Promise.resolve(first);

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => { const value = check(); if (!value) return; observer.disconnect(); clearTimeout(timer); resolve(value); });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM never satisfied: ${check}`)); }, timeout);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

/** Resolves when `element` has attribute `name` equal to `value`, observed through DOM mutations. */
export function attributeBecomes(element, name, value, timeout = 2000) {
  if (element.getAttribute(name) === value) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => { if (element.getAttribute(name) !== value) return; observer.disconnect(); clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`${name} stayed ${element.getAttribute(name)}, expected ${value}`)); }, timeout);
    observer.observe(element, { attributes: true, attributeFilter: [name] });
  });
}

/** Captures console.error until `release()`, and resolves `reported(pattern)` when a matching error is logged. */
export function captureConsoleErrors() {
  const original = console.error; const lines = []; const waiters = new Set();
  console.error = (...args) => { const line = args.map(String).join(' '); lines.push(line); for (const waiter of [...waiters]) waiter(line); };

  return {
    lines,
    reported(pattern, timeout = 2000) {
      if (lines.some(line => pattern.test(line))) return Promise.resolve();

      return new Promise((resolve, reject) => {
        const waiter = line => { if (!pattern.test(line)) return; waiters.delete(waiter); clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`No console error matched ${pattern}; got ${JSON.stringify(lines)}`)); }, timeout);
        waiters.add(waiter);
      });
    },
    release() { console.error = original; },
  };
}

const sharedDom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
const browserGlobals = ['window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLHeadElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'NodeFilter', 'MutationObserver', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent'];

// The UI always runs in a browser, so modules may read browser globals while they load.
for (const key of browserGlobals) if (!(key in globalThis) || key === 'navigator') Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: sharedDom.window[key] });
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: new IDBFactory() });
Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, writable: true, value: IDBKeyRange });

const channels = new Set();
const channelWaiters = new Set();

const openChannels = name => [...channels].filter(channel => channel.name === name).length;

/** Resolves once every open BroadcastChannel called `name` has been closed by its owner. */
export function channelsClosed(name, timeout = 2000) {
  if (!openChannels(name)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const waiter = () => { if (openChannels(name)) return; channelWaiters.delete(waiter); clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { channelWaiters.delete(waiter); reject(new Error(`${openChannels(name)} "${name}" BroadcastChannel(s) were never closed`)); }, timeout);
    channelWaiters.add(waiter);
  });
}

class BrowserBroadcastChannel {
  #listeners = new Set();
  #closed = false;
  onmessage = null;
  constructor(name) { this.name = String(name); channels.add(this); }
  postMessage(data) {
    if (this.#closed) throw new sharedDom.window.DOMException('BroadcastChannel is closed', 'InvalidStateError');
    const message = structuredClone(data);

    for (const channel of channels) if (channel !== this && channel.name === this.name) setTimeout(() => channel.#deliver(message));
  }
  #deliver(data) {
    if (this.#closed) return;
    const event = new sharedDom.window.MessageEvent('message', { data: structuredClone(data) });
    this.onmessage?.(event);

    for (const listener of [...this.#listeners]) listener(event);
  }
  addEventListener(type, listener) { if (type === 'message') this.#listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.#listeners.delete(listener); }
  close() {
    this.#closed = true; channels.delete(this);

    for (const waiter of [...channelWaiters]) waiter();
  }
}

Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: BrowserBroadcastChannel });

// jsdom lacks CSS.escape; this follows the CSSOM "serialize an identifier" algorithm.
function cssEscape(value) {
  const string = String(value); let result = '';

  for (let index = 0; index < string.length; index++) {
    const code = string.charCodeAt(index);

    if (code === 0) result += '\uFFFD';
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (index === 0 && code >= 0x30 && code <= 0x39) || (index === 1 && code >= 0x30 && code <= 0x39 && string.charCodeAt(0) === 0x2d)) result += `\\${code.toString(16)} `;
    else if (index === 0 && string.length === 1 && code === 0x2d) result += `\\${string[index]}`;
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) result += string[index];
    else result += `\\${string[index]}`;
  }

  return result;
}

sharedDom.window.CSS ??= {};
sharedDom.window.CSS.escape ??= cssEscape;
Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: sharedDom.window.CSS });

// jsdom computes no layout, so size changes are reported only when a test calls notifyResize(element).
const resizeObservers = new Set();

class BrowserResizeObserver {
  #callback; #targets = new Set();
  constructor(callback) { this.#callback = callback; }
  observe(target) { this.#targets.add(target); resizeObservers.add(this); }
  unobserve(target) { this.#targets.delete(target); if (!this.#targets.size) resizeObservers.delete(this); }
  disconnect() { this.#targets.clear(); resizeObservers.delete(this); }
  notify(target) { if (this.#targets.has(target)) this.#callback([{ target, contentRect: target.getBoundingClientRect() }], this); }
}

export function notifyResize(element) { for (const observer of [...resizeObservers]) observer.notify(element); }

sharedDom.window.ResizeObserver = BrowserResizeObserver;
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: BrowserResizeObserver });

// jsdom has no media queries. Width queries follow window.innerWidth and report changes on resize.
function mediaMatches(query) {
  const conditions = [...query.matchAll(/\((min|max)-width:\s*(\d+(?:\.\d+)?)px\)/g)];

  if (!conditions.length) throw new Error(`Unsupported media query in tests: ${query}`);

  return conditions.every(([, kind, size]) => kind === 'max' ? sharedDom.window.innerWidth <= Number(size) : sharedDom.window.innerWidth >= Number(size));
}

sharedDom.window.matchMedia = query => {
  const listeners = new Set();
  const list = {
    media: query, matches: mediaMatches(query), onchange: null,
    addEventListener(type, listener) { if (type === 'change') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'change') listeners.delete(listener); },
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
  };
  sharedDom.window.addEventListener('resize', () => {
    const matches = mediaMatches(query);

    if (matches === list.matches) return;
    list.matches = matches;
    const event = Object.assign(new sharedDom.window.Event('change'), { matches, media: query });
    list.onchange?.(event);

    for (const listener of [...listeners]) listener(event);
  });

  return list;
};

export function installDom() {
  const dom = sharedDom;
  const listeners = [];

  const targets = [dom.window, dom.window.document].map(target => {
    const add = target.addEventListener;
    target.addEventListener = function (...args) { listeners.push([target, ...args]);

    return add.apply(this, args); };

    return [target, add];
  });

  const values = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator, indexedDB: new IDBFactory() };

  for (const key of ['HTMLElement', 'HTMLHeadElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'NodeFilter', 'MutationObserver', 'KeyboardEvent', 'MouseEvent', 'Event', 'AbortController', 'AbortSignal']) values[key] = dom.window[key];
  values.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  values.CustomEvent = dom.window.CustomEvent;
  const frames = new Map(); let frame = 0;
  const pointerCaptures = new Map();
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) { pointerCaptures.set(id, this); };

  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) { return pointerCaptures.get(id) === this; };

  dom.window.HTMLElement.prototype.releasePointerCapture = function (id) { if (pointerCaptures.get(id) === this) pointerCaptures.delete(id); };

  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };

  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };

  values.requestAnimationFrame = callback => { frames.set(++frame, callback);

  return frame; };

  values.cancelAnimationFrame = id => frames.delete(id);
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mockIPC(() => undefined, { shouldMockEvents: true });

  return {
    frames,
    async flushFrames() { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); }); },
    restore() {
      clearMocks();
      clearDelegatedEvents(dom.window.document);

      for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener, options);

      for (const [target, add] of targets) target.addEventListener = add;
      pointerCaptures.clear();
      dom.window.document.body.replaceChildren();
      dom.window.document.body.removeAttribute('style');
      delete dom.window.document.documentElement.dataset.testPalette;
      dom.window.getSelection()?.removeAllRanges();
      dom.window.localStorage.clear();
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
      Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: 768 });

      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}

export async function renderHook(hook, initialProps) {
  const [props, setProps] = createSignal(initialProps);
  let value, dispose;
  await act(() => createRoot(stop => { dispose = stop; value = hook(props); createComputed(() => Object.values(value ?? {})); }));

  return { get current() { return value; }, async rerender(next) { await act(() => setProps(() => next)); }, async unmount() { await act(dispose); } };
}

export async function renderComponent(Component, props = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const [current, setCurrent] = createSignal(props);
  const liveProps = mergeProps(() => current());
  let dispose;
  await act(() => { dispose = render(() => createComponent(Component, liveProps), container); });
  const rerender = async next => { await act(() => setCurrent(() => next)); };

  return { container, rerender, async unmount() { await act(dispose); container.remove(); } };
}

export async function enterText(input, value) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
