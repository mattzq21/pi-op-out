import { createComputed, createSignal, onCleanup, untrack } from "solid-js";
import { parseCap } from "../../../extensions/piop-context-window-cap/interface";

type Props = { label: string; placeholder: string; value: number | null | undefined; onChange: (value: number | null | undefined) => void; onError: (error: string | undefined) => void };

const formatCap = (value: number | null | undefined) => value === undefined ? "" : value === null ? "model_default" : value % 1_000_000 === 0 ? value / 1_000_000 + "m" : value % 1000 === 0 ? value / 1000 + "k" : String(value);

/** Reads empty text as inherit, model_default as the model's own window, or a token count such as 500k. */
function readCap(text: string): { value: number | null | undefined; error?: string } {
  const trimmed = text.trim();

  if (!trimmed) return { value: undefined };

  if (trimmed === "model_default") return { value: null };

  try { return { value: parseCap(trimmed) }; } catch (error) { return { value: undefined, error: error instanceof Error ? error.message : String(error) }; }
}

export function CapInput(props: Props) {
  const [text, setText] = createSignal(formatCap(props.value));
  const [error, setError] = createSignal<string>();

  createComputed(() => {
    const value = props.value;
    const current = readCap(untrack(text));

    if (current.error === undefined && current.value !== value) { setText(formatCap(value)); setError(undefined); }
  });
  onCleanup(() => props.onError(undefined));

  const input = (next: string) => {
    setText(next);
    const result = readCap(next);
    setError(result.error);
    props.onError(result.error);

    if (result.error === undefined) props.onChange(result.value);
  };

  return <input class="setting-cap" aria-label={props.label} aria-invalid={error() !== undefined} title={error() ?? "Empty inherits. Use a token count such as 500k or 0.75m, or model_default."} placeholder={props.placeholder} value={text()} onInput={event => input(event.currentTarget.value)} />;
}
