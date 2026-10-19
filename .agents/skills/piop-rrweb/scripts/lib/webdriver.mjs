// W3C WebDriver client for a session started by piop-wdio's tauri-webdriver.py.
import fs from 'node:fs';

export const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export function openSession(sessionFile) {
  const manifest = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const c = manifest.webdriverConfig;
  const base = `http://${c.hostname}:${c.port}/session/${manifest.webdriverSessionId}`;

  async function request(route, payload, { method, timeoutMs = 60000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(base + route, {
        method: method ?? (payload === undefined ? 'GET' : 'POST'),
        headers: { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok || (body.value && body.value.error)) {
        throw new Error(`WebDriver ${route}: ${JSON.stringify(body.value ?? body).slice(0, 1500)}`);
      }
      return body.value;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`WebDriver ${route} timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    manifest,
    base,
    request,
    // Script body may use `return` and `arguments`.
    execute: (script, args = []) => request('/execute/sync', { script, args }),
    // Script body receives a callback as its last argument.
    executeAsync: (script, args = []) => request('/execute/async', { script, args }),
    async element(selector) {
      const value = await request('/element', { using: 'css selector', value: selector });
      return value[ELEMENT];
    },
    async sendKeys(selector, text) {
      const id = await this.element(selector);
      return request(`/element/${id}/value`, { text });
    },
    keyActions: actions => request('/actions', { actions: [{ type: 'key', id: 'keyboard', actions }] }),
  };
}

const KEYS = {
  ctrl: '\uE009', control: '\uE009', shift: '\uE008', alt: '\uE00A', meta: '\uE03D', cmd: '\uE03D',
  enter: '\uE007', return: '\uE006', tab: '\uE004', backspace: '\uE003', delete: '\uE017', escape: '\uE00C', esc: '\uE00C',
  space: ' ', arrowleft: '\uE012', arrowup: '\uE013', arrowright: '\uE014', arrowdown: '\uE015',
  left: '\uE012', up: '\uE013', right: '\uE014', down: '\uE015', home: '\uE011', end: '\uE010', pageup: '\uE00E', pagedown: '\uE00F',
  f1: '\uE031', f2: '\uE032', f3: '\uE033', f4: '\uE034', f5: '\uE035', f6: '\uE036', f7: '\uE037', f8: '\uE038', f9: '\uE039', f10: '\uE03A', f11: '\uE03B', f12: '\uE03C',
};
const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'meta', 'cmd']);

// "Ctrl+B ArrowLeft ArrowLeft" -> W3C key action list. Each space-separated chord is pressed and released.
export function chordActions(spec) {
  const actions = [];
  for (const chord of spec.trim().split(/\s+/)) {
    const parts = chord.split('+').filter(Boolean);
    const modifiers = parts.filter(p => MODIFIERS.has(p.toLowerCase())).map(p => KEYS[p.toLowerCase()]);
    const keys = parts.filter(p => !MODIFIERS.has(p.toLowerCase())).map(p => {
      const known = KEYS[p.toLowerCase()];
      if (known) return known;
      if (p.length === 1) return p;
      throw new Error(`Unknown key name: ${p}`);
    });
    for (const m of modifiers) actions.push({ type: 'keyDown', value: m });
    for (const k of keys) actions.push({ type: 'keyDown', value: k }, { type: 'keyUp', value: k });
    for (const m of modifiers.reverse()) actions.push({ type: 'keyUp', value: m });
  }
  return actions;
}
