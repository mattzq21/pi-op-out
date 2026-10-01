import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { initialChatSelection } from "../lib/newChatSelection";
import { Check, FolderGit2, Plus } from "lucide-solid";
import type { NativeTransport, ProjectBranches } from "../lib/nativeTransport";
import { chatSubmission, preserveChatSelection, registerWorktreePreparation, updateChatPreparation } from "../lib/newChatWorktree";

function WorktreeOptions(props: { local: boolean; pending: boolean; error?: string; onLocal: () => void; onCreate: () => void; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  onMount(() => {
    const focus = document.activeElement;
    dialog.showModal(); dialog.focus();
    onCleanup(() => { dialog.close();

    if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); });
  });

  return <Portal mount={document.querySelector(".app") ?? document.body}><dialog ref={dialog} tabIndex={-1} class="extension-dialog worktree-picker-dialog" aria-label="Choose a worktree" onCancel={(event) => { event.preventDefault();

  if (!props.pending) props.onClose(); }}>
    <h2>Choose a worktree</h2>
    <button type="button" disabled={props.pending} onClick={props.onLocal}><FolderGit2 size={16} /><span>Local</span><Show when={props.local}><Check size={16} /></Show></button>
    <button type="button" disabled={props.pending} onClick={props.onCreate}><Plus size={16} /><span>Create new worktree</span><Show when={!props.local}><Check size={16} /></Show></button>
    <Show when={props.error}><p class="dialog-error" role="alert">{props.error}</p></Show>
    <div class="dialog-actions"><button type="button" disabled={props.pending} onClick={props.onClose}>Cancel</button></div>
  </dialog></Portal>;
}

export function NewChatWorktreePicker(props: { transport: NativeTransport; listing: ProjectBranches; disabled?: boolean; onSelect: (path: string) => Promise<void>; onBranchPickingChange: (enabled: boolean) => void }) {
  const [open, setOpen] = createSignal(false);
  const selection = chatSubmission(props.transport)?.selection;
  const initial = selection ?? initialChatSelection(props.transport);
  const [createNew, setCreateNew] = createSignal(initial?.createNew ?? false);
  const [pending, setPending] = createSignal(!initial);
  let choiceChanged = false;
  const choose = (create: boolean) => { choiceChanged = true; setCreateNew(create); setOpen(false); };

  const [error, setError] = createSignal<string>();
  createEffect(() => props.onBranchPickingChange(createNew() && !pending()));
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");

  const defaults = selection ? Promise.resolve() : props.transport.listSessions().then((sessions) => {
    if (!disposed && !choiceChanged) setCreateNew(sessions.some((session) => !session.isDraft && session.messageCount > 0 && (session.hostId ?? "local") === props.transport.currentHostId() && normalize(session.worktreeRoot ?? session.cwd) === normalize(props.listing.path)));
  }).catch((reason) => { if (!disposed) setError(String(reason)); throw reason; }).finally(() => { if (!disposed) setPending(false); });

  void defaults.catch(() => undefined);
  let createdPath: string | undefined;

  const unregister = registerWorktreePreparation(props.transport, async () => {
    if (createNew()) updateChatPreparation(props.transport, "Creating worktree");
    await defaults;

    if (disposed) throw new Error("Conversation changed");
    preserveChatSelection(props.transport, props.listing, createNew());

    if (!createNew()) return undefined;
    const owner = props.transport; const cwd = props.listing.path; const host = owner.currentHostId();
    updateChatPreparation(owner, "Creating worktree");

    if (!createdPath) createdPath = (await owner.createProjectWorktree(cwd, crypto.randomUUID().slice(0, 8), host)).path;
    await owner.runWorktreeSetup(cwd, createdPath, host);

    if (disposed) throw new Error("Conversation changed");

    return createdPath;
  });

  onCleanup(unregister);

  return <><div class="project-picker"><button type="button" class="selected" aria-label="Choose worktree" aria-haspopup="dialog" aria-expanded={open()} title={props.listing.path} disabled={props.disabled || pending()} onClick={() => setOpen(true)}><FolderGit2 size={14} />{createNew() ? "Create new worktree" : "Local"}</button></div>
    <Show when={open()}><WorktreeOptions local={!createNew()} pending={pending()} error={error()} onLocal={() => choose(false)} onCreate={() => choose(true)} onClose={() => setOpen(false)} /></Show>
    <Show when={error() && !open()}><small role="alert">{error()}</small></Show>
  </>;
}
