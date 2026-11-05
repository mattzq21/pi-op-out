import { connect } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { readLines } from '../resources/lf-lines.cjs';

// The pipe between the processes of a daemon restart: the daemon and its restart coordinator, and the coordinator and
// the new daemon. Each side sends JSON lines. The pipe closes when either process ends, so no side waits for a dead one.
export interface RestartLink {
  send(message: Record<string, unknown>): void;
  // Calls receive for each message, and closed once when the other side is gone.
  listen(receive: (message: any) => void, closed: () => void): void;
  close(): void;
}

function link(stream: Duplex): RestartLink {
  // A message to a process that already ended is lost on purpose: the receiver of each message checks that the sender lives.
  stream.on('error', () => {});
  return {
    send: message => { if (stream.writable) stream.write(JSON.stringify(message) + '\n'); },
    listen: (receive, closed) => {
      let ended = false;
      const end = () => { if (!ended) { ended = true; closed(); } };
      readLines(stream, line => { try { receive(JSON.parse(line)); } catch (error) { console.error('Ignored an invalid restart message: ' + String(error)); } }, end);
      stream.once('close', end);
    },
    // Sends what is still queued, then closes this side.
    close: () => { stream.end(); },
  };
}

// The link of a process that the daemon or the coordinator started with `link: true`.
export function childLink(child: ChildProcess): RestartLink {
  const stream = child.stdio[4] as Duplex | null | undefined;
  if (!stream) throw new Error('The restart process has no link');
  return link(stream);
}

// The link of this process to the process that started it, once.
export function parentLink(): RestartLink {
  const fd = process.env.PIOP_RESTART_LINK_FD;
  delete process.env.PIOP_RESTART_LINK_FD;
  if (fd !== '4') throw new Error('This restart process has no link to the process that started it');
  return link(connect({ fd: 4 } as any));
}

// Waits for the first message that decide accepts (returns a value other than undefined), or rejects when the link
// closes or the time ends.
export function waitFor<T>(restartLink: RestartLink, decide: (message: any) => T | undefined, closedError: () => Error, timeoutMs: number, timeoutError: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutError))), timeoutMs);
    const finish = (settle: () => void) => { if (done) return; done = true; clearTimeout(timer); settle(); };
    restartLink.listen(message => {
      let value: T | undefined;
      try { value = decide(message); } catch (error) { finish(() => reject(error)); return; }
      if (value !== undefined) finish(() => resolve(value as T));
    }, () => finish(() => reject(closedError())));
  });
}
