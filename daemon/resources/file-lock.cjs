const { spawn, spawnSync } = require('node:child_process');

let libc;
function nativeLock(fd, shared = false, nonblocking = false) {
  if (!libc) {
    const module = 'bun:ffi';
    const { dlopen, read } = require(module);
    const library = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' }, __errno_location: { args: [], returns: 'ptr' } });
    const errno = library.symbols.__errno_location();
    if (!errno) throw new Error('Could not get flock errno address');
    libc = { library, read, errno };
  }
  let error;
  do { error = libc.library.symbols.flock(fd, (shared ? 1 : 2) | (nonblocking ? 4 : 0)) === 0 ? 0 : libc.read.i32(libc.errno); } while (error === 4);
  if (error === 11) return false;
  if (error) throw new Error(`flock failed (errno ${error})`);
  return true;
}

const nativeSource = "let libc;\nfunction nativeLock(fd, shared = false, nonblocking = false) {\n  if (!libc) {\n    const module = 'bun:ffi';\n    const { dlopen, read } = require(module);\n    const library = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' }, __errno_location: { args: [], returns: 'ptr' } });\n    const errno = library.symbols.__errno_location();\n    if (!errno) throw new Error('Could not get flock errno address');\n    libc = { library, read, errno };\n  }\n  let error;\n  do { error = libc.library.symbols.flock(fd, (shared ? 1 : 2) | (nonblocking ? 4 : 0)) === 0 ? 0 : libc.read.i32(libc.errno); } while (error === 4);\n  if (error === 11) return false;\n  if (error) throw new Error(`flock failed (errno ${error})`);\n  return true;\n}";
const helperSource = `${nativeSource}
const [fd, shared, nonblocking, wait] = process.argv.slice(1).map(Number);
try {
  if (wait) {
    const source = ${JSON.stringify(nativeSource)} + '; self.onmessage = ({data}) => { try { self.postMessage(nativeLock(...data)); } catch (error) { self.postMessage({error: error.message}); } };';
    const url = URL.createObjectURL(new Blob([source], {type: 'application/javascript'}));
    const worker = new Worker(url);
    setTimeout(() => process.exit(75), wait);
    worker.onmessage = ({data}) => { if (data?.error) { console.error(data.error); process.exit(1); } process.exit(data ? 0 : 75); };
    worker.onerror = event => { console.error(event.message); process.exit(1); };
    worker.postMessage([fd, !!shared, !!nonblocking]);
  } else process.exit(nativeLock(fd, !!shared, !!nonblocking) ? 0 : 75);
} catch (error) { console.error(error.message); process.exit(1); }
`;

function bunExecutable() { return process.versions.bun ? process.execPath : process.env.PIOP_BUN || 'bun'; }
function invocation(shared = false, nonblocking = false, wait = 0, fd = 3) {
  return ['-e', helperSource, String(fd), String(+shared), String(+nonblocking), String(wait)];
}
function result(status, stderr) {
  if (status === 0) return true;
  if (status === 75) return false;
  throw new Error(stderr.trim() || 'Could not acquire file lock');
}
function lockSync(fd, shared = false, nonblocking = false, timeout = 0) {
  if (process.versions.bun) return nativeLock(fd, shared, nonblocking);
  const child = spawnSync(bunExecutable(), invocation(shared, nonblocking), { env: { ...process.env, BUN_BE_BUN: '1' }, timeout, stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (child.error) throw child.error;
  return result(child.status, child.stderr.toString());
}
async function lock(fd, shared = false, nonblocking = false, wait = 0) {
  if (process.versions.bun) {
    const acquired = nativeLock(fd, shared, true);
    if (acquired || nonblocking) return acquired;
  }
  return new Promise((resolve, reject) => {
    const bunTimedWait = !!process.versions.bun && !!wait;
    const child = spawn(bunExecutable(), invocation(shared, nonblocking, bunTimedWait ? 0 : wait), { timeout: wait ? wait + 5000 : nonblocking ? 5000 : 0, killSignal: 'SIGKILL', env: { ...process.env, BUN_BE_BUN: '1' }, stdio: ['ignore', 'ignore', 'pipe', fd] });
    const errors = [];
    let failure, timedOut = false;
    child.once('error', error => { failure = error; });
    child.stderr?.on('data', chunk => errors.push(chunk));
    child.stderr?.on('error', error => { failure = error; child.kill('SIGKILL'); });
    const timer = bunTimedWait ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, wait) : undefined;
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      try {
        if (failure) throw failure;
        if (timedOut && (status === 0 || signal === 'SIGKILL')) resolve(lockSync(fd, shared, true));
        else if (status === 75 && wait) resolve(lockSync(fd, shared, true));
        else resolve(result(status, Buffer.concat(errors).toString()));
      } catch (error) { reject(error); }
    });
  });
}
function shellLock(fd, nonblocking = false, wait = 0) {
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  return `BUN_BE_BUN=1 "$PIOP_BUN" ${invocation(false, nonblocking, wait, fd).map(quote).join(' ')}`;
}

module.exports = { lockSync, lock, bunExecutable, shellLock };
