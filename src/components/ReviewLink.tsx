import { createContext, createSignal, useContext } from "solid-js";
import { z } from "zod";

const reviewLinkSchema = z.object({ sessionId: z.string().optional(), parentSessionId: z.string().optional() });

export const ReviewNavigationContext = createContext<{ sessionId: () => string | undefined; open: (id: string) => Promise<void> }>();

export function ReviewLink(props: { details: unknown }) {
  const navigation = useContext(ReviewNavigationContext);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const record = () => reviewLinkSchema.catch({}).parse(props.details);
  const inherited = () => Boolean(record().parentSessionId && navigation?.sessionId() && record().parentSessionId !== navigation.sessionId());

  const show = async () => {
    const id = record().sessionId;

    if (!navigation || !id || inherited() || busy()) return;
    setBusy(true); setError(undefined);

    try { await navigation.open(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div class="command-result">{inherited() ? <span>Code review belongs to the original conversation.</span> : <button type="button" disabled={!navigation || !record().sessionId || !navigation.sessionId() || busy()} onClick={() => void show()}>{busy() ? "Opening review…" : "Open review"}</button>}{error() && <span role="alert">{error()}</span>}</div>;
}
