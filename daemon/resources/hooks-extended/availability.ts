import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const waitKey = Symbol.for("piop.wait-for-idle");

export function availability(pi: ExtensionAPI, publish: (ctx: ExtensionContext) => Promise<void>) {
  let generation = 0;
  let watching: object | undefined;
  const cancellations = new Set<(error: Error) => void>();

  const reset = () => {
    generation++;
    watching = undefined;
    for (const cancel of cancellations) cancel(new Error("Session ended before it became available"));
    cancellations.clear();
  };

  const wait = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.isIdle()) return;
    const nativeWait = Object.getOwnPropertyDescriptor(ctx, waitKey)?.value as (() => Promise<void>) | undefined;
    if (!nativeWait) throw new Error("Piop's runtime idle wait is unavailable");
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
    cancellations.add(cancel);
    try {
      do { await Promise.race([nativeWait(), cancelled]); } while (!ctx.isIdle());
    } finally { cancellations.delete(cancel); }
  };

  const watch = (ctx: ExtensionContext) => {
    if (watching) return;
    const token = watching = {};
    const version = generation;
    void wait(ctx).then(async () => {
      if (version !== generation) return;
      if (watching === token) watching = undefined;
      await publish(ctx);
    }).catch(error => {
      if (version === generation) ctx.ui.notify(`Session availability failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => { if (watching === token) watching = undefined; });
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_start", (_event, ctx) => watch(ctx));
  pi.on("session_before_compact", (_event, ctx) => watch(ctx));
  pi.on("session_before_tree", (_event, ctx) => watch(ctx));
  return { wait };
}
