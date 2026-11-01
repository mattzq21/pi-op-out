export const START = String.raw`
const options = arguments[0];
if (typeof rrwebRecord === 'undefined') return { error: 'rrwebRecord is not loaded' };
if (window.__piopRrweb && window.__piopRrweb.stop) { try { window.__piopRrweb.stop(); } catch (e) {} }
const state = { events: [], geometry: [], marks: [], ticks: 0, lastSample: new Map(), observers: [] };
window.__piopRrweb = state;
const stopRecord = rrwebRecord.record({
  emit: event => state.events.push(event),
  maskAllInputs: !!options.mask,
  inlineStylesheet: true,
  recordCrossOriginIframes: false,
});
const round = v => Math.round(v * 10) / 10;
const sample = () => {
  state.ticks++;
  for (const selector of options.track || []) {
    const el = document.querySelector(selector);
    let s;
    if (!el) s = { selector, present: false };
    else {
      const r = el.getBoundingClientRect();
      s = { selector, present: true, x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height),
        scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      s.gapToBottom = Math.max(0, el.scrollHeight - el.clientHeight - Math.round(el.scrollTop));
    }
    const key = JSON.stringify(s);
    if (state.lastSample.get(selector) === key) continue;
    state.lastSample.set(selector, key);
    const record = { t: Date.now(), ...s };
    state.geometry.push(record);
    rrwebRecord.record.addCustomEvent('geometry', record);
  }
};
if ((options.track || []).length) {
  state.timer = setInterval(sample, options.intervalMs || 20);
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; sample(); }); };
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  state.observers.push(mo);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(schedule);
    for (const selector of options.track) { const el = document.querySelector(selector); if (el) ro.observe(el); }
    state.observers.push(ro);
  }
  document.addEventListener('scroll', schedule, true);
  state.scrollListener = schedule;
  sample();
}
state.mark = (label, payload) => {
  const record = { label, t: Date.now(), ...(payload || {}) };
  state.marks.push(record);
  rrwebRecord.record.addCustomEvent('mark', record);
  sample();
  return record;
};
state.stop = () => {
  stopRecord();
  clearInterval(state.timer);
  for (const o of state.observers) o.disconnect();
  if (state.scrollListener) document.removeEventListener('scroll', state.scrollListener, true);
  state.stop = null;
};
return { visibilityState: document.visibilityState, href: location.href, viewport: [innerWidth, innerHeight],
  tracked: (options.track || []).map(selector => ({ selector, present: !!document.querySelector(selector) })) };
`;

export const MARK = String.raw`
if (!window.__piopRrweb || !window.__piopRrweb.stop) return { skipped: 'no recording is running', label: arguments[0] };
return window.__piopRrweb.mark(arguments[0], arguments[1]);
`;

export const CLICK = String.raw`
const target = arguments[1];
let el;
if (typeof target === 'string') el = document.querySelector(target);
else {
  const scope = target.within ? document.querySelector(target.within) : document;
  if (!scope) return { error: 'No element matches ' + target.within };
  const candidates = [...scope.querySelectorAll(target.selector || 'button, [role=button], a, [role=tab], [role=option], [role=menuitem], label, summary')];
  const wanted = String(target.text).trim();
  el = candidates.find(c => c.textContent.trim() === wanted || c.getAttribute('aria-label') === wanted)
    || candidates.find(c => c.textContent.trim().includes(wanted) || (c.getAttribute('aria-label') || '').includes(wanted));
}
if (!el) return { error: 'No element matches ' + JSON.stringify(target) };
const state = window.__piopRrweb;
if (state && state.stop) state.mark(arguments[0], { selector: typeof target === 'string' ? target : JSON.stringify(target) });
el.click();
return { clicked: el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]' : '') + ' ' + el.textContent.trim().slice(0, 40) };
`;

export const DRAG = String.raw`
const done = arguments[arguments.length - 1];
const [label, selector, dx, dy, steps, intervalMs] = arguments;
const el = document.querySelector(selector);
if (!el) return done({ error: 'No element matches ' + selector });
const state = window.__piopRrweb;
const r = el.getBoundingClientRect();
const x0 = r.x + r.width / 2, y0 = r.y + r.height / 2;
const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
if (state && state.stop) state.mark(label, { selector, dx, dy });
fire('pointerdown', x0, y0);
let i = 0;
const step = () => {
  i++;
  fire('pointermove', x0 + dx * i / steps, y0 + dy * i / steps);
  if (i < steps) return setTimeout(step, intervalMs);
  fire('pointerup', x0 + dx, y0 + dy);
  if (state && state.stop) state.mark(label + ':up', { selector });
  done({ dragged: selector, dx, dy });
};
setTimeout(step, intervalMs);
`;

export const STOP = String.raw`
const state = window.__piopRrweb;
if (!state) return { error: 'No recording was started' };
if (state.stop) {
  rrwebRecord.record.addCustomEvent('end', { t: Date.now() });
  state.stop();
}
return { events: state.events, geometry: state.geometry, marks: state.marks, ticks: state.ticks,
  visibilityState: document.visibilityState, href: location.href, viewport: [innerWidth, innerHeight] };
`;

export const STATUS = String.raw`
const state = window.__piopRrweb;
return { loaded: typeof rrwebRecord !== 'undefined', recording: !!(state && state.stop), events: state ? state.events.length : 0,
  marks: state ? state.marks.map(m => m.label) : [], geometry: state ? state.geometry.length : 0, visibilityState: document.visibilityState };
`;
