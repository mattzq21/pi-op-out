import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startSession } from './webkit/webdriver.mjs';
import { startProxy, urlMatcher } from './webkit/proxy.mjs';
import { pageBridge, serialize, deserialize } from './webkit/bridge.mjs';
import { clockSource, playwrightInternals } from './webkit/sources.mjs';
import { keyValue, shortcutKeys } from './webkit/keys.mjs';

const { escapeForAttributeSelector, escapeForTextSelector } = playwrightInternals.iso;

export class TimeoutError extends Error { constructor(message) { super(message); this.name = 'TimeoutError'; } }

const injectedOptions = { isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0, testIdAttributeName: 'data-testid', stableRafCount: 1, browserName: 'webkit', shouldPrependErrorPrefix: true, isUtilityWorld: false, customEngines: [] };

const attributeSelector = (name, text, options) => 'internal:attr=[' + name + '=' + escapeForAttributeSelector(text, options?.exact || false) + ']';
const selectors = {
  role(role, options = {}) {
    const props = [];
    for (const name of ['checked', 'disabled', 'selected', 'expanded']) if (options[name] !== undefined) props.push([name, String(options[name])]);
    if (options.includeHidden !== undefined) props.push(['include-hidden', String(options.includeHidden)]);
    if (options.level !== undefined) props.push(['level', String(options.level)]);
    if (options.name !== undefined) props.push(['name', escapeForAttributeSelector(options.name, !!options.exact)]);
    if (options.description !== undefined) props.push(['description', escapeForAttributeSelector(options.description, !!options.exact)]);
    if (options.pressed !== undefined) props.push(['pressed', String(options.pressed)]);
    return 'internal:role=' + role + props.map(([name, value]) => '[' + name + '=' + value + ']').join('');
  },
  text: (text, options) => 'internal:text=' + escapeForTextSelector(text, !!options?.exact),
  label: (text, options) => 'internal:label=' + escapeForTextSelector(text, !!options?.exact),
  testId: id => 'internal:testid=[data-testid=' + escapeForAttributeSelector(id, true) + ']',
  placeholder: (text, options) => attributeSelector('placeholder', text, options),
  altText: (text, options) => attributeSelector('alt', text, options),
  title: (text, options) => attributeSelector('title', text, options),
};

function filterSuffix(options = {}) {
  let suffix = '';
  if (options.hasText !== undefined) suffix += ' >> internal:has-text=' + escapeForTextSelector(options.hasText, false);
  if (options.hasNotText !== undefined) suffix += ' >> internal:has-not-text=' + escapeForTextSelector(options.hasNotText, false);
  if (options.has) suffix += ' >> internal:has=' + JSON.stringify(options.has._selector);
  if (options.hasNot) suffix += ' >> internal:has-not=' + JSON.stringify(options.hasNot._selector);
  if (options.visible !== undefined) suffix += ' >> visible=' + (options.visible ? 'true' : 'false');
  return suffix;
}

function scriptSource(script, arg) {
  if (typeof script === 'function') return '(' + script.toString() + ')(' + (arg === undefined ? 'undefined' : JSON.stringify(arg)) + ');';
  if (typeof script === 'string') return script;
  if (script?.path) return readFileSync(script.path, 'utf8');
  if (script?.content !== undefined) return script.content;
  throw new Error('Unsupported init script');
}

const guarded = source => 'try { (0, eval)(' + JSON.stringify(source) + '); } catch (error) { setTimeout(() => { throw error; }); }';

const mobileScript = ({ hasTouch, isMobile }) => {
  if (hasTouch) {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
    if (!('ontouchstart' in window)) window.ontouchstart = null;
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const coarse = /\((any-)?pointer:\s*coarse\)/.test(query) || /\((any-)?hover:\s*none\)/.test(query);
      const fine = /\((any-)?pointer:\s*fine\)/.test(query) || /\((any-)?hover:\s*hover\)/.test(query);
      const result = original(query);
      return coarse || fine ? Object.assign(Object.create(result), { matches: coarse, media: query }) : result;
    };
  }
  if (isMobile) Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile Safari/605.1.15' });
};

function apiError(api, error) {
  if (error instanceof Error && error.message.startsWith(api + ':')) return error;
  const name = error?.name;
  const message = error?.message ?? String(error);
  const result = name === 'TimeoutError' ? new TimeoutError(api + ': ' + message) : new Error(api + ': ' + (name && name !== 'Error' && name !== 'WebDriverError' ? name + ': ' : '') + message);
  if (error?.stack && !(error instanceof Error)) result.stack = result.message + '\n' + String(error.stack).split('\n').slice(1).join('\n');
  return result;
}

class Deferred {
  constructor() { this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}

export async function launchWebKit() { return new WebKitBrowser(); }

class WebKitBrowser extends EventEmitter {
  constructor() { super(); this._contexts = new Set(); }
  async newContext(options = {}) {
    const context = new WebKitContext(this, options);
    await context._start();
    this._contexts.add(context);
    return context;
  }
  async newPage(options = {}) {
    const context = await this.newContext(options);
    const page = await context.newPage();
    page._ownsContext = true;
    return page;
  }
  contexts() { return [...this._contexts]; }
  isConnected() { return true; }
  browserType() { return { name: () => 'webkit' }; }
  version() { return 'WebKitGTK'; }
  async close() {
    await Promise.allSettled([...this._contexts].map(context => context.close()));
    this.emit('disconnected');
  }
}

let nextPageId = 0;
let nextEvaluationId = 0;

class WebKitContext extends EventEmitter {
  constructor(browser, options) {
    super();
    this._browser = browser;
    this._options = options;
    this._viewport = options.viewport === null ? null : options.viewport ?? { width: 1280, height: 720 };
    this._pages = [];
    this._initScripts = [];
    this._bindings = new Map();
    this._routes = [];
    this._webSocketRoutes = [];
    this._evaluations = new Map();
    this._timeout = 30000;
    this._closed = false;
    this.clock = new Clock(this);
    if (options.hasTouch || options.isMobile) this._initScripts.push(scriptSource(mobileScript, { hasTouch: !!options.hasTouch, isMobile: !!options.isMobile }));
  }

  async _start() {
    this._proxy = await startProxy({
      bridgeScript: pageId => this._bridgeScript(pageId),
      onBridge: (kind, body) => this._onBridge(kind, body),
      routes: () => [...this._pages.flatMap(page => page._routes), ...this._routes],
      webSocketRoutes: () => [...this._pages.flatMap(page => page._webSocketRoutes), ...this._webSocketRoutes],
    });
    try { this._session = await startSession({ proxy: this._proxy.url, scale: this._options.deviceScaleFactor ?? 1 }); }
    catch (error) { await this._proxy.close(); throw error; }
    this._spareWindow = this._session.initialWindow;
  }

  _bridgeConfig(pageId) {
    const open = this._pages.filter(page => !page._closed);
    return {
      pageId,
      pageScripts: Object.fromEntries(open.map(page => [page._id, page._initScripts.map(guarded)])),
      contextScripts: this._initScripts.map(guarded),
      exposed: [...new Set([...this._bindings.keys(), ...open.flatMap(page => [...page._bindings.keys()])])],
      injectedOptions,
    };
  }

  _bridgeScript(pageId) {
    return '(' + pageBridge + ')(' + JSON.stringify(this._bridgeConfig(pageId)) + ', ' + serialize + ', ' + deserialize + ');';
  }

  _pageFor({ pageId, docId }) {
    const open = this._pages.filter(page => !page._closed);
    return open.find(page => page._id === pageId) ?? open.find(page => page._docId === docId) ?? (open.length === 1 ? open[0] : undefined);
  }

  async _onBridge(kind, body) {
    const page = this._pageFor(body);
    if (kind === 'result') {
      const evaluation = this._evaluations.get(body.id);
      if (evaluation) { this._evaluations.delete(body.id); evaluation.resolve(body); }
      return {};
    }
    if (kind === 'event') {
      if (!page) return {};
      if (body.type === 'document') { page._docId = body.docId; page._url = body.url; }
      else if (body.type === 'url') page._url = body.url;
      else if (body.type === 'unload') {
        for (const [id, evaluation] of this._evaluations) {
          if (evaluation.docId !== body.docId) continue;
          this._evaluations.delete(id);
          evaluation.resolve({ ok: false, error: { name: '', message: 'Execution context was destroyed, most likely because of a navigation' } });
        }
      } else if (body.type === 'pageerror') {
        const error = Object.assign(new Error(body.error.message), { name: body.error.name || 'Error', stack: body.error.stack ?? body.error.message });
        page.emit('pageerror', error);
        this.emit('weberror', { page: () => page, error: () => error });
      } else if (body.type === 'console') {
        const message = new ConsoleMessage(page, body.level, body.text, body.args);
        page.emit('console', message);
        this.emit('console', message);
      }
      return {};
    }
    if (kind === 'call') {
      const binding = (page?._bindings.get(body.name)) ?? this._bindings.get(body.name);
      try {
        if (!binding) throw new Error('No exposed function ' + body.name);
        const value = await binding({ context: this, page, frame: page }, ...body.args.map(deserialize));
        return { ok: true, value: serialize(value) };
      } catch (error) {
        return { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack } };
      }
    }
    if (kind === 'dialog') {
      if (!page || (page.listenerCount('dialog') === 0 && this.listenerCount('dialog') === 0)) return { accept: false };
      const dialog = new Dialog(page, body);
      page.emit('dialog', dialog);
      this.emit('dialog', dialog);
      return dialog._answer.promise;
    }
    throw new Error('Unknown bridge request ' + kind);
  }

  _evaluation(docId) {
    const id = ++nextEvaluationId;
    const deferred = new Deferred();
    deferred.docId = docId;
    this._evaluations.set(id, deferred);
    return { id, deferred };
  }

  browser() { return this._browser; }
  pages() { return this._pages.filter(page => !page._closed); }
  setDefaultTimeout(timeout) { this._timeout = timeout; }
  setDefaultNavigationTimeout() {}

  async newPage() {
    if (this._closed) throw new Error('browserContext.newPage: Target page, context or browser has been closed');
    const window = this._spareWindow ?? await this._session.newWindow();
    this._spareWindow = undefined;
    const page = new WebKitPage(this, window);
    this._pages.push(page);
    await page._init();
    this.emit('page', page);
    return page;
  }

  async addInitScript(script, arg) { this._initScripts.push(scriptSource(script, arg)); }
  async exposeBinding(name, callback) {
    this._bindings.set(name, callback);
    await Promise.all(this.pages().map(page => page._installBinding(name)));
  }
  exposeFunction(name, callback) { return this.exposeBinding(name, (source, ...args) => callback(...args)); }
  async route(url, handler, options) { this._routes.unshift(new Route(url, handler, options)); }
  async unroute(url, handler) { this._routes = this._routes.filter(route => !(route.url === url && (!handler || route.handler === handler))); }
  async routeWebSocket(url, handler) { this._webSocketRoutes.unshift(new WebSocketRoute(url, handler)); }
  async grantPermissions() {}
  async clearPermissions() {}

  async addCookies(cookies) {
    for (const cookie of cookies) {
      const host = cookie.url ? new URL(cookie.url).hostname : cookie.domain;
      const page = this.pages().find(candidate => { try { return new URL(candidate.url()).hostname === host; } catch { return false; } });
      if (!page) throw new Error('browserContext.addCookies: no page of this context shows ' + host);
      const { name, value, path = '/', secure, httpOnly, expires, sameSite } = cookie;
      await page._command(command => command('POST', '/cookie', { cookie: { name, value, path, secure, httpOnly, sameSite, ...(expires > 0 ? { expiry: Math.round(expires) } : {}) } }));
    }
  }

  async cookies() {
    const all = new Map();
    for (const page of this.pages()) {
      if (!/^https?:/.test(page.url())) continue;
      for (const cookie of await page._command(command => command('GET', '/cookie'))) all.set(cookie.domain + cookie.path + cookie.name, { ...cookie, expires: cookie.expiry ?? -1 });
    }
    return [...all.values()];
  }

  async clearCookies() { for (const page of this.pages()) if (/^https?:/.test(page.url())) await page._command(command => command('DELETE', '/cookie')); }
  async newCDPSession(page) { return new EmulatedCDPSession(page); }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._activeDrag) await this._activeDrag.cancel().catch(() => {});
    for (const page of this._pages) if (!page._closed) { page._closed = true; page.emit('close', page); }
    for (const evaluation of this._evaluations.values()) evaluation.resolve({ ok: false, error: { name: '', message: 'Target page, context or browser has been closed' } });
    this._evaluations.clear();
    try { await this._session?.close(); } finally { await this._proxy?.close(); }
    this._browser._contexts.delete(this);
    this.emit('close', this);
  }
}

class ConsoleMessage {
  constructor(page, type, text, args) { this._page = page; this._type = type; this._text = text; this._args = args ?? []; }
  type() { return this._type; }
  text() { return this._text; }
  args() { return this._args.map(arg => ({ jsonValue: async () => deserialize(arg) })); }
  page() { return this._page; }
  location() { return { url: this._page.url(), lineNumber: 0, columnNumber: 0 }; }
}

class Dialog {
  constructor(page, { type, message, defaultValue }) { this._page = page; this._type = type; this._message = message; this._defaultValue = defaultValue ?? ''; this._answer = new Deferred(); }
  type() { return this._type; }
  message() { return this._message; }
  defaultValue() { return this._defaultValue; }
  page() { return this._page; }
  async accept(promptText) { this._answer.resolve({ accept: true, promptText }); }
  async dismiss() { this._answer.resolve({ accept: false }); }
}

class Route {
  constructor(url, handler, options = {}) { this.url = url; this.handler = handler; this.matches = urlMatcher(url); this._times = options.times; }
  async handle(request) {
    if (this._times !== undefined && this._times-- <= 0) return { type: 'fallback' };
    const outcome = new Deferred();
    const route = {
      request: () => ({ url: () => request.url, method: () => request.method, headers: () => request.headers, postData: () => request.postData.length ? request.postData.toString() : null, postDataBuffer: () => request.postData, resourceType: () => 'other' }),
      fulfill: async ({ status = 200, headers = {}, contentType, body = '', json, path } = {}) => {
        const content = json !== undefined ? JSON.stringify(json) : path ? readFileSync(path) : body;
        const all = { ...headers };
        if (contentType || json !== undefined) all['content-type'] = contentType ?? 'application/json';
        outcome.resolve({ type: 'fulfill', status, headers: all, body: Buffer.isBuffer(content) ? content : Buffer.from(String(content)) });
      },
      continue: async (overrides = {}) => outcome.resolve({ type: 'continue', url: overrides.url, headers: overrides.headers }),
      fallback: async () => outcome.resolve({ type: 'fallback' }),
      abort: async () => outcome.resolve({ type: 'abort' }),
    };
    Promise.resolve(this.handler(route, route.request())).catch(error => outcome.reject(error));
    return outcome.promise;
  }
}

class WebSocketRoute {
  constructor(url, handler) { this.url = url; this.matches = urlMatcher(url); this.handler = handler; }
  handle(socket, url) {
    const messageHandlers = [], closeHandlers = [];
    const pending = [];
    socket.on('message', (data, binary) => {
      const message = binary ? data : data.toString();
      if (messageHandlers.length) for (const handler of messageHandlers) handler(message);
      else pending.push(message);
    });
    socket.on('close', (code, reason) => { for (const handler of closeHandlers) handler(code, reason.toString()); });
    const route = {
      url: () => url,
      send: message => socket.send(message),
      close: ({ code, reason } = {}) => socket.close(code, reason),
      onMessage: handler => { messageHandlers.push(handler); for (const message of pending.splice(0)) handler(message); },
      onClose: handler => { closeHandlers.push(handler); },
      connectToServer: () => { throw new Error('routeWebSocket connectToServer is not supported on WebKit'); },
    };
    Promise.resolve(this.handler(route)).catch(error => socket.close(1011, String(error?.message ?? error)));
  }
}

class WebKitPage extends EventEmitter {
  constructor(context, window) {
    super();
    this._context = context;
    this._window = window;
    this._id = 'page-' + ++nextPageId;
    this._initScripts = [];
    this._bindings = new Map();
    this._routes = [];
    this._webSocketRoutes = [];
    this._url = 'about:blank';
    this._closed = false;
    this._timeout = undefined;
    this._viewport = context._viewport;
    this.keyboard = new Keyboard(this);
    this.mouse = new Mouse(this);
    this.touchscreen = new Touchscreen();
    this.clock = context.clock;
    this.request = undefined;
  }

  async _init() { if (this._viewport) await this.setViewportSize(this._viewport); }

  get _defaultTimeout() { return this._timeout ?? this._context._timeout; }

  _command(fn) {
    if (this._closed) return Promise.reject(new Error('Target page, context or browser has been closed'));
    return this._context._session.inWindow(this._window, fn);
  }

  _execute(script, args = []) { return this._command(command => command('POST', '/execute/sync', { script, args })); }

  async _xWindow() {
    if (this._xid) return this._xid;
    const input = await this._context._session.xInput();
    const marker = 'pw-window-' + this._id + '-' + Math.random().toString(36).slice(2);
    const previous = await this._execute('const previous = document.title; document.title = arguments[0]; return previous;', [marker]);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const window = await input.request({ action: 'find', title: marker });
        if (window) return this._xid = window;
        await delay(20);
      }
      throw new Error('The window of ' + this._id + ' is not on the X screen');
    } finally { await this._execute('document.title = arguments[0];', [previous]); }
  }

  async _xFocus() {
    const window = await this._xWindow();
    await (await this._context._session.xInput()).request({ action: 'focus', window });
    return window;
  }

  async _xOrigin() {
    const window = await this._xFocus();
    const input = await this._context._session.xInput();
    const [left, top] = await input.request({ action: 'origin', window });
    const rect = await this._command(command => command('GET', '/window/rect'));
    const key = [left, top, rect.width, rect.height].join();
    if (this._xOriginKey === key) return this._xOriginValue;
    const [width, height] = await this._execute('window.__pwMove = undefined; addEventListener("mousemove", event => { window.__pwMove = [event.clientX, event.clientY]; }, { capture: true, once: true }); return [innerWidth, innerHeight];');
    const x = left + Math.round(rect.width - width / 2), y = top + Math.round(rect.height - height / 2);
    await input.request({ action: 'move', x: left + 1, y: top + 1 });
    await input.request({ action: 'move', x, y });
    for (let attempt = 0; attempt < 100; attempt++) {
      const moved = await this._execute('return window.__pwMove;');
      if (moved) {
        this._xOriginKey = key;
        return this._xOriginValue = [x - moved[0], y - moved[1]];
      }
      await delay(10);
    }
    throw new Error('The page did not receive a real pointer move');
  }

  async _xPointer(x, y, steps) {
    const [left, top] = await this._xOrigin();
    const input = await this._context._session.xInput();
    const expected = steps.filter(step => step.button).length;
    await this._execute('const expected = arguments[0]; let seen = 0; window.__pwXSeen = new Promise(resolve => { const count = event => { if (event.isTrusted && ++seen === expected) { removeEventListener("mousedown", count, true); removeEventListener("mouseup", count, true); resolve(); } }; addEventListener("mousedown", count, true); addEventListener("mouseup", count, true); });', [expected]);
    await input.request({ action: 'move', x: Math.round(left + x), y: Math.round(top + y) });
    for (const step of steps) {
      if (step.pause) await delay(step.pause);
      else await input.request({ action: 'button', button: step.button, down: step.down });
    }
    const seen = this._evaluate('mouse', () => window.__pwXSeen, []);
    if (!await Promise.race([seen.then(() => true), delay(5000).then(() => false)])) throw new Error('mouse: the page did not receive the X pointer buttons');
  }

  async _xExpect(types, action) {
    await this._execute('const types = arguments[0]; window.__pwXEvent = new Promise(resolve => { const seen = event => { if (!event.isTrusted) return; for (const type of types) removeEventListener(type, seen, true); resolve(event.type); }; for (const type of types) addEventListener(type, seen, true); });', [types]);
    await action();
    const seen = this._evaluate('drag', () => window.__pwXEvent, []);
    const type = await Promise.race([seen, delay(5000).then(() => null)]);
    if (!type) throw new Error('drag: the page did not receive ' + types.join(' or '));
    return type;
  }

  async _fileDrag(type, x, y, data = {}) {
    const files = type === 'dragEnter' ? (data.files ?? []).map(path => ({ name: path.split('/').pop(), type: playwrightInternals.iso.getMimeTypeForPath(path) ?? '', data: readFileSync(path).toString('base64') })) : [];
    this._fileDragActive = type === 'dragEnter' || type === 'dragOver';
    await this.evaluate(({ type, x, y, files, mask }) => {
      if (type === 'dragEnter') {
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.data), character => character.charCodeAt(0))], file.name, { type: file.type }));
        transfer.effectAllowed = mask === 1 ? 'copy' : 'all';
        window.__pwFileDrag = { transfer, target: null, accepted: false };
      }
      const drag = window.__pwFileDrag;
      if (!drag) throw new Error('No file drag is in progress');
      const fire = (name, target, related) => {
        const event = new DragEvent(name, { bubbles: true, cancelable: name !== 'dragleave', composed: true, clientX: x, clientY: y, relatedTarget: related, dataTransfer: drag.transfer });
        return target.dispatchEvent(event);
      };
      if (type === 'dragCancel') { if (drag.target) fire('dragleave', drag.target, null); delete window.__pwFileDrag; return; }
      const target = document.elementFromPoint(x, y) ?? document.documentElement;
      if (target !== drag.target) {
        fire('dragenter', target, drag.target);
        if (drag.target) fire('dragleave', drag.target, target);
        drag.target = target;
      }
      if (type === 'drop') {
        if (drag.accepted) fire('drop', target, null); else fire('dragleave', target, null);
        delete window.__pwFileDrag;
        return;
      }
      drag.accepted = !fire('dragover', target, null);
    }, { type, x, y, files, mask: data.dragOperationsMask ?? 1 });
  }

  async _drag(type, x, y, data = {}) {
    const input = await this._context._session.xInput();
    const source = await this._context._session.dragSource();
    const [left, top] = await this._xOrigin();
    const point = { x: Math.round(left + x), y: Math.round(top + y) };
    const move = async (to, steps = 4) => {
      const from = this._context._activeDrag.pointer;
      for (let step = 1; step <= steps; step++) await input.request({ action: 'move', x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) });
      this._context._activeDrag.pointer = to;
    };
    if (type === 'dragEnter') {
      if (this._context._activeDrag) await this._context._activeDrag.cancel();
      const files = (data.files ?? []).map(path => resolvePath(path));
      const text = data.items?.find(item => /^text\/plain/.test(item.mimeType))?.data ?? null;
      const start = await source.request({ action: 'prepare', files, text, mask: data.dragOperationsMask ?? 1 });
      this._context._activeDrag = { page: this, pointer: start, cancel: async () => {
        this._context._activeDrag = undefined;
        await source.request({ action: 'cancel' });
        await input.request({ action: 'button', button: 1, down: false });
      } };
      await input.request({ action: 'move', x: start.x, y: start.y });
      await input.request({ action: 'button', button: 1, down: true });
      await move({ x: start.x - 30, y: start.y - 30 }, 6);
      await this._xExpect(['dragenter'], () => move(point, 8));
      return;
    }
    if (!this._context._activeDrag) throw new Error('drag: no drag is in progress');
    if (type === 'dragOver') {
      await this._xExpect(['dragover', 'dragleave'], async () => { await move({ x: point.x + 1, y: point.y }, 1); await move(point, 1); });
      return;
    }
    if (type === 'drop') {
      const drag = this._context._activeDrag;
      this._context._activeDrag = undefined;
      await this._xExpect(['drop', 'dragleave'], () => input.request({ action: 'button', button: 1, down: false }));
      drag.page = undefined;
      return;
    }
    if (type === 'dragCancel') {
      await this._xExpect(['dragleave'], () => this._context._activeDrag.cancel());
      return;
    }
    throw new Error('drag: unknown drag event ' + type);
  }

  async _installBridge() {
    await this._execute('(' + pageBridge + ')(arguments[0], ' + serialize + ', ' + deserialize + ');', [this._context._bridgeConfig(this._id)]);
  }

  async _installBinding(name) {
    try { await this._execute('if (window.__pw) window.__pw.expose(arguments[0]);', [name]); } catch {}
  }

  async _evaluate(api, fn, args, { selector = null, timeout } = {}) {
    const isFunction = typeof fn === 'function';
    const source = isFunction ? fn.toString() : String(fn);
    const { id, deferred } = this._context._evaluation();
    let started;
    try {
      for (let attempt = 0; ; attempt++) {
        started = await this._execute('return window.__pw ? window.__pw.start(...arguments) : null;', [id, source, isFunction, args.map(arg => serialize(arg)), selector, timeout ?? this._defaultTimeout]);
        if (started) break;
        if (attempt) throw new Error('The test bridge could not be installed');
        await this._installBridge();
      }
    } catch (error) {
      this._context._evaluations.delete(id);
      throw apiError(api, error);
    }
    let result;
    if (started.done) { this._context._evaluations.delete(id); result = started; }
    else { deferred.docId = started.docId; result = await deferred.promise; }
    if (!result.ok) throw apiError(api, result.error);
    return deserialize(result.value);
  }

  context() { return this._context; }
  url() { return this._url; }
  isClosed() { return this._closed; }
  setDefaultTimeout(timeout) { this._timeout = timeout; }
  setDefaultNavigationTimeout() {}
  viewportSize() { return this._viewport; }
  mainFrame() { return this; }
  frames() { return [this]; }

  async goto(url) {
    this._context._proxy.claim(this._id);
    try { await this._command(command => command('POST', '/url', { url })); }
    catch (error) { throw apiError('page.goto', error); }
    this._url = await this._command(command => command('GET', '/url'));
    return null;
  }

  async reload() {
    this._context._proxy.claim(this._id);
    await this._command(command => command('POST', '/refresh', {}));
    this._url = await this._command(command => command('GET', '/url'));
    return null;
  }

  async goBack() { await this._command(command => command('POST', '/back', {})); this._url = await this._command(command => command('GET', '/url')); return null; }
  async goForward() { await this._command(command => command('POST', '/forward', {})); this._url = await this._command(command => command('GET', '/url')); return null; }
  async title() { return this._command(command => command('GET', '/title')); }
  async content() { return this.evaluate(() => document.documentElement.outerHTML); }
  async waitForLoadState() { await this.evaluate(() => document.readyState === 'complete' || new Promise(resolve => addEventListener('load', resolve, { once: true }))); }

  async waitForURL(match, { timeout = this._defaultTimeout } = {}) {
    const matches = urlMatcher(match);
    const deadline = Date.now() + timeout;
    while (!matches(this._url = await this._command(command => command('GET', '/url')))) {
      if (Date.now() > deadline) throw new TimeoutError('page.waitForURL: Timeout ' + timeout + 'ms exceeded.');
      await delay(50);
    }
  }

  async setViewportSize({ width, height }) {
    await this._command(async command => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const rect = await command('GET', '/window/rect');
        const [innerWidth, innerHeight] = await command('POST', '/execute/sync', { script: 'return [innerWidth, innerHeight];', args: [] });
        if (innerWidth === width && innerHeight === height) return;
        await command('POST', '/window/rect', { x: 1900, y: 0, width: width + rect.width - innerWidth, height: height + rect.height - innerHeight });
      }
      const [innerWidth, innerHeight] = await command('POST', '/execute/sync', { script: 'return [innerWidth, innerHeight];', args: [] });
      if (innerWidth !== width || innerHeight !== height) throw new Error('page.setViewportSize: the viewport is ' + innerWidth + 'x' + innerHeight + ' instead of ' + width + 'x' + height);
    });
    this._viewport = { width, height };
  }

  async bringToFront() {
    await this._command(command => command('POST', '/window', { handle: this._window }));
    await this._xFocus();
    await this.waitForFunction(() => document.hasFocus(), undefined, { timeout: 5000 });
  }

  async close() {
    if (this._closed) return;
    const others = this._context.pages().filter(page => page !== this);
    if (others.length) await this._context._session.closeWindow(this._window).catch(() => {});
    else {
      await this._command(command => command('POST', '/url', { url: 'about:blank' })).catch(() => {});
      this._context._spareWindow = this._window;
    }
    this._closed = true;
    this.emit('close', this);
    if (this._ownsContext) await this._context.close();
  }

  async screenshot({ path } = {}) {
    const image = Buffer.from(await this._command(command => command('GET', '/screenshot')), 'base64');
    if (path) await writeFile(path, image);
    return image;
  }

  evaluate(fn, arg) { return this._evaluate('page.evaluate', fn, [arg]); }
  async evaluateHandle(fn, arg) { const value = await this.evaluate(fn, arg); return { jsonValue: async () => value, dispose: async () => {} }; }

  async waitForFunction(fn, arg, { timeout = this._defaultTimeout } = {}) {
    const isFunction = typeof fn === 'function';
    const value = await this._evaluate('page.waitForFunction', (source, isFunction, args, timeout) => window.__pw.waitForFunction(source, isFunction, args, timeout), [isFunction ? fn.toString() : String(fn), isFunction, [serialize(arg)], timeout]);
    return { jsonValue: async () => value, dispose: async () => {} };
  }

  waitForTimeout(timeout) { return delay(timeout); }

  waitForEvent(event, optionsOrPredicate = {}) {
    const options = typeof optionsOrPredicate === 'function' ? { predicate: optionsOrPredicate } : optionsOrPredicate;
    const timeout = options.timeout ?? this._defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.off(event, listener); reject(new TimeoutError('page.waitForEvent: Timeout ' + timeout + 'ms exceeded while waiting for event "' + event + '"')); }, timeout) : undefined;
      const listener = async value => {
        try { if (options.predicate && !await options.predicate(value)) return; }
        catch (error) { clearTimeout(timer); this.off(event, listener); reject(error); return; }
        clearTimeout(timer);
        this.off(event, listener);
        resolve(value);
      };
      this.on(event, listener);
    });
  }

  async addInitScript(script, arg) { this._initScripts.push(scriptSource(script, arg)); }
  async exposeBinding(name, callback) { this._bindings.set(name, callback); await this._installBinding(name); }
  exposeFunction(name, callback) { return this.exposeBinding(name, (source, ...args) => callback(...args)); }
  async route(url, handler, options) { this._routes.unshift(new Route(url, handler, options)); }
  async unroute(url, handler) { this._routes = this._routes.filter(route => !(route.url === url && (!handler || route.handler === handler))); }
  async routeWebSocket(url, handler) { this._webSocketRoutes.unshift(new WebSocketRoute(url, handler)); }

  async addStyleTag({ content, path, url } = {}) {
    await this.evaluate(({ content, url }) => new Promise((resolve, reject) => {
      const element = url ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url }) : Object.assign(document.createElement('style'), { textContent: content });
      if (url) { element.onload = resolve; element.onerror = reject; } else resolve();
      document.head.append(element);
    }), { content: path ? readFileSync(path, 'utf8') : content, url });
  }

  async addScriptTag({ content, path, url } = {}) {
    await this.evaluate(({ content, url }) => new Promise((resolve, reject) => {
      const element = document.createElement('script');
      if (url) { element.src = url; element.onload = resolve; element.onerror = reject; } else { element.textContent = content; resolve(); }
      document.head.append(element);
    }), { content: path ? readFileSync(path, 'utf8') : content, url });
  }

  locator(selector, options) { return new Locator(this, selector + filterSuffix(options)); }
  getByRole(role, options) { return this.locator(selectors.role(role, options)); }
  getByText(text, options) { return this.locator(selectors.text(text, options)); }
  getByLabel(text, options) { return this.locator(selectors.label(text, options)); }
  getByTestId(id) { return this.locator(selectors.testId(id)); }
  getByPlaceholder(text, options) { return this.locator(selectors.placeholder(text, options)); }
  getByAltText(text, options) { return this.locator(selectors.altText(text, options)); }
  getByTitle(text, options) { return this.locator(selectors.title(text, options)); }

  async _actions(source) { await this._command(command => command('POST', '/actions', { actions: [source] })); }
}

class Locator {
  constructor(page, selector) { this._page = page; this._selector = selector; }
  page() { return this._page; }
  toString() { return 'locator(' + JSON.stringify(this._selector) + ')'; }
  describe() { return this; }
  locator(selector, options) { return new Locator(this._page, this._selector + ' >> ' + (selector instanceof Locator ? 'internal:chain=' + JSON.stringify(selector._selector) : selector) + filterSuffix(options)); }
  getByRole(role, options) { return this.locator(selectors.role(role, options)); }
  getByText(text, options) { return this.locator(selectors.text(text, options)); }
  getByLabel(text, options) { return this.locator(selectors.label(text, options)); }
  getByTestId(id) { return this.locator(selectors.testId(id)); }
  getByPlaceholder(text, options) { return this.locator(selectors.placeholder(text, options)); }
  getByAltText(text, options) { return this.locator(selectors.altText(text, options)); }
  getByTitle(text, options) { return this.locator(selectors.title(text, options)); }
  filter(options) { return new Locator(this._page, this._selector + filterSuffix(options)); }
  first() { return new Locator(this._page, this._selector + ' >> nth=0'); }
  last() { return new Locator(this._page, this._selector + ' >> nth=-1'); }
  nth(index) { return new Locator(this._page, this._selector + ' >> nth=' + index); }
  and(locator) { return new Locator(this._page, this._selector + ' >> internal:and=' + JSON.stringify(locator._selector)); }
  or(locator) { return new Locator(this._page, this._selector + ' >> internal:or=' + JSON.stringify(locator._selector)); }

  _call(api, fn, args, timeout) { return this._page._evaluate(api, fn, args, { timeout }); }
  _element(api, operation, args = [], { timeout } = {}) {
    const wait = timeout ?? this._page._defaultTimeout;
    return this._call(api, (selector, operation, args, timeout) => window.__pw.elementCall(selector, operation, args, timeout), [this._selector, operation, args, wait], wait);
  }

  count() { return this._call('locator.count', selector => window.__pw.count(selector), [this._selector]); }
  async all() { const count = await this.count(); return Array.from({ length: count }, (_, index) => this.nth(index)); }
  allTextContents() { return this._call('locator.allTextContents', selector => window.__pw.texts(selector, false), [this._selector]); }
  allInnerTexts() { return this._call('locator.allInnerTexts', selector => window.__pw.texts(selector, true), [this._selector]); }
  isVisible() { return this._call('locator.isVisible', selector => window.__pw.visible(selector), [this._selector]); }
  async isHidden() { return !await this.isVisible(); }
  textContent(options) { return this._element('locator.textContent', 'textContent', [], options); }
  innerText(options) { return this._element('locator.innerText', 'innerText', [], options); }
  innerHTML(options) { return this._element('locator.innerHTML', 'innerHTML', [], options); }
  getAttribute(name, options) { return this._element('locator.getAttribute', 'getAttribute', [name], options); }
  inputValue(options) { return this._element('locator.inputValue', 'inputValue', [], options); }
  isEnabled(options) { return this._element('locator.isEnabled', 'isEnabled', [], options); }
  isDisabled(options) { return this._element('locator.isDisabled', 'isDisabled', [], options); }
  isChecked(options) { return this._element('locator.isChecked', 'isChecked', [], options); }
  isEditable(options) { return this._element('locator.isEditable', 'isEditable', [], options); }
  boundingBox(options) { return this._element('locator.boundingBox', 'boundingBox', [], options); }
  focus(options) { return this._element('locator.focus', 'focus', [], options); }
  blur(options) { return this._element('locator.blur', 'blur', [], options); }
  selectText(options) { return this._element('locator.selectText', 'selectText', [], options); }
  scrollIntoViewIfNeeded(options) { return this._element('locator.scrollIntoViewIfNeeded', 'scrollIntoView', [], options); }
  dispatchEvent(type, init, options) { return this._element('locator.dispatchEvent', 'dispatchEvent', [type, init], options); }
  async highlight() {}

  async waitFor({ state = 'visible', timeout } = {}) {
    const wait = timeout ?? this._page._defaultTimeout;
    await this._call('locator.waitFor', (selector, state, timeout) => window.__pw.waitForState(selector, state, timeout), [this._selector, state, wait], wait);
  }

  evaluate(fn, arg, { timeout } = {}) { return this._page._evaluate('locator.evaluate', fn, [arg], { selector: { value: this._selector }, timeout }); }
  evaluateAll(fn, arg) { return this._page._evaluate('locator.evaluateAll', fn, [arg], { selector: { value: this._selector, all: true } }); }

  async _point(api, { timeout, force, position, enabled = true } = {}) {
    const wait = timeout ?? this._page._defaultTimeout;
    return this._call(api, (selector, options) => window.__pw.actionPoint(selector, options), [this._selector, { timeout: wait, force: !!force, position, enabled }], wait);
  }

  async _withModifiers(modifiers = [], action) {
    for (const key of modifiers) await this._page.keyboard.down(key);
    try { await action(); } finally { for (const key of [...modifiers].reverse()) await this._page.keyboard.up(key); }
  }

  async click(options = {}) {
    const { x, y } = await this._point('locator.click', options);
    if (options.trial) return;
    await this._withModifiers(options.modifiers, () => this._page.mouse.click(x, y, options));
  }

  async dblclick(options = {}) {
    const { x, y } = await this._point('locator.dblclick', options);
    if (options.trial) return;
    await this._withModifiers(options.modifiers, () => this._page.mouse.click(x, y, { ...options, clickCount: 2 }));
  }

  async hover(options = {}) {
    const { x, y } = await this._point('locator.hover', { ...options, enabled: false });
    if (options.trial) return;
    await this._withModifiers(options.modifiers, () => this._page.mouse.move(x, y));
  }

  async tap() { throw new Error('locator.tap: ' + noTouch); }

  async setChecked(checked, options = {}) {
    if (await this._element('locator.setChecked', 'checkedState', [], options) === checked) return;
    await this.click(options);
    if (await this._element('locator.setChecked', 'checkedState', [], options) !== checked) throw new Error('locator.setChecked: Clicking the checkbox did not change its state');
  }
  check(options) { return this.setChecked(true, options); }
  uncheck(options) { return this.setChecked(false, options); }

  async fill(value, options = {}) {
    const wait = options.timeout ?? this._page._defaultTimeout;
    if (!options.force) await this.waitFor({ state: 'visible', timeout: wait });
    await this._element('locator.fill', 'fill', [String(value)], { timeout: wait });
  }
  clear(options) { return this.fill('', options); }

  async press(key, options = {}) {
    await this.focus(options);
    await this._page.keyboard.press(key, options);
  }

  async pressSequentially(text, options = {}) {
    await this.focus(options);
    await this._page.keyboard.type(text, options);
  }
  type(text, options) { return this.pressSequentially(text, options); }

  async selectOption(values, options = {}) {
    const list = (Array.isArray(values) ? values : [values]).map(value => typeof value === 'string' ? { valueOrLabel: value } : value);
    const wait = options.timeout ?? this._page._defaultTimeout;
    const deadline = Date.now() + wait;
    for (;;) {
      const result = await this._element('locator.selectOption', 'selectOption', [list], { timeout: wait });
      if (Array.isArray(result)) return result;
      if (Date.now() > deadline) throw new TimeoutError('locator.selectOption: Timeout ' + wait + 'ms exceeded: ' + result);
      await delay(50);
    }
  }
}

class Keyboard {
  constructor(page) { this._page = page; this._held = new Set(); }
  async down(key) { await this._page._actions({ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: keyValue(key) }] }); this._held.add(key); }
  async up(key) { await this._page._actions({ type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: keyValue(key) }] }); this._held.delete(key); }
  async press(shortcut, { delay: wait = 0 } = {}) {
    const keys = shortcutKeys(shortcut).map(keyValue);
    const actions = keys.map(value => ({ type: 'keyDown', value }));
    if (wait) actions.push({ type: 'pause', duration: wait });
    actions.push(...[...keys].reverse().map(value => ({ type: 'keyUp', value })));
    await this._page._actions({ type: 'key', id: 'keyboard', actions });
  }
  async type(text, { delay: wait = 0 } = {}) {
    const actions = [];
    for (const character of text) {
      const value = character === '\n' ? keyValue('Enter') : character === '\t' ? keyValue('Tab') : character;
      actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
      if (wait) actions.push({ type: 'pause', duration: wait });
    }
    if (actions.length) await this._page._actions({ type: 'key', id: 'keyboard', actions });
  }
  async insertText(text) {
    await this._page.evaluate(text => { document.execCommand('insertText', false, text); }, text);
  }
}

const buttons = { left: 0, middle: 1, right: 2 };
const xButtons = { left: 1, middle: 2, right: 3 };

class Mouse {
  constructor(page) { this._page = page; this._x = 0; this._y = 0; }
  _pointer(actions) { return this._page._actions({ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }); }
  _move(x, y) { return { type: 'pointerMove', origin: 'viewport', x: Math.round(x), y: Math.round(y), duration: 0 }; }
  async move(x, y, { steps = 1 } = {}) {
    const actions = [];
    for (let step = 1; step <= steps; step++) actions.push(this._move(this._x + (x - this._x) * step / steps, this._y + (y - this._y) * step / steps));
    this._x = x; this._y = y;
    await this._pointer(actions);
  }
  async down({ button = 'left' } = {}) {
    if (button !== 'left') return this._page._xPointer(this._x, this._y, [{ button: xButtons[button], down: true }]);
    await this._pointer([{ type: 'pointerDown', button: buttons[button] }]);
  }
  async up({ button = 'left' } = {}) {
    if (button !== 'left') return this._page._xPointer(this._x, this._y, [{ button: xButtons[button], down: false }]);
    await this._pointer([{ type: 'pointerUp', button: buttons[button] }]);
  }
  async click(x, y, { button = 'left', clickCount = 1, delay: wait = 0 } = {}) {
    this._x = x; this._y = y;
    if (button !== 'left') {
      const steps = [];
      for (let count = 0; count < clickCount; count++) steps.push({ button: xButtons[button], down: true }, ...(wait ? [{ pause: wait }] : []), { button: xButtons[button], down: false });
      return this._page._xPointer(x, y, steps);
    }
    const actions = [this._move(x, y)];
    for (let count = 0; count < clickCount; count++) {
      actions.push({ type: 'pointerDown', button: buttons[button] });
      if (wait) actions.push({ type: 'pause', duration: wait });
      actions.push({ type: 'pointerUp', button: buttons[button] });
    }
    await this._pointer(actions);
  }
  dblclick(x, y, options = {}) { return this.click(x, y, { ...options, clickCount: 2 }); }
  async wheel(deltaX, deltaY) {
    const modifiers = [...this._page.keyboard._held].filter(key => modifierKeys.has(key));
    if (modifiers.length) return this._modifiedWheel(deltaX, deltaY, modifiers);
    await this._page._actions({ type: 'wheel', id: 'wheel', actions: [{ type: 'scroll', origin: 'viewport', x: Math.round(this._x), y: Math.round(this._y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), duration: 0 }] });
  }

  async _modifiedWheel(deltaX, deltaY, keys) {
    await this._page.evaluate(({ x, y, deltaX, deltaY, keys }) => {
      const target = document.elementFromPoint(x, y) ?? document.documentElement;
      target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, ctrlKey: keys.includes('Control') || keys.includes('ControlOrMeta'), shiftKey: keys.includes('Shift'), altKey: keys.includes('Alt'), metaKey: keys.includes('Meta') }));
    }, { x: this._x, y: this._y, deltaX, deltaY, keys });
  }
}

const modifierKeys = new Set(['Control', 'ControlOrMeta', 'Shift', 'Alt', 'Meta']);

const noTouch = 'WebKitGTK on the test screen has no touch input';

class Touchscreen {
  async tap() { throw new Error('touchscreen.tap: ' + noTouch); }
}

class EmulatedCDPSession {
  constructor(page) { this._page = page; }
  async detach() {}
  async send(method, params = {}) {
    const page = this._page;
    if (method === 'Emulation.setFocusEmulationEnabled') return {};
    if (method === 'Input.insertText') {
      if (page._composing) { await page.keyboard.press('Escape'); page._composing = false; }
      await page.keyboard.insertText(params.text);
      return {};
    }
    if (method === 'Input.imeSetComposition') {
      if (page._composing) return {};
      if (params.replacementStart !== undefined) await page.evaluate(({ start, end }) => document.activeElement?.setSelectionRange?.(start, end), { start: params.replacementStart, end: params.replacementEnd ?? params.replacementStart });
      await page.keyboard.press('Control+Shift+u');
      page._composing = true;
      return {};
    }
    if (method === 'Input.dispatchDragEvent') {
      if (params.data?.files?.length || page._fileDragActive) await page._fileDrag(params.type, params.x, params.y, params.data);
      else await page._drag(params.type, params.x, params.y, params.data);
      return {};
    }
    throw new Error('The Chrome DevTools command ' + method + ' has no WebKit equivalent');
  }
}

class Clock {
  constructor(context) { this._context = context; this._installed = false; }
  async _run(expression) {
    if (!this._installed) {
      this._installed = true;
      const bootstrap = '(() => { const module = {};\n' + clockSource + '\nif (!globalThis.__pwClock) globalThis.__pwClock = (module.exports.inject())(globalThis, "webkit"); })();';
      this._context._initScripts.push(bootstrap);
      await Promise.all(this._context.pages().map(page => page.evaluate(bootstrap)));
    }
    this._context._initScripts.push('globalThis.__pwClock.controller.log(' + JSON.stringify(expression.name) + ', ' + Date.now() + ', ' + expression.param + ')');
    await Promise.all(this._context.pages().map(page => page.evaluate('globalThis.__pwClock.controller.' + expression.name + '(' + expression.param + ')')));
  }
  install({ time } = {}) { return this._run({ name: 'install', param: time === undefined ? Date.now() : new Date(time).getTime() }); }
  runFor(ticks) { return this._run({ name: 'runFor', param: Number(ticks) }); }
  fastForward(ticks) { return this._run({ name: 'fastForward', param: Number(ticks) }); }
  pauseAt(time) { return this._run({ name: 'pauseAt', param: new Date(time).getTime() }); }
  resume() { return this._run({ name: 'resume', param: '' }); }
  setFixedTime(time) { return this._run({ name: 'setFixedTime', param: new Date(time).getTime() }); }
  setSystemTime(time) { return this._run({ name: 'setSystemTime', param: new Date(time).getTime() }); }
}
