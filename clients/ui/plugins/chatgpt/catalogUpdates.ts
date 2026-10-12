import { onCleanup, type Accessor } from "solid-js";
import { z } from "zod";
import { listen, type UnlistenFn } from "../../lib/platform";
import { createDependencyEffect } from "../../lib/solid";

export function watchChatGptCatalog(provider: Accessor<string>, open: Accessor<boolean>, refresh: (catalog: boolean) => Promise<void>, reconnect: () => void, reportError: (message?: string) => void) {
  let disposed = false;
  let running = false;
  let pending = false;
  let catalogPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (catalog: boolean) => {
    if (disposed) return;
    pending = true; catalogPending ||= catalog;

    if (!running && !timer) timer = setTimeout(() => void update(), 250);
  };

  const update = async () => {
    timer = undefined;

    if (disposed || running || !pending) return;
    running = true; pending = false;
    const catalog = catalogPending; catalogPending = false;

    try { await refresh(catalog); }
    catch { if (open()) { pending = true; catalogPending ||= catalog; } }
    finally {
      running = false;

      if (pending && !disposed) timer = setTimeout(() => void update(), 2000);
    }
  };

  const stops: UnlistenFn[] = [];
  const failures = new Map<string, string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();

  const report = () => reportError(failures.size ? `Could not listen for ChatGPT changes, so the chat list may be out of date. Retrying. ${[...failures.values()].join(" ")}` : undefined);

  /** Registers one listener. When registration fails, shows the error and tries again with a longer wait each time. */
  const subscribe = (register: () => Promise<UnlistenFn>, name: string, delay = 1000) => {
    register().then(stop => {
      if (disposed) { stop(); return; }
      stops.push(stop);

      if (failures.delete(name)) { report(); schedule(true); }
    }, reason => {
      if (disposed) return;
      failures.set(name, String(reason)); report();
      const timer = setTimeout(() => { retryTimers.delete(timer); subscribe(register, name, Math.min(delay * 2, 30000)); }, delay);
      retryTimers.add(timer);
    });
  };

  subscribe(() => listen("pi://chatgpt-changed", ({ payload }) => {
    if (payload.hostId === "local" && payload.providerId === provider()) schedule(payload.scope === "catalog");
  }, z.object({ hostId: z.string(), providerId: z.string(), scope: z.enum(["chats", "catalog"]) })), "changes");

  subscribe(() => listen("pi://provider-auth-changed", ({ payload }) => {
    if (payload.hostId === "local") schedule(true);
  }, z.object({ hostId: z.string() })), "accounts");

  subscribe(() => listen("pi://event", ({ payload }) => {
    if (!disposed && payload.type === "connection_restored") { reconnect(); schedule(true); }
  }, z.object({ type: z.string().optional() }).passthrough()), "connection");

  createDependencyEffect(() => { if (open()) schedule(true); }, () => [open()]);
  onCleanup(() => {
    disposed = true; clearTimeout(timer);

    for (const retry of retryTimers) clearTimeout(retry);

    for (const stop of stops) stop();
  });
}
