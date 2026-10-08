import { onCleanup, type Accessor } from "solid-js";
import type { NativeTransport } from "../lib/nativeTransport";
import { SessionRuntimePool, useTurnDiffs } from "../lib/sessionRuntimePool";
import { useChatSession } from "../lib/useChatSession";
import type { AgentState } from "../types";
import { conversationSource } from "./transcript";
import type { PluginConversation } from "./types";

export function followConversation(pool: SessionRuntimePool, transport: NativeTransport, initialState: AgentState): Accessor<PluginConversation> {
  onCleanup(pool.observe(transport));
  const session = useChatSession(() => transport, () => initialState);
  const gitDiffs = useTurnDiffs(() => pool, () => transport);
  let stopped = false;
  let reconnecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const following = () => !stopped && !pool.isInteractive(transport) && !pool.isActive(transport);
  const refresh = () => { void session.refresh().catch(() => undefined); };

  const scheduleReconnect = (delay: number) => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = undefined; void reconnect(); }, delay);
  };

  const reconnect = async () => {
    if (!following()) return;

    if (reconnecting) { scheduleReconnect(100);

    return; }

    reconnecting = true;

    try {
      await transport.connect();

      if (!following()) return;
      await session.refresh();

      if (!following()) return;
      await pool.refreshSavedDiffs(transport, transport.currentSessionPath());
    } catch {
      if (following()) scheduleReconnect(2000);
    } finally { reconnecting = false; }
  };

  const unsubscribe = transport.subscribe(event => {
    if (!following()) return;
    session.handleEvent(event);

    if (event.type === "disconnected" || event.type === "connection_restored") { scheduleReconnect(50);

    return; }

    if (["message_end", "agent_settled", "session_info_changed", "session_switched", "settings_applied"].includes(event.type)) refresh();
  });

  onCleanup(() => { stopped = true; clearTimeout(retryTimer); unsubscribe(); });
  scheduleReconnect(0);

  return conversationSource(() => transport.currentHostId(), () => session, gitDiffs);
}
