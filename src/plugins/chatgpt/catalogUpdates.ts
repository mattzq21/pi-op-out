import { onCleanup, type Accessor } from "solid-js";
import { z } from "zod";
import { listen } from "../../lib/platform";
import { createDependencyEffect } from "../../lib/solid";

export function watchChatGptCatalog(provider: Accessor<string>, open: Accessor<boolean>, refresh: (catalog: boolean) => Promise<void>, reconnect: () => void) {
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

  const changes = listen("pi://chatgpt-changed", ({ payload }) => {
    if (payload.hostId === "local" && payload.providerId === provider()) schedule(payload.scope === "catalog");
  }, z.object({ hostId: z.string(), providerId: z.string(), scope: z.enum(["chats", "catalog"]) }));

  const accounts = listen("pi://provider-auth-changed", ({ payload }) => {
    if (payload.hostId === "local") schedule(true);
  }, z.object({ hostId: z.string() }));

  const restored = listen("pi://event", ({ payload }) => {
    if (!disposed && payload.type === "connection_restored") { reconnect(); schedule(true); }
  }, z.object({ type: z.string().optional() }).passthrough());

  createDependencyEffect(() => { if (open()) schedule(true); }, () => [open()]);
  onCleanup(() => {
    disposed = true; clearTimeout(timer);

    for (const listener of [changes, accounts, restored]) void listener.then(stop => stop()).catch(() => undefined);
  });

  for (const listener of [changes, accounts, restored]) void listener.catch(() => undefined);
}
