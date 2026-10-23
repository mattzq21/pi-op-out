import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';

async function resumePage(t) {
  return startupPage(t, 'development', {
    entryPoint: 'test/fixtures/session-resume-browser.tsx', ready: '#root', holdStorage: false,
    prepare: async page => {
      await page.addInitScript(() => {
        const pending = new Set();
        const track = (target, event) => {
          const settled = new Promise(resolve => {
            target.addEventListener(event, resolve, { once: true });
            target.addEventListener('error', resolve, { once: true });
            target.addEventListener('abort', resolve, { once: true });
          });
          pending.add(settled);
          settled.then(() => pending.delete(settled));
          return target;
        };
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (...args) { return track(open.apply(this, args), 'success'); };
        const transaction = IDBDatabase.prototype.transaction;
        let nextRead;
        window.watchResumeRead = () => { window.resumeRead = new Promise(resolve => { nextRead = resolve; }); };
        IDBDatabase.prototype.transaction = function (...args) {
          const result = track(transaction.apply(this, args), 'complete');
          if (args[1] === 'readonly' && nextRead) {
            const done = nextRead; nextRead = undefined;
            result.addEventListener('complete', done, { once: true });
          }
          return result;
        };
        window.settleResumeStorage = async () => { while (pending.size) await Promise.all([...pending]); };
      });
    },
  });
}

test('a new unsent conversation is not resumed and never points at a nonexistent session file', async t => {
  const page = await resumePage(t);
  await page.getByText('Resume ready', { exact: true }).waitFor();
  const target = { hostId: 'remote', cwd: '/project', sessionId: 'saved', sessionPath: '/saved.jsonl' };
  await page.evaluate(target => window.selectResume({ ready: true, saved: true, target }), target);
  await page.evaluate(() => window.settleResumeStorage());
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), target);
  await page.reload();
  await page.getByText('Resume ready', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), target);
  await page.evaluate(() => window.selectResume({ ready: true, saved: false, target: {
    hostId: 'remote', cwd: '/project', sessionId: 'unsaved', sessionPath: '/not-yet-created.jsonl', draftKey: 'remote:unsaved',
  } }));
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), {});
  assert.deepEqual(await page.evaluate(() => window.resumeTarget({ cwd: '/fallback' })), { cwd: '/fallback' });
  await page.evaluate(() => window.settleResumeStorage());
  await page.reload();
  await page.getByText('Resume ready', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), {});
  assert.deepEqual(await page.evaluate(() => window.resumeTarget({ cwd: '/fallback' })), { cwd: '/fallback' });
});

test('an invalid saved target reports the error and keeps the last usable target', async t => {
  const page = await resumePage(t);
  await page.getByText('Resume ready', { exact: true }).waitFor();
  const target = { hostId: 'local', cwd: '/project', sessionId: 'saved', sessionPath: '/saved.jsonl' };
  await page.evaluate(target => window.selectResume({ ready: true, saved: true, target }), target);
  await page.evaluate(() => window.settleResumeStorage());
  const reported = page.waitForEvent('console', { predicate: message => message.type() === 'error' && message.text().includes('Could not save the last conversation') });
  await page.evaluate(() => window.selectResume({ ready: true, saved: true, target: { hostId: 'local', sessionId: 'new', sessionPath: '/new.jsonl' } }));
  await reported;
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), target);
});

test('saved session restoration ignores unready selections, follows other windows and rejects damaged records', async t => {
  const page = await resumePage(t);
  await page.getByText('Resume ready', { exact: true }).waitFor();
  const target = { cwd: '/project', hostId: 'local', sessionId: 'saved', sessionPath: '/saved.jsonl' };
  await page.evaluate(target => window.selectResume({ ready: true, saved: true, target }), target);
  await page.evaluate(() => window.settleResumeStorage());
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), target);
  await page.evaluate(() => window.selectResume({ ready: false, saved: false, target: {} }));
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), target);
  await page.evaluate(() => window.selectResume({ ready: true, saved: true, target: { cwd: '/project', hostId: 'local', sessionId: 'no-path' } }));
  assert.deepEqual(await page.evaluate(() => window.resumeTarget()), {});
  await page.evaluate(() => window.settleResumeStorage());
  await page.evaluate(target => window.selectResume({ ready: true, saved: true, target }), target);
  await page.evaluate(() => window.settleResumeStorage());
  const second = await page.context().newPage();
  const pageErrors = [];
  second.on('pageerror', error => pageErrors.push(String(error)));
  try {
    await second.goto(page.url());
    await second.getByText('Resume ready', { exact: true }).waitFor();
    assert.deepEqual(await second.evaluate(() => window.resumeTarget()), target);
    const elsewhere = { cwd: '/other', hostId: 'remote', sessionId: 'elsewhere', sessionPath: '/elsewhere.jsonl' };
    await page.evaluate(() => window.watchResumeRead());
    await second.evaluate(target => window.selectResume({ ready: true, saved: true, target }), elsewhere);
    await page.evaluate(() => window.resumeRead);
    assert.deepEqual(await page.evaluate(() => window.resumeTarget()), elsewhere);
    await second.reload();
    await second.getByText('Resume ready', { exact: true }).waitFor();
    assert.deepEqual(await second.evaluate(() => window.resumeTarget()), elsewhere);
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluate(() => {
      const getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        IDBObjectStore.prototype.getAll = getAll;
        const request = getAll.apply(this, args);
        request.addEventListener('success', () => Object.defineProperty(request, 'result', { value: [{ damaged: true }] }), { once: true });
        return request;
      };
    });
    const reported = page.waitForEvent('console', { predicate: message => message.type() === 'error' && message.text().includes('Could not refresh saved conversations') });
    await second.evaluate(() => window.selectResume({ ready: true, saved: true, target: { cwd: '/latest', hostId: 'local', sessionId: 'latest', sessionPath: '/latest.jsonl' } }));
    await reported;
    assert.deepEqual(await page.evaluate(() => window.resumeTarget()), elsewhere);
    assert.equal(errors.length, 1);
    assert.deepEqual(pageErrors, []);
  } finally { await second.close(); }
});
