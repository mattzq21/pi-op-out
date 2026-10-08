import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { installDom } from '../dom.mjs';

for (const mode of ['production', 'e2e', 'development']) test(`application shortcut lifecycle in ${mode}`, async () => {
  const dom = installDom();
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const input = document.createElement('textarea'); document.body.append(input); input.focus();
  const commands = []; document.execCommand = command => { commands.push(command);

  return true; };

  let disposed;
  globalThis.__PIOP_TEST_MODE__ = mode;
  globalThis.__PIOP_TEST_HOT__ = mode === 'development' ? { on() {}, off() {}, dispose(callback) { disposed = callback; } } : undefined;

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'solid-js/web' && new URL(context.parentURL).pathname.endsWith('/clients/ui/main.tsx')) {
        return { url: 'data:text/javascript,export const createComponent = (component, props) => ({ component, props }); export const render = () => () => {}', shortCircuit: true };
      }

      return nextResolve(specifier, context);
    },
  });

  try {
    await import(`../../clients/ui/main.tsx?startup=${mode}`);
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(undo);
    assert.equal(undo.defaultPrevented, true);
    assert.deepEqual(commands, ['undo']);

    if (mode === 'development') {
      assert.ok(disposed instanceof Function); disposed();
      const afterDispose = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(afterDispose);
      assert.equal(afterDispose.defaultPrevented, false);
      assert.deepEqual(commands, ['undo']);
    } else assert.equal(disposed, undefined);
  } finally {
    hooks.deregister();
    delete globalThis.__PIOP_TEST_MODE__; delete globalThis.__PIOP_TEST_HOT__;
    dom.restore();
  }
});
