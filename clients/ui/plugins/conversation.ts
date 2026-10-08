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
  const refresh = () => { void session.refresh().catch(() => undefined); };

  const unsubscribe = transport.subscribe(event => {
    if (pool.isInteractive(transport)) return;
    session.handleEvent(event);

    if (["message_end", "agent_settled", "session_info_changed", "session_switched", "settings_applied", "connection_restored"].includes(event.type)) refresh();
  });

  onCleanup(unsubscribe);
  refresh();

  return conversationSource(() => transport.currentHostId(), () => session, gitDiffs);
}
