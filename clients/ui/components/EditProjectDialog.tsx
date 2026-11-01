import { createSignal, createUniqueId, lazy, Match, Show, Switch } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";
import type { NativeTransport } from "../lib/nativeTransport";
import type { SessionGroup } from "../lib/sessionGroups";

const ProjectDialog = lazy(() => import("./ProjectDialog").then(module => ({ default: module.ProjectDialog })));

type Step = "edit" | "confirm" | "saving" | "saved";

interface Props {
  project: SessionGroup;
  transport: NativeTransport;
  validateName: (name: string, id: string) => string | undefined;
  onSave: (name: string, cwd: string) => Promise<unknown>;
  onClose: () => void;
}

export function EditProjectDialog(props: Props) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const hostId = props.project.hostId ?? "local";
  const [name, setName] = createSignal(props.project.name);
  const [cwd, setCwd] = createSignal(props.project.cwd ?? "");
  const [step, setStep] = createSignal<Step>("edit");
  const [error, setError] = createSignal<string>();
  const [browsing, setBrowsing] = createSignal(false);
  const titleId = createUniqueId();
  createDependencyEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();

    return () => { dialog?.close(); returnFocus?.focus(); };
  }, () => []);

  const trimmedName = () => name().trim();
  const nameChanged = () => trimmedName() !== props.project.name;
  const cwdChanged = () => cwd() !== props.project.cwd;

  const review = () => {
    const invalid = nameChanged() ? props.validateName(trimmedName(), props.project.id) : undefined;

    if (invalid) { setError(invalid); return; }
    setError(undefined); setStep("confirm");
  };

  const save = async () => {
    if (step() !== "confirm") return;
    setStep("saving"); setError(undefined);

    try { await props.onSave(trimmedName(), cwd()); setStep("saved"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setStep("confirm"); }
  };

  const close = () => { if (step() !== "saving") props.onClose(); };

  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog missing-directory-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}>
    <Switch>
      <Match when={step() === "edit"}>
        <h2 id={titleId}>Edit project “{props.project.name}”</h2>
        <label class="field"><span>Name</span><input autofocus value={name()} onInput={(event) => { setName(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); review(); } }} /></label>
        <div class="field"><span>Directory</span><code class="missing-directory-path">{cwd()}</code></div>
        {error() && <p class="dialog-error" role="alert">{error()}</p>}
        <div class="dialog-actions"><button class="browse-directory" onClick={() => setBrowsing(true)}>Change directory</button><button onClick={close}>Cancel</button><button class="primary-button" disabled={!nameChanged() && !cwdChanged()} onClick={review}>Save</button></div>
      </Match>
      <Match when={step() === "confirm" || step() === "saving"}>
        <h2 id={titleId}>Save changes to “{props.project.name}”?</h2>
        {nameChanged() && <p>Name: {props.project.name} → {trimmedName()}</p>}
        {cwdChanged() && <><p>Directory:</p><code class="missing-directory-path">{props.project.cwd}</code><p>→</p><code class="missing-directory-path">{cwd()}</code><p>Existing chats keep their directories. New chats in this project start in the new directory.</p></>}
        {error() && <p class="dialog-error" role="alert">Could not save the project: {error()}</p>}
        {step() === "saving" && <p role="status">Saving…</p>}
        <div class="dialog-actions"><button disabled={step() === "saving"} onClick={() => { setError(undefined); setStep("edit"); }}>Back</button><button class="primary-button" autofocus disabled={step() === "saving"} onClick={() => void save()}>{error() ? "Try again" : "Save changes"}</button></div>
      </Match>
      <Match when={step() === "saved"}>
        <h2 id={titleId}>Project saved</h2>
        <p role="status">The changes to “{trimmedName()}” are saved.</p>
        <div class="dialog-actions"><button class="primary-button" autofocus onClick={close}>Done</button></div>
      </Match>
    </Switch>
    <Show when={browsing()}><ProjectDialog initialPath={cwd()} hostId={hostId} onHomeDirectory={id => props.transport.homeDirectory(id)} onChooseDirectory={(path, id) => props.transport.listDirectories(id, path || undefined)} onOpen={async path => { setCwd(path); setError(undefined); setBrowsing(false); }} onCancel={() => setBrowsing(false)} /></Show>
  </dialog>;
}
