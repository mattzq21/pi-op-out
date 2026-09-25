import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { ExtensionUiRequest } from "../types";
import { createDependencyEffect } from "../lib/solid";

type Question = { id: string; header: string; question: string; options: { label: string; description: string }[] };
type Answer = { selected: number; notes: string };

export function isAskUserRequest(request: ExtensionUiRequest) {
  return request.method === "input" && request.title === "__piop_request_user_input__";
}

function readQuestions(request: ExtensionUiRequest): Question[] {
  try {
    const { questions } = JSON.parse(request.placeholder ?? "{}");
    if (!Array.isArray(questions) || !questions.length || questions.length > 3) return [];
    return questions.every(validQuestion) ? questions : [];
  } catch { return []; }
}

function validQuestion(value: Question) {
  return value && [value.id, value.header, value.question].every((item) => typeof item === "string")
    && Array.isArray(value.options) && value.options.length > 0
    && value.options.every((option) => option && typeof option.label === "string" && typeof option.description === "string");
}

export function AskUserDialog(props: { request: ExtensionUiRequest; owner?: string; onRespond: (response: Record<string, unknown>) => void | Promise<void> }) {
  const questions = readQuestions(props.request);
  const [index, setIndex] = createSignal(0);
  const [answers, setAnswers] = createSignal<Answer[]>(questions.map(() => ({ selected: 0, notes: "" })));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(questions.length ? "" : "The question request is invalid. Cancel to let the agent retry.");
  const titleId = createUniqueId();
  let dialog!: HTMLDialogElement;
  const previousFocus = document.activeElement;
  createDependencyEffect(() => {
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, () => []);
  const answer = () => answers()[index()];
  const update = (change: Partial<Answer>) => setAnswers((current) => current.map((item, i) => i === index() ? { ...item, ...change } : item));
  const respond = async (response: Record<string, unknown>) => {
    if (busy()) return;
    setBusy(true); setError("");
    try { await props.onRespond(response); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const submit = () => {
    if (index() < questions.length - 1) { setIndex(index() + 1); return; }
    const result = Object.fromEntries(questions.map((question, i) => {
      const { selected, notes } = answers()[i];
      const values = [question.options[selected]?.label ?? "None of the above"];
      if (notes.trim()) values.push(`user_note: ${notes.trim()}`);
      return [question.id, { answers: values }];
    }));
    void respond({ value: JSON.stringify({ answers: result }) });
  };
  return <dialog ref={dialog} class="extension-dialog ask-user-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); void respond({ cancelled: true }); }}>
    <p class="eyebrow">Input requested{props.owner ? ` · ${props.owner}` : ""}</p>
    <Show when={questions[index()]}>{(question) => <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <p class="ask-user-progress">{question().header} · {index() + 1} of {questions.length}</p>
      <h2 id={titleId}>{question().question}</h2>
      <fieldset disabled={busy()} class="ask-user-options" aria-labelledby={titleId}>
        <For each={[...question().options, { label: "None of the above", description: "Add your own answer in the notes below." }]}>{(option, optionIndex) =>
          <label class="ask-user-option" classList={{ selected: answer().selected === optionIndex() }}>
            <input type="radio" name={`${titleId}-option`} checked={answer().selected === optionIndex()} onChange={() => update({ selected: optionIndex() })} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        }</For>
        <label class="ask-user-notes">{answer().selected === question().options.length ? "Your answer" : "Add notes (optional)"}
          <textarea rows={3} value={answer().notes} onInput={(event) => update({ notes: event.currentTarget.value })} />
        </label>
      </fieldset>
      <Show when={error()}><p class="dialog-error" role="alert">{error()}</p></Show>
      <div class="dialog-actions">
        <button type="button" disabled={busy()} onClick={() => void respond({ cancelled: true })}>Cancel</button>
        <Show when={index() > 0}><button type="button" disabled={busy()} onClick={() => setIndex(index() - 1)}>Back</button></Show>
        <button type="submit" class="primary-button" disabled={busy()}>{index() === questions.length - 1 ? "Submit answers" : "Next"}</button>
      </div>
    </form>}</Show>
    <Show when={!questions.length}><p id={titleId} role="alert">{error()}</p><button disabled={busy()} onClick={() => void respond({ cancelled: true })}>Cancel</button></Show>
  </dialog>;
}
