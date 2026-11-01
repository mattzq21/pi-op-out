export function serialize(value, seen = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return { $u: 1 };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $n: 'NaN' };
    if (value === Infinity) return { $n: 'Infinity' };
    if (value === -Infinity) return { $n: '-Infinity' };
    if (Object.is(value, -0)) return { $n: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $b: String(value) };
  if (value instanceof Date) return { $d: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (value instanceof RegExp) return { $r: [value.source, value.flags] };
  if (value instanceof Error) return { $e: { name: value.name, message: value.message, stack: value.stack } };
  if (typeof Node === 'function' && value instanceof Node) return { $o: {} };
  if (seen.has(value)) return { $u: 1 };
  seen.add(value);
  try {
    if (Array.isArray(value)) return { $a: value.map(item => serialize(item, seen)) };
    if (value instanceof Map) return { $m: [...value].map(([key, item]) => [serialize(key, seen), serialize(item, seen)]) };
    if (value instanceof Set) return { $s: [...value].map(item => serialize(item, seen)) };
    if (ArrayBuffer.isView(value)) return { $t: [value.constructor.name, Array.from(value, Number)] };
    const object = {};
    for (const key of Object.keys(value)) object[key] = serialize(value[key], seen);
    return { $o: object };
  } finally { seen.delete(value); }
}

export function deserialize(value) {
  if (value === null || typeof value !== 'object') return value;
  if ('$u' in value) return undefined;
  if ('$n' in value) return value.$n === '-0' ? -0 : Number(value.$n);
  if ('$b' in value) return BigInt(value.$b);
  if ('$d' in value) return new Date(value.$d ?? NaN);
  if ('$r' in value) return new RegExp(value.$r[0], value.$r[1]);
  if ('$e' in value) return Object.assign(new Error(value.$e.message), { name: value.$e.name, stack: value.$e.stack });
  if ('$a' in value) return value.$a.map(deserialize);
  if ('$m' in value) return new Map(value.$m.map(([key, item]) => [deserialize(key), deserialize(item)]));
  if ('$s' in value) return new Set(value.$s.map(deserialize));
  if ('$t' in value) return new globalThis[value.$t[0]](value.$t[1]);
  if ('$o' in value) return Object.fromEntries(Object.entries(value.$o).map(([key, item]) => [key, deserialize(item)]));
  throw new Error('Unknown serialized value: ' + JSON.stringify(value));
}

export function pageBridge(config, serialize, deserialize) {
  const page = window;
  if (page.__pw) {
    for (const name of config.exposed) page.__pw.expose(name);
    return;
  }
  const builtins = {
    setTimeout: page.setTimeout.bind(page), clearTimeout: page.clearTimeout.bind(page), fetch: page.fetch.bind(page),
    XMLHttpRequest: page.XMLHttpRequest, Promise: page.Promise, now: page.performance.now.bind(page.performance),
    stringify: JSON.stringify, parse: JSON.parse, eval: page.eval, console: { ...page.console },
  };
  const docId = Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  const base = /^https?:$/.test(location.protocol) ? '/__pw/' : 'http://pw-bridge.test/__pw/';
  let pageId = config.pageId;
  try {
    if (pageId) sessionStorage.setItem('__pwPage', pageId);
    else pageId = sessionStorage.getItem('__pwPage') ?? undefined;
  } catch {}
  const pageIds = Object.keys(config.pageScripts);
  if (!pageId && pageIds.length === 1) pageId = pageIds[0];

  const post = (kind, body, keepalive = false) => builtins.fetch(base + kind, { method: 'POST', body: builtins.stringify({ docId, pageId, ...body }), keepalive }).then(() => undefined, () => undefined);
  const request = (kind, body) => {
    const xhr = new builtins.XMLHttpRequest();
    xhr.open('POST', base + kind, false);
    xhr.send(builtins.stringify({ docId, pageId, ...body }));
    if (xhr.status !== 200) throw new Error('The test bridge failed: ' + xhr.status + ' ' + xhr.responseText);
    return builtins.parse(xhr.responseText);
  };
  const describeError = error => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: '', message: String(error), stack: undefined };

  page.addEventListener('error', event => { if (event.error != null) post('event', { type: 'pageerror', error: describeError(event.error) }); });
  page.addEventListener('unhandledrejection', event => post('event', { type: 'pageerror', error: describeError(event.reason) }));
  const text = value => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack?.startsWith(String(value)) ? value.stack : String(value) + (value.stack ? '\n' + value.stack : '');
    try { return typeof value === 'object' && value !== null ? builtins.stringify(value) : String(value); } catch { return String(value); }
  };
  for (const [method, type] of [['log', 'log'], ['info', 'info'], ['warn', 'warning'], ['error', 'error'], ['debug', 'debug'], ['trace', 'trace']]) {
    const original = page.console[method];
    page.console[method] = function (...args) {
      post('event', { type: 'console', level: type, text: args.map(text).join(' '), args: args.map(arg => { try { return serialize(arg); } catch { return { $u: 1 }; } }) });
      return original.apply(this, args);
    };
  }

  page.addEventListener('contextmenu', () => {
    page.addEventListener('contextmenu', event => { if (!event.defaultPrevented) event.preventDefault(); }, { once: true });
  }, true);
  page.alert = message => { request('dialog', { type: 'alert', message: message === undefined ? '' : String(message) }); };
  page.confirm = message => request('dialog', { type: 'confirm', message: message === undefined ? '' : String(message) }).accept;
  page.prompt = (message, defaultValue) => {
    const answer = request('dialog', { type: 'prompt', message: message === undefined ? '' : String(message), defaultValue: defaultValue === undefined ? '' : String(defaultValue) });
    return answer.accept ? answer.promptText ?? (defaultValue === undefined ? '' : String(defaultValue)) : null;
  };

  const navigated = () => post('event', { type: 'url', url: location.href });
  for (const method of ['pushState', 'replaceState']) {
    const original = page.history[method];
    page.history[method] = function (...args) { const result = original.apply(this, args); navigated(); return result; };
  }
  page.addEventListener('popstate', navigated);
  page.addEventListener('hashchange', navigated);
  page.addEventListener('pagehide', () => post('event', { type: 'unload' }, true));
  post('event', { type: 'document', url: location.href });

  let injected;
  const injectedScript = () => {
    if (injected) return injected;
    const xhr = new builtins.XMLHttpRequest();
    xhr.open('GET', base + 'injected.js', false);
    xhr.send();
    injected = (0, builtins.eval)('(() => { const module = {};\n' + xhr.responseText + '\nreturn new (module.exports.InjectedScript())(globalThis, ' + builtins.stringify(config.injectedOptions) + '); })()');
    return injected;
  };

  const sleep = ms => new builtins.Promise(resolve => builtins.setTimeout(resolve, ms));
  const CONTINUE = Symbol('continue');
  const waitUntil = async (predicate, timeout, describe) => {
    const deadline = builtins.now() + timeout;
    let reason = '';
    for (;;) {
      const result = predicate(why => { reason = why; });
      if (result !== CONTINUE) return result;
      if (builtins.now() >= deadline) throw Object.assign(new Error('Timeout ' + timeout + 'ms exceeded' + (describe ? ' ' + describe : '') + '.' + (reason ? '\n  - ' + reason : '')), { name: 'TimeoutError' });
      await sleep(16);
    }
  };

  const select = selector => {
    const engine = injectedScript();
    return engine.querySelectorAll(engine.parseSelector(selector), document);
  };
  const single = selector => {
    const engine = injectedScript();
    const elements = select(selector);
    if (elements.length > 1) throw engine.strictModeViolationError(engine.parseSelector(selector), elements);
    return elements[0];
  };
  const visible = element => injectedScript().elementState(element, 'visible', true).matches;
  const waitForElement = (selector, timeout, describe) => waitUntil(why => {
    const element = single(selector);
    if (!element) { why('waiting for ' + selector); return CONTINUE; }
    return element;
  }, timeout, describe);

  const actionPoint = (selector, { timeout, force, position, enabled }) => {
    let previous;
    return waitUntil(why => {
      const engine = injectedScript();
      const element = single(selector);
      if (!element) { why('waiting for ' + selector); return CONTINUE; }
      if (!force) {
        if (!visible(element)) { why('element is not visible'); previous = undefined; return CONTINUE; }
        if (enabled && !engine.elementState(element, 'enabled').matches) { why('element is not enabled'); return CONTINUE; }
      }
      const target = engine.retarget(element, 'none');
      if (typeof target.scrollIntoViewIfNeeded === 'function') target.scrollIntoViewIfNeeded(true);
      else target.scrollIntoView({ block: 'center', inline: 'center' });
      const box = target.getBoundingClientRect();
      const key = [box.x, box.y, box.width, box.height].join();
      if (!force && key !== previous) { previous = key; why('element is not stable'); return CONTINUE; }
      const left = Math.max(box.left, 0), top = Math.max(box.top, 0), right = Math.min(box.right, innerWidth), bottom = Math.min(box.bottom, innerHeight);
      if (!position && (right <= left || bottom <= top)) { why('element is outside of the viewport'); return CONTINUE; }
      const x = position ? box.x + position.x : (left + right) / 2;
      const y = position ? box.y + position.y : (top + bottom) / 2;
      if (!force) {
        const hit = engine.expectHitTarget({ x, y }, target);
        if (hit !== 'done') { why(hit.hitTargetDescription + ' intercepts pointer events'); return CONTINUE; }
      }
      return { x, y };
    }, timeout);
  };

  const elementOperations = {
    textContent: element => element.textContent,
    innerText: element => element.innerText,
    innerHTML: element => element.innerHTML,
    getAttribute: (element, name) => element.getAttribute(name),
    inputValue: element => {
      const target = injectedScript().retarget(element, 'follow-label');
      if (!target || (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.nodeName) && !(target.nodeName.includes('-') && typeof target.value === 'string'))) throw new Error('Not an <input>, <textarea> or <select> element');
      return target.value;
    },
    isEnabled: element => injectedScript().elementState(element, 'enabled').matches,
    isDisabled: element => injectedScript().elementState(element, 'disabled').matches,
    isChecked: element => injectedScript().elementState(element, 'checked').matches,
    isEditable: element => injectedScript().elementState(element, 'editable').matches,
    boundingBox: element => {
      const box = element.getBoundingClientRect();
      return box.width === 0 && box.height === 0 && !visible(element) ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
    },
    focus: element => { injectedScript().focusNode(element); },
    blur: element => { injectedScript().blurNode(element); },
    selectText: element => { injectedScript().selectText(element); },
    scrollIntoView: element => { element.scrollIntoView({ block: 'center', inline: 'center' }); },
    dispatchEvent: (element, type, init) => { injectedScript().dispatchEvent(element, type, init ?? {}); },
    selectOption: (element, values) => injectedScript().selectOptions(element, values),
    fill: (element, value) => {
      const engine = injectedScript();
      if (!engine.elementState(element, 'editable').matches) throw new Error('Element is not editable');
      const result = engine.fill(element, value);
      if (result !== 'needsinput') return result;
      if (value) document.execCommand('insertText', false, value);
      else document.execCommand('delete', false);
      return 'done';
    },
    checkedState: element => injectedScript().elementState(element, 'checked').matches,
  };

  page.__pw = {
    docId,
    get pageId() { return pageId; },
    expose(name) {
      if (Object.prototype.hasOwnProperty.call(page, name) && page[name]?.__pwExposed) return;
      const call = (...args) => builtins.fetch(base + 'call', { method: 'POST', body: builtins.stringify({ docId, pageId, name, args: args.map(arg => serialize(arg)) }) })
        .then(response => response.json())
        .then(result => {
          if (result.ok) return deserialize(result.value);
          throw Object.assign(new Error(result.error.message), { name: result.error.name, stack: result.error.stack });
        });
      call.__pwExposed = true;
      page[name] = call;
    },
    async start(id, source, isFunction, args, selector, timeout) {
      const run = async () => {
        const values = args.map(deserialize);
        if (selector !== null) {
          if (selector.all) values.unshift(select(selector.value));
          else values.unshift(await waitForElement(selector.value, timeout));
        }
        if (!isFunction) return (0, builtins.eval)(source);
        const fn = (0, builtins.eval)('(' + source + ')');
        return typeof fn === 'function' ? fn(...values) : fn;
      };
      const settled = run().then(value => ({ ok: true, value: serialize(value) }), error => ({ ok: false, error: describeError(error) }));
      const early = await builtins.Promise.race([settled, sleep(0).then(() => null)]);
      if (early) return { done: true, docId, ...early };
      settled.then(result => post('result', { id, ...result }));
      return { done: false, docId };
    },
    count: selector => select(selector).length,
    visible: selector => { const element = single(selector); return Boolean(element) && visible(element); },
    texts: (selector, inner) => select(selector).map(element => inner ? element.innerText : element.textContent ?? ''),
    waitForState: (selector, state, timeout) => waitUntil(why => {
      const element = single(selector);
      const matches = state === 'attached' ? Boolean(element) : state === 'detached' ? !element : state === 'visible' ? Boolean(element) && visible(element) : !element || !visible(element);
      if (matches) return null;
      why('waiting for ' + selector + ' to be ' + state);
      return CONTINUE;
    }, timeout),
    elementCall: async (selector, operation, args, timeout) => elementOperations[operation](await waitForElement(selector, timeout), ...args),
    actionPoint,
    waitForFunction: (source, isFunction, args, timeout, polling) => {
      const fn = isFunction ? (0, builtins.eval)('(' + source + ')') : undefined;
      const values = args.map(deserialize);
      return waitUntil(() => {
        const value = isFunction ? fn(...values) : (0, builtins.eval)(source);
        return value ? value : CONTINUE;
      }, timeout);
    },
  };
  for (const name of config.exposed) page.__pw.expose(name);
  for (const script of config.contextScripts) (0, builtins.eval)(script);
  for (const script of (pageId && config.pageScripts[pageId]) || []) (0, builtins.eval)(script);
}
