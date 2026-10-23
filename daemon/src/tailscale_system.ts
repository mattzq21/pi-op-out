import { execFile } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Socket } from 'node:net';
import { errorText } from './util/sync';

export function run(program: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve, rejectRun) => {
    execFile(program, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout) => {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) { rejectRun(error); return; }
      if (error && error.killed) { rejectRun(Object.assign(new Error('timeout'), { timeout: true })); return; }
      resolve({ ok: !error, stdout: String(stdout) });
    });
  });
}

/** Linux socket option values: SOL_SOCKET level and the SO_PEERCRED option. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

type GetSockOpt = (fd: number, level: number, option: number, value: any, length: any) => number;
let getsockopt: GetSockOpt | undefined;

/** Loads getsockopt from the C library (glibc or musl) through bun:ffi. */
function loadGetsockopt(): GetSockOpt {
  if (getsockopt) return getsockopt;
  let failure: unknown;
  for (const name of ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
    try {
      const library = dlopen(name, { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
      getsockopt = library.symbols.getsockopt as GetSockOpt;
      return getsockopt;
    } catch (error) { failure = error; }
  }
  throw new Error('Cannot load the C library to read socket credentials: ' + errorText(failure));
}

/** Reads the process and user identity of the other end of a unix socket. */
export async function peerCredentials(socket: Socket): Promise<{ pid: number; uid: number }> {
  const fd = (socket as any)._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw new Error('Missing proxy peer socket');
  // struct ucred is three 32-bit integers: pid, uid, gid.
  const credentials = new Int32Array(3);
  const length = new Uint32Array([credentials.byteLength]);
  const result = loadGetsockopt()(fd, SOL_SOCKET, SO_PEERCRED, ptr(credentials), ptr(length));
  if (result !== 0 || length[0] !== credentials.byteLength) throw new Error('Missing proxy peer PID');
  return { pid: credentials[0]!, uid: credentials[1]! };
}

