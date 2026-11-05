import { read } from 'bun:ffi';
import { closeSync, readFileSync } from 'node:fs';
import { libcName, loadLibc } from './libc';

// Waits for processes to end without checking them again and again: a pidfd (a file descriptor for a process) becomes
// readable when its process ends, and a worker thread waits for that in poll.

const SYS_PIDFD_OPEN = 434;
const ESRCH = 3;

export interface ProcessIdentity { pid: number; started: string }

let libc: ReturnType<typeof load> | undefined;

function load() {
  const library = loadLibc({
    syscall: { args: ['i64', 'i64', 'i64'], returns: 'i64' },
    __errno_location: { args: [], returns: 'ptr' },
  });
  const errno = library.symbols.__errno_location();
  if (!errno) throw new Error('Could not get the errno address');
  return { library, errno };
}

// The start time of a running process, as /proc gives it; undefined when it ended or is a zombie.
export function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const index = stat.lastIndexOf(')');
    if (index < 0) return undefined;
    const fields = stat.slice(index + 1).trim().split(/\s+/);
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch { return undefined; }
}

// A pidfd of the process, or undefined when it has already ended.
function open({ pid, started }: ProcessIdentity): number | undefined {
  const { library, errno } = libc ??= load();
  const fd = Number(library.symbols.syscall(SYS_PIDFD_OPEN, pid, 0));
  if (fd < 0) {
    const error = read.i32(errno);
    if (error === ESRCH) return undefined;
    throw new Error('pidfd_open failed for process ' + pid + ' (errno ' + error + ')');
  }
  // The number can belong to a new process by now; then the one asked for has ended.
  if (startTime(pid) !== started) { closeSync(fd); return undefined; }
  return fd;
}

function workerSource(): string {
  return `
import { dlopen, ptr } from 'bun:ffi';
const library = dlopen(${JSON.stringify(libcName())}, { poll: { args: ['ptr', 'u64', 'i32'], returns: 'i32' } });
const POLLIN = 1;
self.onmessage = ({ data: { fds, ms } }) => {
  const deadline = Date.now() + ms;
  let open = fds;
  while (open.length) {
    const wait = deadline - Date.now();
    if (wait <= 0) break;
    const table = new Int32Array(open.length * 2);
    open.forEach((fd, index) => { table[index * 2] = fd; table[index * 2 + 1] = POLLIN; });
    library.symbols.poll(ptr(table), open.length, Math.min(wait, 2_147_483_647));
    const events = new Int16Array(table.buffer);
    open = open.filter((_, index) => events[index * 4 + 3] === 0);
  }
  self.postMessage(open.length);
};
`;
}

// True when every process ended within ms.
export async function processesEnded(processes: ProcessIdentity[], ms: number): Promise<boolean> {
  const fds = processes.map(open).filter((fd): fd is number => fd !== undefined);
  if (!fds.length) return true;
  const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
  const worker = new Worker(url);
  try {
    const remaining = await new Promise<number>((resolve, reject) => {
      worker.onmessage = ({ data }) => Number.isInteger(data) ? resolve(data) : reject(new Error('Invalid process wait result'));
      worker.onerror = event => reject(new Error('The process wait failed: ' + event.message));
      worker.postMessage({ fds, ms });
    });
    return remaining === 0;
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
    for (const fd of fds) closeSync(fd);
  }
}
