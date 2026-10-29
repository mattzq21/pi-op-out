import { For, useContext } from "solid-js";
import { SessionLinkContext } from "../lib/subagentNavigation";
import type { Segment } from "./composerField";

/** Queued message text. Links to chats show as links that open the chat. */
export function PendingMessageText(props: { segments: Segment[] }) {
  const sessionLinks = useContext(SessionLinkContext);

  return <For each={props.segments}>{value => {
    if ("text" in value) return <>{value.text}</>;

    return sessionLinks
      ? <button type="button" class="message-link" onClick={(event) => { event.stopPropagation(); sessionLinks.open(value.hostId, value.sessionId); }}>{value.label}</button>
      : <span class="message-link">{value.label}</span>;
  }}</For>;
}
