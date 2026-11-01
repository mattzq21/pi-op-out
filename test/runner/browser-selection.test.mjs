import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('unselected mobile-terminal tests do not start a browser', async () => {
  const env = { ...process.env, PIOP_TEST_BROWSER: 'chromium', CHROME_BIN: '/no-such-piop-test-browser' };
  delete env.NODE_TEST_CONTEXT;
  const result = await execute(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=^no selected mobile terminal tests$',
    'test/unit/mobile-terminal-scroll-browser.test.mjs',
  ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), env, timeout: 15000 });
  assert.match(result.stdout, /^1\.\.0$/m);
});
