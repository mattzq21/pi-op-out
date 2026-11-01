import { For, useContext } from "solid-js";
import { SessionLinkContext } from "../lib/subagentNavigation";
import type { FieldSegment } from "./composerField";

export function PendingMessageText(props: { segments: FieldSegment[] }) {
  const sessionLinks = useContext(SessionLinkContext);

  return <For each={props.segments}>{value => {
    if ("text" in value) return <>{value.text}</>;

    if ("skill" in value) return <span class="composer-skill">{value.skill}</span>;

    return sessionLinks
      ? <button type="button" class="message-link" onClick={(event) => { event.stopPropagation(); sessionLinks.open(value.hostId, value.sessionId, event.currentTarget); }}>{value.label}</button>
      : <span class="message-link">{value.label}</span>;
  }}</For>;
}
