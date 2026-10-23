import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { appBrowser, deliverAppEvent } from '../app-browser-fixture.mjs';
import { startupPage } from '../startup-browser-fixture.mjs';

const pageForEvents = t => startupPage(t, 'development', {
  entryPoint: 'test/fixtures/session-resume-browser.tsx', ready: '#root', holdStorage: false,
});

test('reloading a page cancels its pending event delivery without a fixture error', async t => {
  const page = await pageForEvents(t);
  await page.evaluate(() => {
    window.deliverNativeEvent = () => { window.eventStarted = true; return new Promise(() => {}); };
  });
  const delivery = deliverAppEvent(page, 'test', {}).then(() => undefined, error => error);
  await page.waitForFunction(() => window.eventStarted);
  await page.reload();
  assert.equal(await delivery, undefined);
  await page.evaluate(() => { window.deliverNativeEvent = (_event, payload) => { window.delivered = payload; }; });
  await deliverAppEvent(page, 'test', { value: 'after reload' });
  assert.deepEqual(await page.evaluate(() => window.delivered), { value: 'after reload' });
});

test('event handler errors are reported even when their text matches a navigation error', async t => {
  const page = await pageForEvents(t);
  for (const message of ['Event handler failed', 'Execution context was destroyed, most likely because of a navigation']) {
    await page.evaluate(message => {
      window.deliverNativeEvent = async () => { throw new Error(message); };
    }, message);
    await assert.rejects(deliverAppEvent(page, 'test', {}), error => error.message.includes(message));
  }
  await page.close();
  await assert.rejects(deliverAppEvent(page, 'test', {}), /closed/);
});


test('app cleanup closes its browser before stopping the services', async () => {
  const cleanup = [];
  let next = 0;
  try {
    const page = await appBrowser({ after: action => cleanup.push(action) });
    const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    const services = [];
    for (const pid of children) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (command.includes('/test/daemon/ui-host.ts') || command.includes('tests::attachment_command_bridge')) services.push(Number(pid));
    }
    assert.equal(services.length, 2);
    let servicesAlive;
    page.once('close', () => {
      servicesAlive = services.every(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    });
    await cleanup[next++]();
    assert.equal(page.isClosed(), true);
    assert.equal(servicesAlive, true, 'both services must still be running when the browser closes');
  } finally {
    const failures = [];
    while (next < cleanup.length) {
      try { await cleanup[next++](); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'App cleanup failed');
  }
});
