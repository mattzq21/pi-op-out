import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupPage } from '../startup-browser-fixture.mjs';
import { nativeFileCommand } from '../native-file-command.mjs';

async function composerPage(t, long = false) {
  const native = await nativeFileCommand(t, { desktop: true });
  const page = await startupPage(t, 'development', {
    entryPoint: 'test/fixtures/composer-drag-browser.tsx', ready: '[aria-label="Pending messages"]', holdStorage: false,
    prepare: page => page.exposeFunction('nativeCommand', (command, args) => native.invoke(command, args)),
  });
  if (long) {
    await page.goto(page.url() + '?long');
    await page.getByLabel('Pending messages', { exact: true }).waitFor();
  }
  return page;
}

const handle = (page, name) => page.getByRole('button', { name: `Drag to reorder queued message: ${name}`, exact: true });
const moves = async page => JSON.parse(await page.getByLabel('Requested moves').textContent());

const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('another pointer cannot move or finish the current queued-message drag', async t => {
  const page = await composerPage(t);
  const input = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => {
      window.touchDelivered = { move: false, end: false };
      window.addEventListener('pointermove', event => { if (event.isTrusted && event.pointerType === 'touch') window.touchDelivered.move = true; });
      window.addEventListener('pointerup', event => { if (event.isTrusted && event.pointerType === 'touch') window.touchDelivered.end = true; });
    });
    await beginDrag(page);
    const retry = await handle(page, 'Retry').boundingBox();
    const third = await handle(page, 'Third').boundingBox();
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: retry.x + retry.width / 2, y: retry.y + retry.height / 2, id: 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: third.x + third.width / 2, y: third.y + third.height * .9, id: 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual(await page.evaluate(() => window.touchDelivered), { move: true, end: true });
    assert.deepEqual(await moves(page), []);
    await page.mouse.move(third.x + third.width / 2, third.y + third.height * .9, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
  } finally { await input.detach(); }
});

test('window blur stops queued-message dragging and scrolling', async t => {
  const page = await composerPage(t, true);
  const browser = await page.context().newCDPSession(page);
  await browser.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.hasFocus()), true);
  const queue = await scrollingDrag(page);
  const other = await page.context().newPage();
  try {
    await other.bringToFront();
    assert.equal(await page.evaluate(() => document.hasFocus()), false);
    const stoppedAt = await queue.evaluate(node => node.scrollTop);
    await page.bringToFront();
    await frames(page);
    await page.mouse.up();
    assert.equal(await queue.evaluate(node => node.scrollTop), stoppedAt);
    assert.deepEqual(await moves(page), []);
  } finally { await other.close(); await browser.detach(); }
});

test('pointer cancellation stops queued-message dragging and scrolling', async t => {
  const page = await composerPage(t, true);
  const input = await page.context().newCDPSession(page);
  try {
    const queue = page.getByLabel('Pending messages', { exact: true });
    const first = await handle(page, 'First').boundingBox();
    const box = await queue.boundingBox();
    const x = first.x + first.width / 2;
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: first.y + first.height / 2, id: 1 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: box.y + box.height - 5, id: 1 }] });
    await queue.evaluate(node => new Promise(resolve => {
      function check() {
        if (node.scrollTop <= 0) return;
        node.removeEventListener('scroll', check);
        resolve();
      }
      node.addEventListener('scroll', check);
      check();
    }));
    await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    const stoppedAt = await queue.evaluate(node => node.scrollTop);
    await frames(page);
    assert.equal(await queue.evaluate(node => node.scrollTop), stoppedAt);
    assert.deepEqual(await moves(page), []);
  } finally { await input.detach(); }
});

async function scrollingDrag(page) {
  const queue = page.getByLabel('Pending messages', { exact: true });
  assert.equal(await queue.evaluate(node => node.scrollHeight > node.clientHeight), true);
  const point = await beginDrag(page);
  const box = await queue.boundingBox();
  await page.mouse.move(point.x, box.y + box.height - 5, { steps: 6 });
  await queue.evaluate(node => new Promise(resolve => {
    function check() {
      if (node.scrollTop <= 0) return;
      node.removeEventListener('scroll', check);
      resolve();
    }
    node.addEventListener('scroll', check);
    check();
  }));
  return queue;
}

test('dragging near vertical queue edges scrolls toward the pointer', async t => {
  const page = await composerPage(t, true);
  const queue = await scrollingDrag(page);
  const downward = await queue.evaluate(node => node.scrollTop);
  assert.ok(downward > 0);
  const box = await queue.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 5);
  await queue.evaluate((node, previous) => new Promise(resolve => {
    function check() {
      if (node.scrollTop >= previous) return;
      node.removeEventListener('scroll', check);
      resolve();
    }
    node.addEventListener('scroll', check);
    check();
  }), downward);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await frames(page);
  const centered = await queue.evaluate(node => node.scrollTop);
  assert.ok(centered < downward);
  await frames(page);
  assert.equal(await queue.evaluate(node => node.scrollTop), centered);
  await page.mouse.move(box.x + box.width + 100, box.y + box.height - 5);
  await frames(page);
  assert.equal(await queue.evaluate(node => node.scrollTop), centered);
  await page.mouse.up();
  await frames(page);
  assert.equal(await queue.evaluate(node => node.scrollTop), centered);
  assert.deepEqual(await moves(page), []);
});

test('Escape stops queued-message dragging and scrolling', async t => {
  const page = await composerPage(t, true);
  const queue = await scrollingDrag(page);
  await page.keyboard.press('Escape');
  const stoppedAt = await queue.evaluate(node => node.scrollTop);
  await frames(page);
  await page.mouse.up();
  assert.equal(await queue.evaluate(node => node.scrollTop), stoppedAt);
  assert.deepEqual(await moves(page), []);
});

test('retry messages and other delivery queues cannot become drag targets', async t => {
  const page = await composerPage(t);
  assert.equal(await handle(page, 'Retry').isDisabled(), true);
  assert.equal(await handle(page, 'Later').isDisabled(), true);
  await beginDrag(page);
  const retry = await handle(page, 'Retry').boundingBox();
  await page.mouse.move(retry.x + retry.width / 2, retry.y + retry.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
});

async function beginDrag(page, name = 'First', button = 'left') {
  const box = await handle(page, name).boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button });
  return point;
}

test('dragging a queued message below its peers requests a move within its delivery queue', async t => {
  const page = await composerPage(t);
  const first = await handle(page, 'First').boundingBox();
  const third = await handle(page, 'Third').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * .9, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
  await page.mouse.move(first.x + first.width / 2, first.y);
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
});

test('dragging upwards requests a move before the first peer', async t => {
  const page = await composerPage(t);
  const third = await handle(page, 'Third').boundingBox();
  const first = await handle(page, 'First').boundingBox();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height * .1, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['c', { type: 'move', targetId: 'a', edge: 'before' }]]);
});

test('dropping at the current queue position does not request a move', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  const second = await handle(page, 'Second').boundingBox();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height * .1, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('small pointer movements do not reorder queued messages', async t => {
  const page = await composerPage(t);
  const point = await beginDrag(page);
  await page.mouse.move(point.x, point.y + 2);
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('a secondary mouse button does not start queued-message dragging', async t => {
  const page = await composerPage(t);
  await beginDrag(page, 'First', 'right');
  const third = await handle(page, 'Third').boundingBox();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * .9, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  assert.deepEqual(await moves(page), []);
});

test('dropping left the queue does not move a message', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  const box = await page.getByLabel('Pending messages', { exact: true }).boundingBox();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('dropping right the queue does not move a message', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  const box = await page.getByLabel('Pending messages', { exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width + 100, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('dropping above the queue does not move a message', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  const box = await page.getByLabel('Pending messages', { exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('dropping below the queue does not move a message', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  const box = await page.getByLabel('Pending messages', { exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), []);
});

test('disabled composer controls disable queued-message drag handles', async t => {
  const page = await composerPage(t);
  await page.getByRole('checkbox', { name: 'Disable controls' }).check();
  for (const name of ['First', 'Second', 'Third']) assert.equal(await handle(page, name).isDisabled(), true);
  assert.deepEqual(await moves(page), []);
});

test('a delivery queue with one message cannot be reordered', async t => {
  const page = await composerPage(t);
  assert.equal(await handle(page, 'Later').isDisabled(), true);
  assert.equal(await handle(page, 'First').isDisabled(), false);
});

test('an unrelated key leaves queued-message dragging active', async t => {
  const page = await composerPage(t);
  await beginDrag(page);
  await page.keyboard.press('a');
  const third = await handle(page, 'Third').boundingBox();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * .9, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
});

test('queued-message dragging works when pointer capture is unsupported', async t => {
  const page = await composerPage(t);
  await handle(page, 'First').evaluate(node => { node.setPointerCapture = () => { throw new DOMException('Pointer capture unavailable', 'NotSupportedError'); }; });
  await beginDrag(page);
  const third = await handle(page, 'Third').boundingBox();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height * .9, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await moves(page), [['a', { type: 'move', targetId: 'c', edge: 'after' }]]);
});

test('disabled controls stop queued-message dragging and scrolling', async t => {
  const page = await composerPage(t, true);
  const queue = await scrollingDrag(page);
  await page.getByRole('checkbox', { name: 'Disable controls' }).focus();
  await page.keyboard.press('Space');
  assert.equal(await handle(page, 'First').isDisabled(), true);
  await frames(page);
  const stoppedAt = await queue.evaluate(node => node.scrollTop);
  await frames(page);
  await page.mouse.up();
  assert.equal(await queue.evaluate(node => node.scrollTop), stoppedAt);
  assert.deepEqual(await moves(page), []);
});

test('source removal stops queued-message dragging and scrolling', async t => {
  const page = await composerPage(t, true);
  const queue = await scrollingDrag(page);
  await page.getByRole('button', { name: 'Remove first message' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await handle(page, 'First').count(), 0);
  await frames(page);
  const stoppedAt = await queue.evaluate(node => node.scrollTop);
  await frames(page);
  await page.mouse.up();
  assert.equal(await queue.evaluate(node => node.scrollTop), stoppedAt);
  assert.deepEqual(await moves(page), []);
});

test('queue controls disable moves beyond their delivery boundaries', async t => {
  const page = await composerPage(t);
  for (const name of ['Move queued message up: First', 'Move queued message down: Third', 'Move queued message up: Later', 'Move queued message down: Later']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  }
  assert.equal(await handle(page, 'Retry').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Move queued message down: First', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Move queued message up: Third', exact: true }).isEnabled(), true);
});

test('steering a queued follow-up requests earlier delivery', async t => {
  const page = await composerPage(t);
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  assert.deepEqual(await moves(page), [['other', 'steer']]);
});

test('retrying a failed queued message keeps its delivery mode', async t => {
  const page = await composerPage(t);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.deepEqual(await moves(page), [['retry', 'steer']]);
});

test('removing a queued message identifies the selected message', async t => {
  const page = await composerPage(t);
  await page.getByRole('button', { name: 'Remove queued message: Second', exact: true }).click();
  assert.deepEqual(await moves(page), [['b', 'remove']]);
});

test('double-clicking queued text expands and collapses its line wrapping', async t => {
  const page = await composerPage(t);
  await page.getByRole('button', { name: 'Use multiline message', exact: true }).click();
  const text = page.getByLabel('Pending messages', { exact: true }).getByText('First line Second line', { exact: true });
  const collapsed = await text.boundingBox();
  await text.dblclick();
  const expanded = await text.boundingBox();
  assert.ok(expanded.height > collapsed.height);
  assert.equal(await text.textContent(), 'First line\nSecond line');
  await text.dblclick();
  assert.equal((await text.boundingBox()).height, collapsed.height);
  assert.deepEqual(await moves(page), []);
});

test('queued-message actions recover after a failed move', async t => {
  const page = await composerPage(t);
  await page.getByRole('checkbox', { name: 'Hold moves', exact: true }).check();
  await page.getByRole('button', { name: 'Move queued message down: First', exact: true }).click();
  assert.deepEqual(await moves(page), [['a', 'moveDown']]);
  assert.equal(await page.getByRole('button', { name: 'Remove queued message: Second', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Fail pending move', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'queue changed' }).waitFor();
  await page.getByRole('checkbox', { name: 'Hold moves', exact: true }).uncheck();
  await handle(page, 'Second').focus();
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await moves(page), [['a', 'moveDown'], ['b', 'moveUp']]);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Remove queued message: Second', exact: true }).isEnabled(), true);
});
