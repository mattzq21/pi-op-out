import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, FolderGit2, Plus } from "lucide-solid";
import type { NativeTransport, ProjectBranches } from "../lib/nativeTransport";
import { WorktreeDialog } from "./WorktreeDialog";

function WorktreeOptions(props: { local: boolean; pending: boolean; error?: string; onLocal: () => void; onCreate: () => void; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  onMount(() => {
    const focus = document.activeElement;
    dialog.showModal();
    onCleanup(() => { dialog.close(); if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); });
  });
  return <Portal mount={document.querySelector(".app") ?? document.body}><dialog ref={dialog} class="extension-dialog worktree-picker-dialog" aria-label="Choose a worktree" onCancel={(event) => { event.preventDefault(); if (!props.pending) props.onClose(); }}>
    <h2>Choose a worktree</h2>
    <button type="button" disabled={props.pending} onClick={props.onLocal}><FolderGit2 size={16} /><span>Local<small>Main project checkout</small></span><Show when={props.local}><Check size={16} /></Show></button>
    <button type="button" disabled={props.pending} onClick={props.onCreate}><Plus size={16} /><span>Create new worktree</span></button>
    <Show when={props.error}><p class="dialog-error" role="alert">{props.error}</p></Show>
    <div class="dialog-actions"><button type="button" disabled={props.pending} onClick={props.onClose}>Cancel</button></div>
  </dialog></Portal>;
}

export function NewChatWorktreePicker(props: { transport: NativeTransport; listing: ProjectBranches; disabled?: boolean; onSelect: (path: string) => Promise<void> }) {
  const [open, setOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const local = () => props.listing.path === props.listing.mainPath;
  const selectLocal = async () => {
    setPending(true); setError(undefined);
    try { if (!local()) await props.onSelect(props.listing.mainPath); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  return <><div class="project-picker"><button type="button" class="selected" aria-label="Choose worktree" aria-haspopup="dialog" aria-expanded={open() || creating()} title={props.listing.path} disabled={props.disabled} onClick={() => { setError(undefined); setOpen(true); }}><FolderGit2 size={14} />{local() ? "Local" : "Worktree"}</button></div>
    <Show when={open()}><WorktreeOptions local={local()} pending={pending()} error={error()} onLocal={() => void selectLocal()} onCreate={() => { setOpen(false); setCreating(true); }} onClose={() => setOpen(false)} /></Show>
    <Show when={creating()}><Portal mount={document.querySelector(".app") ?? document.body}><WorktreeDialog projectPath={props.listing.path} fromProject onCancel={() => setCreating(false)} onCreate={async (name, onSetup) => {
      const owner = props.transport; const cwd = props.listing.path; const hostId = owner.currentHostId();
      const result = await owner.createProjectWorktree(cwd, name, hostId);
      await owner.runWorktreeSetup(cwd, result.path, hostId, onSetup);
      if (!disposed) { await props.onSelect(result.path); setCreating(false); }
      return result;
    }} /></Portal></Show>
  </>;
}
