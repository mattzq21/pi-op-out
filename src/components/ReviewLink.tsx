import { createContext, createSignal, useContext } from "solid-js";
import { z } from "zod";

const reviewLinkSchema = z.object({ sessionId: z.string().optional() });

export const ReviewNavigationContext = createContext<(id: string) => Promise<void>>();

export function ReviewLink(props: { details: unknown }) {
  const open = useContext(ReviewNavigationContext);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const sessionId = () => reviewLinkSchema.catch({}).parse(props.details).sessionId;

  const show = async () => {
    const id = sessionId();

    if (!open || !id || busy()) return;
    setBusy(true); setError(undefined);

    try { await open(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div class="command-result"><button type="button" disabled={!open || !sessionId() || busy()} onClick={() => void show()}>{busy() ? "Opening review…" : "Open review"}</button>{error() && <span role="alert">{error()}</span>}</div>;
}
