import { cleanupScope } from './cleanup-scope.mjs';
import { startupPage } from './startup-browser-fixture.mjs';
import { daemonClient } from './daemon-client.mjs';
import { nativeFileCommand } from './native-file-command.mjs';
import assert from 'node:assert/strict';

export async function deliverAppEvent(page, event, payload) {
  let result;
  try {
    result = await page.evaluate(async ({ event, payload }) => {
      try { await window.deliverNativeEvent?.(event, payload); }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    }, { event, payload });
  } catch (error) {
    if (/^page\.evaluate: Execution context was destroyed, most likely because of a navigation\.?$/.test(error.message)) return;
    throw error;
  }
  if (result) throw new Error(result.error);
}

/** The app on a real daemon. nativeFailures maps a native command to the error message it fails with. model 'echo' gives the daemon a model that echoes each message. */
export async function appBrowser(t, { remotes = [], keybindings = {}, nativeFailures = {}, model } = {}) {
  t = cleanupScope(t);
  let page;
  const deliveries = new Set(), requests = new Set(), errors = [];
  t.after(async () => {
    const context = page?.context();
    page = undefined;
    await Promise.allSettled([...deliveries]);
    await context?.close();
    await Promise.allSettled([...requests]);
  });
  const daemon = await daemonClient(t, (event, payload) => {
    if (!page) return;
    const delivery = Promise.allSettled(page.context().pages().map(target => deliverAppEvent(target, event, payload))).then(results => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason.message);
    });
    deliveries.add(delivery);
    delivery.then(() => deliveries.delete(delivery));
  }, { remotes, model });
  const native = await nativeFileCommand(t, { desktop: true });
  const preferences = (await native.invoke('load_client_settings')).settings ?? { keybindings: (await daemon.invoke('load_app_settings')).keybindings, debugMode: false };
  await native.invoke('save_client_settings', { settings: { ...preferences, keybindings: { ...preferences.keybindings, ...keybindings } }, baseline: preferences });
  const browserPage = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/app-browser.tsx', ready: '[aria-label="Message piop"]', holdStorage: false,
    async prepare(value) {
      page = value;
      await page.context().addInitScript(installBrowserStorageTracking);
      page.context().on('page', next => next.on('pageerror', error => errors.push(error.message)));
      await page.context().exposeFunction('nativeCommand', async (command, args) => {
        if (Object.hasOwn(nativeFailures, command)) throw new Error(nativeFailures[command]);
        const request = command === 'daemon_invoke' ? daemon.invoke(args.command, args.args) : native.invoke(command, args);
        requests.add(request);
        try { return await request; } finally { requests.delete(request); }
      });
    },
  });
  t.after(() => assert.deepEqual(errors, []));
  if (model) await browserPage.locator('[aria-label="Model"]:enabled').waitFor({ timeout: 30000 });
  await browserPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return browserPage;
}

export async function appWindow(page) {
  const next = await page.context().newPage();
  next.setDefaultTimeout(10000);
  await next.goto(page.url());
  await next.getByRole('textbox', { name: 'Message piop' }).waitFor();
  return next;
}

export async function trackBrowserStorage(page) {
  await page.evaluate(installBrowserStorageTracking);
}

function installBrowserStorageTracking() {
  if (window.savedDraft) return;
  const pending = new Set(), failures = [];
  const track = (operation, event) => {
    const complete = new Promise((resolve, reject) => {
      operation.addEventListener(event, resolve, { once: true });
      operation.addEventListener('error', () => reject(operation.error), { once: true });
      operation.addEventListener('abort', () => reject(operation.error), { once: true });
    });
    pending.add(complete);
    complete.then(() => pending.delete(complete), error => { failures.push(error); pending.delete(complete); });
    return operation;
  };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) { return track(open.apply(this, args), 'success'); };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) { return track(transaction.apply(this, args), 'complete'); };
  window.savedDraft = async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try { document.dispatchEvent(new Event('visibilitychange')); }
    finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete document.visibilityState;
    }
    do {
      await Promise.all([...pending]);
      await new Promise(resolve => requestAnimationFrame(resolve));
    } while (pending.size);
    if (failures.length) throw failures[0];
  };
}
