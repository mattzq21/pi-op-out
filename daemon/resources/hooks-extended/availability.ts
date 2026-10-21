import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const waitKey = Symbol.for("piop.wait-for-idle");

export function availability(pi: ExtensionAPI, publish: (ctx: ExtensionContext, signal: AbortSignal) => Promise<void>) {
  let generation = 0;
  let lifetime = new AbortController();
  const observed = new WeakSet<AbortSignal>();
  let watching: object | undefined;
  const cancellations = new Set<(error: Error) => void>();

  const reset = () => {
    generation++;
    lifetime.abort();
    lifetime = new AbortController();
    watching = undefined;
    for (const cancel of cancellations) cancel(new Error("Session ended before it became available"));
    cancellations.clear();
  };

  const observe = (ctx: ExtensionContext) => {
    const signal = Object.getOwnPropertyDescriptor(ctx, Symbol.for("piop.context-lifetime"))?.value as AbortSignal | undefined;
    signal?.throwIfAborted();
    if (signal && !observed.has(signal)) {
      observed.add(signal);
      signal.addEventListener("abort", reset, { once: true });
    }
  };

  const wait = async (ctx: ExtensionContext): Promise<void> => {
    observe(ctx);
    if (ctx.isIdle()) return;
    const nativeWait = Object.getOwnPropertyDescriptor(ctx, waitKey)?.value as (() => Promise<void>) | undefined;
    if (!nativeWait) throw new Error("Piop's runtime idle wait is unavailable");
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
    cancellations.add(cancel);
    const signal = lifetime.signal;
    try {
      do {
        await Promise.race([nativeWait(), cancelled]);
        signal.throwIfAborted();
      } while (!ctx.isIdle());
    } finally { cancellations.delete(cancel); }
  };

  const watch = (ctx: ExtensionContext) => {
    if (watching) return;
    const token = watching = {};
    const version = generation;
    const signal = lifetime.signal;
    void wait(ctx).then(async () => {
      if (version !== generation) return;
      if (watching === token) watching = undefined;
      if (!ctx.isIdle()) { watch(ctx); return; }
      await publish(ctx, signal);
    }).catch(error => {
      const disposed = Object.getOwnPropertyDescriptor(ctx, Symbol.for("piop.context-lifetime"))?.value?.aborted;
      if (version === generation && !disposed) ctx.ui.notify(`Session availability failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => { if (watching === token) watching = undefined; });
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", (_event, ctx) => watch(ctx));
  pi.on("agent_start", (_event, ctx) => watch(ctx));
  pi.on("session_before_compact", (_event, ctx) => watch(ctx));
  pi.on("session_before_tree", (_event, ctx) => watch(ctx));
  pi.on("session_compact_failed", (_event, ctx) => watch(ctx));
  return { wait };
}
