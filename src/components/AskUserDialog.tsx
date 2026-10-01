import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../types";
import { z } from "zod";
import { ArrowRight, CircleHelp, Pencil, X } from "lucide-solid";
import { DictationControls } from "./DictationControls";

type Question = { id: string; header: string; question: string; options: { label: string; description: string }[] };

type Answer = { selected: number; notes: string };

const questionsSchema = z.object({
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
  })),
});

export function isAskUserRequest(request: ExtensionUiRequest) {
  return request.method === "input" && request.title === "__piop_request_user_input__";
}

function readQuestions(request: ExtensionUiRequest): Question[] {
  try {
    return questionsSchema.parse(JSON.parse(request.placeholder ?? "{}")).questions;
  } catch { return []; }
}

export function createQuestionDraft(request: ExtensionUiRequest) {
  return { index: createSignal(0), answers: createSignal<Answer[]>(readQuestions(request).map(() => ({ selected: -1, notes: "" }))) };
}

export function AskUserDialog(props: { request: ExtensionUiRequest; owner?: string; draft?: ReturnType<typeof createQuestionDraft>; onRespond: (response: ExtensionUiResponse) => void | Promise<void> }) {
  const questions = readQuestions(props.request);
  const { index: [index, setIndex], answers: [answers, setAnswers] } = props.draft ?? createQuestionDraft(props.request);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(questions.length ? "" : "The question request is invalid. Cancel to let the agent retry.");
  const titleId = createUniqueId();
  const answer = () => answers()[index()];
  const update = (change: Partial<Answer>) => setAnswers((current) => current.map((item, i) => i === index() ? { ...item, ...change } : item));

  const respond = async (response: ExtensionUiResponse) => {
    if (busy()) return;
    setBusy(true); setError("");

    try { await props.onRespond(response); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const submit = () => {
    if (index() < questions.length - 1) { setIndex(index() + 1);

    return; }

    const result = Object.fromEntries(questions.map((question, i) => {
      const { selected, notes } = answers()[i];
      const values = selected >= 0 ? [question.options[selected].label] : [];

      if (notes.trim()) values.push(notes.trim());

      return [question.id, { answers: values }];
    }));

    void respond({ value: JSON.stringify({ answers: result }) });
  };

  const choose = (selected: number) => { update({ selected, notes: "" }); submit(); };

  const skip = () => { update({ selected: -1, notes: "" }); submit(); };

  const write = (notes: string) => update({ selected: -1, notes });

  return <section class="ask-user-dialog" aria-labelledby={titleId} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void respond({ cancelled: true }); } }}>
    <header class="ask-user-header"><CircleHelp size={13} /><span title={props.owner}>Question</span>
      <Show when={questions.length > 1}><span class="ask-user-progress">{index() + 1} of {questions.length}</span></Show>
      <button type="button" class="ask-user-close" aria-label="Close question" disabled={busy()} onClick={() => void respond({ cancelled: true })}><X size={14} /></button>
    </header>
    <Show when={questions[index()]}>{(question) => <form onSubmit={(event) => { event.preventDefault();

    if (answer().notes.trim()) submit(); }}>
      <h2 id={titleId}>{question().question}</h2>
      <fieldset disabled={busy()} class="ask-user-options" aria-labelledby={titleId}>
        <For each={question().options}>{(option, optionIndex) =>
          <button type="button" class="ask-user-option" classList={{ suggested: optionIndex() === 0 && !answer().notes }} title={option.description} onClick={() => choose(optionIndex())}>
            <span class="ask-user-number" aria-hidden="true">{optionIndex() + 1}</span>
            <span class="ask-user-label">{option.label}</span><ArrowRight class="ask-user-arrow" size={16} />
          </button>
        }</For>
      </fieldset>
      <Show when={error()}><p class="dialog-error" role="alert">{error()}</p></Show>
      <div class="ask-user-footer">
        <label class="ask-user-response"><span class="ask-user-number" aria-hidden="true"><Pencil size={12} /></span>
          <input aria-label="Your response" placeholder="Or write your own response" disabled={busy()} value={answer().notes} onInput={(event) => write(event.currentTarget.value)} />
        </label>
        <Show when={question()} keyed>{(_question) => <DictationControls compact disabled={busy()} onText={(text) => write([answer().notes, text].filter(Boolean).join(" "))} />}</Show>
        <Show when={index() > 0}><button class="ask-user-secondary" type="button" disabled={busy()} onClick={() => setIndex(index() - 1)}>Back</button></Show>
        <button class="ask-user-secondary" type="button" disabled={busy()} onClick={skip}>Skip</button>
        <button type="submit" class="ask-user-send" disabled={busy() || !answer().notes.trim()}>{index() === questions.length - 1 ? "Send" : "Next"}</button>
      </div>
    </form>}</Show>
    <Show when={!questions.length}><p id={titleId} role="alert">{error()}</p><button disabled={busy()} onClick={() => void respond({ cancelled: true })}>Cancel</button></Show>
  </section>;
}
