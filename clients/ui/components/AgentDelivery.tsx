import { createMemo, Show, useContext, type JSXElement } from "solid-js";
import { z } from "zod";
import type { ChatMessage } from "../types";
import { textOf } from "../lib/content";
import { SessionLinkContext } from "../lib/subagentNavigation";
import { Markdown } from "./Markdown";

const deliverySchema = z.object({ sourceSessionId: z.string(), sourceHostId: z.string(), message: z.string() });

function parseDelivery(content: ChatMessage["content"]) {
  try { return deliverySchema.parse(JSON.parse(textOf(content))); }
  catch { return { sourceSessionId: "", sourceHostId: "", message: textOf(content) }; }
}

/** A message from another agent session, shown like a sent message, with a link to the session that sent it. */
/** actions: the time and copy bar under the message, given the text the sender wrote. */
export function AgentDelivery(props: { message: ChatMessage; actions?: (text: string) => JSXElement }) {
  const delivery = createMemo(() => parseDelivery(props.message.content));
  const links = useContext(SessionLinkContext);
  const name = createMemo(() => links?.name(delivery().sourceHostId || "local", delivery().sourceSessionId));

  return <article class="message user-message agent-delivery" aria-label="Message from another agent">
    <Show when={name()} fallback={<span class="agent-delivery-source">Unknown session</span>}>{sessionName => <button type="button" class="agent-delivery-source" onClick={() => links?.open(delivery().sourceHostId || "local", delivery().sourceSessionId)}>{sessionName()}</button>}</Show>
    <div class="message-body"><Markdown>{delivery().message}</Markdown></div>
    {props.actions?.(delivery().message)}
  </article>;
}
