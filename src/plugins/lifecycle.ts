type PluginFlush = (enabled?: readonly string[]) => Promise<void>;

const flushers = new Map<string, Set<PluginFlush>>();

export function registerPluginFlush(host: string, flush: PluginFlush) {
  const callbacks = flushers.get(host) ?? new Set();
  flushers.set(host, callbacks);
  callbacks.add(flush);

  return () => { callbacks.delete(flush);

  if (!callbacks.size) flushers.delete(host); };
}

export async function flushPlugins(host: string, enabled?: readonly string[]) {
  await Promise.all([...(flushers.get(host) ?? [])].map(flush => flush(enabled)));
}

export async function flushAllPlugins() {
  await Promise.all([...flushers.keys()].map(host => flushPlugins(host)));
}
