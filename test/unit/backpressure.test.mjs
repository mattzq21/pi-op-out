import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from '../dom.mjs';
import { mockIPC } from '../mock-ipc.mjs';
import { invoke } from '../../src/lib/platform.ts';

test('desktop daemon requests recover from explicit busy rejections', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  let attempts = 0;
  mockIPC(command => {
    assert.equal(command, 'home_directory');
    attempts++;

    if (attempts <= 2) throw 'Host is busy; try again';

    return '/home/test';
  });

  try {
    const result = invoke('home_directory', { hostId: 'local' }).catch(error => ({ error: String(error) }));

    for (let tick = 0; tick < 4; tick++) {
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(1000);
    }

    assert.equal(await result, '/home/test');
    assert.equal(attempts, 3);
  } finally { dom.restore(); }
});

test('desktop requests surface persistent saturation after seven attempts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = installDom();
  let attempts = 0;
  mockIPC(() => { attempts++; throw 'Host is busy; try again'; });

  try {
    const rejection = assert.rejects(invoke('home_directory'), reason => reason === 'Host is busy; try again');

    for (let tick = 0; tick < 8; tick++) {
      await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.tick(1000);
    }

    await rejection;
    assert.equal(attempts, 7);
  } finally { dom.restore(); }
});

test('desktop mutations are never retried after an ambiguous timeout', async () => {
  const dom = installDom();
  let attempts = 0;
  mockIPC(() => { attempts++; throw 'Timed out; the command may have completed'; });

  try {
    await assert.rejects(invoke('shared_terminal', { action: 'write', data: 'one command\r' }), reason => /may have completed/.test(String(reason)));
    assert.equal(attempts, 1);
  } finally { dom.restore(); }
});
