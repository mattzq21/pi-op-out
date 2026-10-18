import { reportBackgroundError } from "../lib/backgroundErrors";
import { createRoot, getOwner, onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { useSessionMemory } from "../lib/sessionMemory";
import { SessionRuntimePool } from "../lib/sessionRuntimePool";
import { useChatSession } from "../lib/useChatSession";
import type { AgentState } from "../types";
import { conversationSource } from "./transcript";
import type { PluginConversation } from "./types";

export function followConversation(pool: SessionRuntimePool, transport: NativeTransport, initialState: AgentState): Accessor<PluginConversation> {
  onCleanup(pool.observe(transport));
  const memory = useSessionMemory(() => transport, () => initialState);

  const owner = getOwner();
  let session: ReturnType<typeof useChatSession> | undefined;
  let disposeSession: (() => void) | undefined;
  let stopped = false;
  let reconnecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wait before the next reconnect after a failure. It doubles up to 30 seconds and resets after a success. */
  let retryDelay = 2000;
  const following = () => !stopped && !pool.isInteractive(transport) && !pool.isActive(transport);
  const ownsSession = (current: ReturnType<typeof useChatSession>) => following() && session === current;
  const refresh = () => { void session?.refresh().catch((reason: unknown) => reportBackgroundError("Could not refresh the followed conversation", reason)); };

  const scheduleReconnect = (delay: number) => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = undefined; void reconnect(); }, delay);
  };

  const reconnect = async () => {
    const current = session;

    if (!following() || !current) return;

    if (reconnecting) { scheduleReconnect(100);

    return; }

    reconnecting = true;

    try {
      await transport.connect();

      if (!ownsSession(current)) return;
      await current.refresh();

      if (!ownsSession(current)) return;
      retryDelay = 2000;
    } catch (reason) {
      if (!ownsSession(current)) return;
      console.error(`Could not reconnect the followed conversation. Trying again in ${retryDelay / 1000} seconds:`, reason);
      scheduleReconnect(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally { reconnecting = false; }
  };

  const updateView = () => {
    if (!following()) {
      clearTimeout(retryTimer);
      const dispose = disposeSession;
      disposeSession = undefined; session = undefined; dispose?.();

      return;
    }

    if (session) return;
    session = createRoot(dispose => {
      disposeSession = dispose;

      return useChatSession(() => transport, () => initialState);
    }, owner);
    scheduleReconnect(0);
  };

  const unsubscribeView = pool.subscribe(updateView);
  updateView();

  const unsubscribe = transport.subscribe(event => {
    if (!following()) return;
    session?.handleEvent(event);

    if (event.type === "disconnected" || event.type === "connection_restored") { scheduleReconnect(50);

    return; }

    if (["message_end", "agent_settled", "session_info_changed", "session_switched", "settings_applied"].includes(event.type)) refresh();
  });

  onCleanup(() => { stopped = true; clearTimeout(retryTimer); unsubscribe(); unsubscribeView(); disposeSession?.(); });

  return conversationSource(() => transport.currentHostId(), () => memory);
}
