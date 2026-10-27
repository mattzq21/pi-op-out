import { spawn } from 'node:child_process';

/** Starts a hidden Xvfb screen; close() stops it. */
export function startHiddenDisplay() {
  return new Promise((resolve, reject) => {
    const server = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '3840x2160x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const stop = () => server.kill();
    server.stderr.on('data', chunk => { errors += chunk; });
    server.stdio[3].on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      server.stdio[3].unref?.();
      resolve({ name: ':' + output.trim(), close: () => { process.off('exit', stop); stop(); } });
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Xvfb exited with ' + code + ': ' + errors)));
    server.unref();
    server.stderr.unref?.();
    process.once('exit', stop);
  });
}

let shared;

/** One hidden screen for the whole test process, so test windows never appear on, or take focus from, the desktop. */
export async function hiddenDisplay() {
  shared ??= startHiddenDisplay();
  return (await shared).name;
}

/** The environment of a GUI child process on a hidden screen, the shared one by default. */
export async function hiddenDisplayEnv(env = process.env, display) {
  const result = { ...env, DISPLAY: display ?? await hiddenDisplay(), GDK_BACKEND: 'x11' };
  delete result.WAYLAND_DISPLAY;
  return result;
}
