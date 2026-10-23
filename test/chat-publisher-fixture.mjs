import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function chatPublisher(t, defaults) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/publish-chat.mjs', import.meta.url)), '--stream'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let diagnostics = '', failure;
  const fail = error => {
    failure ??= error;
    for (const request of pending.splice(0)) request.reject(failure);
  };
  child.stderr.on('data', data => { diagnostics += data; });
  child.on('error', fail);
  child.stdin.on('error', fail);
  createInterface({ input: child.stdout }).on('line', line => {
    const request = pending.shift();
    try {
      if (!request) throw new Error('Unexpected chat publisher response');
      request.resolve(JSON.parse(line));
    } catch (error) { request?.reject(error); fail(error); }
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    fail(new Error(`Chat publisher closed (${code ?? signal}): ${diagnostics}`));
    resolve({ code, signal });
  }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const result = await closed;
      if (result.code !== 0) throw failure;
    } finally { clearTimeout(timer); }
  });
  return (options = {}) => {
    if (failure) return Promise.reject(failure);
    const request = Promise.withResolvers();
    pending.push(request);
    const timer = setTimeout(() => {
      fail(new Error('Chat publisher did not respond within 30 seconds'));
      child.kill();
    }, 30000);
    child.stdin.write(JSON.stringify({ ...defaults, ...options }) + '\n');
    return request.promise.finally(() => clearTimeout(timer));
  };
}
