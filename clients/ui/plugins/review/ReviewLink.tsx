import { createSignal, useContext } from "solid-js";
import { z } from "zod";
import { PluginMessageContext } from "../messages";

const reviewLinkSchema = z.object({ sessionId: z.string().optional(), parentSessionId: z.string().optional() });

export function ReviewLink(props: { details: unknown }) {
  const conversation = useContext(PluginMessageContext);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const record = () => reviewLinkSchema.catch({}).parse(props.details);
  const inherited = () => Boolean(record().parentSessionId && conversation?.sessionId() && record().parentSessionId !== conversation.sessionId());

  const show = async () => {
    const id = record().sessionId;

    if (!conversation || !id || inherited() || busy()) return;
    setBusy(true); setError(undefined);

    try { await conversation.command({ type: "open_review", reviewId: id }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div class="command-result">{inherited() ? <span>Code review belongs to the original conversation.</span> : <button type="button" disabled={!conversation || !record().sessionId || !conversation.sessionId() || busy()} onClick={() => void show()}>{busy() ? "Opening review…" : "Open review"}</button>}{error() && <span role="alert">{error()}</span>}</div>;
}
