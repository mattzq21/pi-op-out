import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { currentTest, pauseTestClock } from './test-clock.mjs';

/**
 * Daemon slots shared by every test process on this machine, so parallel tests do not start more daemons than the
 * machine can run. One slot per two cores: a daemon with its Pi sessions and a test browser use about two.
 */
export const DAEMON_SLOTS = Math.max(2, Math.floor(availableParallelism() / 2));

/**
 * Takes count slots for test daemons and returns their release.
 * Only a test that holds no slots waits, and its wait does not count in its timeout. A test that already holds slots,
 * and code outside a test such as a beforeAll hook, takes the free slots and runs on without the rest. So no holder
 * ever waits, and tests that start several daemons one after another cannot deadlock.
 */
export async function takeDaemonSlots(count) {
  const directory = process.env.PIOP_TEST_DAEMON_SLOTS;
  if (!directory) throw new Error('Run tests that start daemons with python3 scripts/test-run.py, which shares the daemon slots');
  const owner = currentTest();
  const mode = owner && owner.slots === 0 ? 'wait' : 'try';
  const holder = spawn('python3', [fileURLToPath(new URL('./daemon-slots.py', import.meta.url)), directory, String(DAEMON_SLOTS), String(count), mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  holder.stderr.on('data', data => { diagnostics += data; });
  const exited = new Promise(resolve => holder.once('exit', (code, signal) => resolve({ code, signal })));
  if (owner) owner.slots++;
  const resume = mode === 'wait' ? pauseTestClock() : () => {};
  try {
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      exited.then(result => reject(new Error('Daemon slot holder ended before it held its slots: ' + JSON.stringify(result) + '\n' + diagnostics)));
      createInterface({ input: holder.stdout }).once('line', line => line === 'ready' ? resolve() : reject(new Error('Daemon slot holder: ' + line + '\n' + diagnostics)));
    });
  } catch (error) {
    if (owner) owner.slots--;
    holder.kill('SIGKILL');
    throw error;
  } finally { resume(); }
  let released;
  return () => released ??= (async () => {
    if (owner) owner.slots--;
    holder.stdin.end();
    const result = await exited;
    if (result.code !== 0) throw new Error('Daemon slot holder failed: ' + JSON.stringify(result) + '\n' + diagnostics);
  })();
}
