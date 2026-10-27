import { useContext } from "solid-js";
import { z } from "zod";
import { PluginMessageContext } from "../messages";
import { AuxiliaryChatsContext } from "../../lib/auxiliaryChats";
import { ConversationHostContext } from "../../lib/subagentNavigation";

const reviewLinkSchema = z.object({ sessionId: z.string().optional(), parentSessionId: z.string().optional(), hostId: z.string().optional() });

/** The row in the main chat that opens a review in the side pane. An archived review shows a disabled button. */
export function ReviewLink(props: { details: unknown }) {
  const conversation = useContext(PluginMessageContext);
  const chats = useContext(AuxiliaryChatsContext);
  const conversationHost = useContext(ConversationHostContext);
  const record = () => reviewLinkSchema.catch({}).parse(props.details);
  const hostId = () => record().hostId ?? conversationHost?.() ?? "local";
  const inherited = () => Boolean(record().parentSessionId && conversation?.sessionId() && record().parentSessionId !== conversation.sessionId());
  const listed = () => Boolean(chats && record().sessionId && chats.listed(hostId(), record().sessionId!));

  return <div class="command-result">{inherited() ? <span>Code review belongs to the original conversation.</span>
    : <>{!listed() && <span>Review archived</span>}<button type="button" disabled={!listed()} onClick={() => { const id = record().sessionId; if (id && listed()) chats?.open(hostId(), id); }}>Open review</button></>}</div>;
}
