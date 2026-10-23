import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startupPage } from '../startup-browser-fixture.mjs';
import { daemonClient } from '../daemon-client.mjs';

describe('terminal input ownership', { concurrency: 4 }, () => {
for (const interaction of ['none', 'typing', 'paste', 'composition']) {
  test(`startup cursor reply does not count as user input: ${interaction}`, { timeout: 30000 }, async t => {
    let page;
    const pending = new Set();
    const failures = [];
    const daemon = await daemonClient(t, (event, payload) => {
      if (!page || event !== 'pi://event') return;
      const task = page.evaluate(({ event, payload }) => window.deliverTerminalEvent?.(event, payload), { event, payload });
      pending.add(task);
      task.then(() => pending.delete(task), error => { pending.delete(task); failures.push(error); });
    });
    const home = await daemon.invoke('home_directory', { hostId: 'local' });
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    await writeFile(join(home, '.bashrc'), 'exec bash --norc ./.terminal-script\n');
    await writeFile(join(chat.cwd, '.terminal-script'), "echo $$ > shell.pid\nstty -echo\nprintf '\\033[6n'\nIFS= read -r -d R reply\nprintf 'CURSOR-REPLY:%sR\\n' \"$reply\"\nwhile IFS= read -r line; do printf 'INPUT:%s\\n' \"$line\"; done\n");
    page = await startupPage(t, 'development', {
      entryPoint: 'test/fixtures/terminal-unused-browser.tsx', ready: '.xterm-screen', readyTimeout: 30000, holdStorage: false,
      prepare: async browserPage => {
        page = browserPage;
        await page.exposeFunction('terminalChat', () => chat);
        await page.exposeFunction('terminalCommand', (command, args) => {
          assert.equal(command, 'daemon_invoke');
          return daemon.invoke(args.command, args.args);
        });
      },
    });
    t.after(async () => { page = undefined; await Promise.allSettled([...pending]); assert.deepEqual(failures, []); });
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.textContent.includes('CURSOR-REPLY:'));
    const pid = Number(await readFile(join(chat.cwd, 'shell.pid'), 'utf8'));
    const textarea = page.locator('.xterm-helper-textarea');
    if (interaction === 'typing') { await textarea.focus(); await page.keyboard.type('hello'); }
    if (interaction === 'paste') {
      await textarea.evaluate(element => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'hello');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
      });
    }
    if (interaction === 'composition') {
      await textarea.evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        element.value = 'hello';
        element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello', bubbles: true }));
        element.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello', bubbles: true }));
      });
    }
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Closed"]').textContent === 'true');
    assert.equal(await page.getByLabel('Errors').textContent(), '[]');
    if (interaction === 'none') assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    else assert.doesNotThrow(() => process.kill(pid, 0));
  });
}
});
