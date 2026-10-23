import { createMemo, createSignal } from "solid-js";
import { textOf } from "../../lib/content";
import { createDependencyEffect } from "../../lib/solid";
import type { SplitPaneControls } from "../types";

export function ReviewFeedback(props: SplitPaneControls & { messageMain: (message: string) => Promise<void> }) {
  const [queued, setQueued] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal<string>();

  const feedback = createMemo(() => {
    const messages = props.messages();

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];

      if (message.role === "user") return undefined;

      if (message.role !== "assistant") continue;

      return !message.streaming && (message.stopReason === "stop" || message.stopReason === "length") && textOf(message.content).trim() ? message : undefined;
    }

    return undefined;
  });

  const key = () => { const message = feedback();

  return message ? `${props.state().sessionId}:${message.timestamp}:${textOf(message.content)}` : undefined; };

  const deliver = async () => {
    const message = feedback(); const current = key();

    if (!props.connected() || props.busy() || !message || sending() || sent() === current) return;
    setQueued(false); setSending(true);

    try { await props.messageMain(textOf(message.content)); setSent(current); }
    catch (reason) { props.reportError(reason); }
    finally { setSending(false); }
  };

  const click = () => {
    if (queued()) { setQueued(false);

    return; }

    if (props.busy()) setQueued(true);
    else void deliver();
  };

  createDependencyEffect(() => {
    if (!queued() || !props.connected() || props.busy()) return;
    setQueued(false);

    if (feedback()) void deliver();
    else props.reportError(new Error("The review stopped without completed feedback. Run it again or finish the review before sending."));
  }, () => [queued(), props.connected(), props.busy(), feedback()]);
  createDependencyEffect(() => { setQueued(false); setSent(undefined); }, () => [props.paneKey()]);

  const label = () => sending() ? "Sending…" : queued() ? "Cancel auto-send" : props.busy() ? "Send when done" : sent() && sent() === key() ? "Feedback sent" : "Send feedback";
  const disabled = () => sending() || (!queued() && (!props.connected() || (!props.busy() && (!feedback() || sent() === key()))));

  return <button type="button" class="review-feedback-button" aria-pressed={queued()} disabled={disabled()} onClick={click}>{label()}</button>;
}
