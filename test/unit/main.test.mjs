import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { StrictMode } from 'react';
import App from '../../src/App.tsx';
import { installDom } from '../dom.mjs';

for (const mode of ['production', 'e2e', 'development']) test(`application startup in ${mode} installs shortcuts and renders the application root`, async () => {
  const dom = installDom();
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const input = document.createElement('textarea'); document.body.append(input); input.focus();
  const commands = []; document.execCommand = command => { commands.push(command); return true; };
  let rendered, disposed;
  globalThis.__PIOP_TEST_MODE__ = mode;
  globalThis.__PIOP_TEST_HOT__ = mode === 'development' ? { dispose(callback) { disposed = callback; } } : undefined;
  globalThis.__PIOP_TEST_CREATE_ROOT__ = element => {
    assert.equal(element, root);
    return { render(value) { assert.equal(rendered, undefined); rendered = value; } };
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react-dom/client' && new URL(context.parentURL).pathname.endsWith('/src/main.tsx')) {
        return { url: 'data:text/javascript,export const createRoot = (...args) => globalThis.__PIOP_TEST_CREATE_ROOT__(...args)', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    await import(`../../src/main.tsx?startup=${mode}`);
    assert.equal(rendered.type, StrictMode);
    assert.equal(rendered.props.children.type, App);
    assert.equal(document.documentElement.dataset.testPalette, mode === 'e2e' ? 'warm-swap' : undefined);
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(undo);
    assert.equal(undo.defaultPrevented, true);
    assert.deepEqual(commands, ['undo']);
    if (mode === 'development') {
      assert.equal(typeof disposed, 'function'); disposed();
      const afterDispose = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(afterDispose);
      assert.equal(afterDispose.defaultPrevented, false);
      assert.deepEqual(commands, ['undo']);
    } else assert.equal(disposed, undefined);
  } finally {
    hooks.deregister();
    delete globalThis.__PIOP_TEST_MODE__; delete globalThis.__PIOP_TEST_HOT__; delete globalThis.__PIOP_TEST_CREATE_ROOT__;
    dom.restore();
  }
});
