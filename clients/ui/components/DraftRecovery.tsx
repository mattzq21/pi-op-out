import { For, Show, createSignal } from "solid-js";
import type { createConversationDrafts } from "../appDrafts";
import type { DraftDestination } from "../lib/draftState";
import type { SessionSummary } from "../types";
import { goalPreparationSchema } from "../lib/draftSubmission";
import type { z } from "zod";

function destinationSession(destination: DraftDestination): SessionSummary {
  return { id: destination.key.slice(destination.hostId.length + 1), hostId: destination.hostId, path: destination.sessionPath ?? "", cwd: destination.cwd ?? "", isDraft: !destination.sessionPath, name: "Recovered submission", preview: "", project: destination.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Temporary chat", messageCount: 0, lastMessageAt: Date.now(), apiCost: 0 };
}

interface Props {
  conversationKey: string;
  drafts: ReturnType<typeof createConversationDrafts>;
  onSelect: (session: SessionSummary) => void;
}

export function DraftRecovery(props: Props) {
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [preparedGoals, setPreparedGoals] = createSignal<Map<string, z.infer<typeof goalPreparationSchema> | null>>(new Map());
  const recoveries = () => props.drafts.recoveries().filter(item => item.destination.key === props.conversationKey);

  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError(undefined);

    try { await work(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <Show when={recoveries().length}>
    <aside aria-label="Interrupted messages" style={{ padding: "12px", "max-height": "35vh", overflow: "auto" }}>
      <Show when={error()}><div role="alert">{error()}</div></Show>
      <For each={recoveries()}>{submission => <details>
        <summary>{submission.status === "uncertain" ? "Submission may have been accepted" : "Interrupted submission"} · {submission.rawText.slice(0, 60) || "Attachments"}</summary>
        <p>{submission.destination.hostId} · {submission.destination.cwd ?? "Temporary chat"} · {new Date(submission.createdAt).toLocaleString()}</p>
        <p>{submission.status === "uncertain" ? "Check the conversation before restoring and sending again. This submission will not resend automatically." : "Restore this input to continue sending it."}</p>
        <Show when={submission.error}><p>{submission.error}</p></Show>
        <pre style={{ "white-space": "pre-wrap" }}>{submission.rawText}</pre>
        <For each={submission.uploads}>{upload => <span>{upload.name} ({Math.ceil(upload.byteSize / 1024)} KB) </span>}</For>
        <div>
          <button disabled={busy()} onClick={() => props.onSelect(destinationSession(submission.destination))}>Open conversation</button>
          <Show when={submission.rawText.includes("/goal")}><button disabled={busy()} onClick={() => void action(async () => { const prepared = await props.drafts.inspectGoalPreparation(submission); setPreparedGoals(current => new Map(current).set(submission.id, prepared)); })}>View prepared goal</button></Show>
          <button disabled={busy()} onClick={() => void action(async () => { await props.drafts.restoreSubmission(submission); props.onSelect(destinationSession(submission.destination)); })}>Restore input</button>
          <button disabled={busy()} onClick={() => void action(() => props.drafts.retireSubmission(submission.id))}>Discard submission</button>
        </div>
        <Show when={preparedGoals().has(submission.id)}><div role="status">
          <Show when={preparedGoals().get(submission.id)} fallback={<p>No saved goal preparation was found for this submission.</p>}>{prepared => <>
            <p>{prepared().sessionSaved ? "This objective was prepared and saved. Check its conversation before retrying the original input." : "The goal files are saved, but its conversation has not been published. Restore the original input to retry using these files."}</p>
            <pre style={{ "white-space": "pre-wrap" }}>{prepared().objective}</pre>
            <Show when={prepared().sessionSaved}><button disabled={busy()} onClick={() => props.onSelect({ ...destinationSession(submission.destination), id: prepared().sessionId, path: prepared().sessionPath ?? "", cwd: prepared().cwd, isDraft: false, name: "Prepared goal", preview: prepared().objective })}>Open prepared conversation</button></Show>
          </>}</Show>
        </div></Show>
      </details>}</For>
    </aside>
  </Show>;
}
