const flushers = new Map<string, Set<() => Promise<void>>>();

export function registerPluginFlush(host: string, flush: () => Promise<void>) {
  const callbacks = flushers.get(host) ?? new Set();
  flushers.set(host, callbacks);
  callbacks.add(flush);

  return () => { callbacks.delete(flush);

  if (!callbacks.size) flushers.delete(host); };
}

export async function flushPlugins(host: string) {
  await Promise.all([...(flushers.get(host) ?? [])].map(flush => flush()));
}
