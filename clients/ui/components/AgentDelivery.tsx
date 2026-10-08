import { createMemo } from "solid-js";
import { z } from "zod";
import type { ChatMessage } from "../types";
import { textOf } from "../lib/content";
import { Markdown } from "./Markdown";

const deliverySchema = z.object({ sourceSessionId: z.string(), sourceHostId: z.string(), message: z.string() });

function parseDelivery(content: ChatMessage["content"]) {
  try { return deliverySchema.parse(JSON.parse(textOf(content))); }
  catch { return { sourceSessionId: "unknown", sourceHostId: "", message: textOf(content) }; }
}

export function AgentDelivery(props: { message: ChatMessage }) {
  const delivery = createMemo(() => parseDelivery(props.message.content));

  return <article class="message assistant-message" aria-label="Message from another agent"><div class="message-body"><small>Agent message · {delivery().sourceHostId}/{delivery().sourceSessionId}</small><Markdown>{delivery().message}</Markdown></div></article>;
}
