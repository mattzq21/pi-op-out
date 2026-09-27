import { createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import type { GitWorktree } from "../lib/nativeTransport";

interface Props {
  projectPath: string;
  beforePrompt?: boolean;
  fromProject?: boolean;
  onCreate: (name: string, onSetup: (cancel: (() => Promise<void>) | undefined) => void) => Promise<GitWorktree>;
  onCancel: () => void;
}

export function WorktreeDialog(componentProps: Props) {
  const dialogRef = createRef<HTMLDialogElement>(null);
  const returnFocusRef = createRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [creating, setCreating] = createSignal(false);
  const creatingRef = createRef(false);
  const [cancelSetup, setCancelSetup] = createSignal<() => Promise<void>>();
  const [cancelling, setCancelling] = createSignal(false);
  const cancellingRef = createRef(false);
  const cancel = async () => { const capturedCancelSetup = cancelSetup(); const capturedOnCancel0 = componentProps.onCancel;
    if (!creatingRef.current) { capturedOnCancel0(); return; }
    if (!capturedCancelSetup || cancellingRef.current) return;
    cancellingRef.current = true; setCancelling(true);
    try { await (capturedCancelSetup)!(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); cancellingRef.current = false; setCancelling(false); }
  };

  createDependencyEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); }; }, () => []);

  const create = async () => { const capturedName = name(); const capturedOnCreate0 = componentProps.onCreate;
    if (creatingRef.current) return;
    const suffix = capturedName.trim();
    if (!suffix) { setError("Branch name can't be empty"); return; }
    creatingRef.current = true; setCreating(true); setError(undefined); cancellingRef.current = false; setCancelling(false);
    try { await capturedOnCreate0(suffix, (cancel) => setCancelSetup(() => cancel)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); creatingRef.current = false; setCreating(false); cancellingRef.current = false; setCancelling(false); setCancelSetup(undefined); }
  };

  const renderDescription = () => (<p>{(componentProps.fromProject === undefined ? false : componentProps.fromProject) ? "Create a matching branch and worktree from this project’s current commit, then run your environment setup scripts." : (componentProps.beforePrompt === undefined ? false : componentProps.beforePrompt) ? "Create a worktree and fork the conversation from before this response’s prompt. Restore the prompt and its attachments as a draft." : "Create a branch and worktree from this response’s settled commit and conversation."}</p>);
  const renderCancelSetup = () => (cancelSetup() && <p role="status">{cancelling() ? "Stopping environment setup…" : "Running environment setup. Cancelling keeps the created worktree."}</p>);
  const renderDialogActions = () => (<div class="dialog-actions"><button disabled={cancelling() || (creating() && !cancelSetup())} onClick={() => void cancel()}>{cancelSetup() ? "Cancel setup" : "Cancel"}</button><button class="primary-button" disabled={creating()} onClick={() => void create()}>{creating() ? "Creating…" : "Create worktree"}</button></div>);
  return <dialog ref={element => { dialogRef.current = element; }} class="extension-dialog" aria-labelledby="worktree-dialog-title" onCancel={(event) => { event.preventDefault(); void cancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (!creatingRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) componentProps.onCancel(); }}>
    <p class="eyebrow">Git</p><h2 id="worktree-dialog-title">Create worktree</h2>{renderDescription()}
    <input autofocus aria-label="Branch name" value={name()} placeholder="Branch name" disabled={creating()} onInput={(event) => { setName(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) void create(); }} />
    {name().trim() && <p class="worktree-preview" title={componentProps.projectPath}>Branch: <code>parent|{name().trim()}</code>. The current branch is the parent.</p>}
    {error() && <p class="dialog-error" role="alert">{(error())!}</p>}
    {renderCancelSetup()}
    {renderDialogActions()}
  </dialog>;
}
