import { createSignal, createUniqueId, Show } from "solid-js";
import { z } from "zod";
import { agentProfileSchema } from "../lib/agentSchemas";
import { copyText } from "../lib/clipboard";
import { createDependencyEffect, createRef } from "../lib/solid";
import type { AgentProfile } from "../types";

const transferSchema = z.object({ agents: z.array(agentProfileSchema.omit({ unavailableReason: true, project: true, isDefault: true })).min(1) });

function exportText(agents: AgentProfile[]) {
  return JSON.stringify({ agents: agents.map(({ unavailableReason: _reason, project: _project, isDefault: _default, ...agent }) => agent) }, null, 2);
}

function parseImport(text: string): AgentProfile[] {
  let value: unknown;

  try { value = JSON.parse(text); } catch (reason) { throw new Error(`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`); }
  const parsed = transferSchema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }

  const names = parsed.data.agents.map(agent => agent.name.toLowerCase());
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (repeated) throw new Error(`Agent name “${repeated}” is used more than once`);

  return parsed.data.agents;
}

/** Replaces drafts with the same name (case-insensitive) and keeps their default flag; adds the others. */
export function mergeImportedAgents(current: AgentProfile[], imported: AgentProfile[]) {
  const next = [...current];
  const changed: number[] = [];

  for (const agent of imported) {
    const index = next.findIndex(item => item.name.toLowerCase() === agent.name.toLowerCase());

    if (index < 0) { changed.push(next.length); next.push(agent); continue; }
    next[index] = next[index].isDefault ? { ...agent, isDefault: true } : agent;
    changed.push(index);
  }

  return { agents: next, changed };
}

export function AgentTransferDialog(props: { mode: "export" | "import"; agents: AgentProfile[]; onImport: (agents: AgentProfile[]) => void; onClose: () => void }) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const fileRef = createRef<HTMLInputElement>(null);
  const titleId = createUniqueId();
  const [text, setText] = createSignal(props.mode === "export" ? exportText(props.agents) : "");
  const [error, setError] = createSignal<string>();
  const [copied, setCopied] = createSignal(false);

  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();

    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);

  const copy = async () => {
    setError(undefined);

    try { await copyText(text()); setCopied(true); } catch (reason) { setError(`Could not copy: ${reason instanceof Error ? reason.message : String(reason)}`); }
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);

    try { setText(await file.text()); } catch (reason) { setError(`Could not read ${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`); }
  };

  const confirmImport = () => {
    try { props.onImport(parseImport(text())); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); props.onClose(); }}>
    <h2 id={titleId}>{props.mode === "export" ? "Export agents" : "Import agents"}</h2>
    <p>{props.mode === "export" ? "Agent definitions of this scope as JSON." : "Paste JSON or open a file. Agents with the same name are replaced. Save settings to keep the changes."}</p>
    <textarea class="mcp-json" rows={14} spellcheck={false} aria-label="Agent definitions JSON" aria-invalid={Boolean(error())} readOnly={props.mode === "export"} placeholder={'{ "agents": [ … ] }'} value={text()} onInput={event => { setText(event.currentTarget.value); setError(undefined); }} />
    <Show when={error()}>{message => <p class="dialog-error" role="alert">{message()}</p>}</Show>
    <div class="dialog-actions">
      <Show when={props.mode === "import"}>
        <input ref={element => { fileRef.current = element; }} type="file" accept=".json,application/json" hidden onChange={event => { void openFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
        <button type="button" class="browse-directory" onClick={() => fileRef.current?.click()}>Open file</button>
      </Show>
      <button type="button" onClick={props.onClose}>{props.mode === "export" ? "Close" : "Cancel"}</button>
      <Show when={props.mode === "export"} fallback={<button type="button" class="primary-button" disabled={!text().trim()} onClick={confirmImport}>Import</button>}>
        <button type="button" class="primary-button" autofocus onClick={() => void copy()}>{copied() ? "Copied" : "Copy"}</button>
      </Show>
    </div>
  </dialog>;
}
