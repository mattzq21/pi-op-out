import { For, Show } from "solid-js";
import { toastHistory, toastHistoryError } from "../lib/toastHistory";

export function ToastHistory() {
  return <div class="settings-section">
    <div class="section-title"><div><h2>Toast history</h2><p>The latest 10 toasts on this client, including dismissed messages.</p></div></div>
    <Show when={toastHistoryError()}>{message => <p class="storage-error" role="alert">{message()}</p>}</Show>
    <div class="toast-history">
      <For each={[...toastHistory()].reverse()} fallback={<p class="empty-small">No toasts recorded yet.</p>}>{entry =>
        <article class="toast-history-entry">
          <strong>{entry.title}</strong>
          <small><time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time> · {entry.source}</small>
          <p>{entry.message}</p>
        </article>
      }</For>
    </div>
  </div>;
}
