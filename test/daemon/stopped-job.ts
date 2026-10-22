import { createServer, type Socket } from 'node:net';

export async function stoppedJob(file: string, jobs: Array<() => Promise<void>>) {
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('data', () => started.resolve());
    socket.once('end', () => ended.resolve());
    socket.on('error', error => { started.reject(error); ended.reject(error); });
  });
  // Both promises can fail before the test starts waiting for them.
  void started.promise.catch(() => {}); void ended.promise.catch(() => {});
  jobs.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  const within = async (promise: Promise<void>, description: string) => {
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), 5000); })]); }
    finally { clearTimeout(timer!); }
  };
  return {
    // The shell and sleep both hold the connection. It ends only after both release it.
    command: `exec 3<>/dev/tcp/127.0.0.1/${port}; sleep 300 & child=$!; printf ready >&3; wait "$child"; echo done > ${file}`,
    started: () => within(started.promise, 'The shell command did not start'),
    stopped: () => within(ended.promise, 'The shell or its child is still running'),
  };
}

