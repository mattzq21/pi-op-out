import { useEffect, useRef, useState } from "react";
import type { GitWorktree } from "../lib/nativeTransport";

interface Props {
  projectPath: string;
  beforePrompt?: boolean;
  fromProject?: boolean;
  onCreate: (name: string, onSetup: (cancel: (() => Promise<void>) | undefined) => void) => Promise<GitWorktree>;
  onCancel: () => void;
}

export function WorktreeDialog({ projectPath, beforePrompt = false, fromProject = false, onCreate, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [cancelSetup, setCancelSetup] = useState<() => Promise<void>>();
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const cancel = async () => {
    if (!creatingRef.current) { onCancel(); return; }
    if (!cancelSetup || cancellingRef.current) return;
    cancellingRef.current = true; setCancelling(true);
    try { await cancelSetup(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); cancellingRef.current = false; setCancelling(false); }
  };

  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); }; }, []);

  const create = async () => {
    if (creatingRef.current) return;
    const suffix = name.trim();
    if (!suffix) { setError("Name can't be empty"); return; }
    creatingRef.current = true; setCreating(true); setError(undefined); cancellingRef.current = false; setCancelling(false);
    try { await onCreate(suffix, (cancel) => setCancelSetup(() => cancel)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); creatingRef.current = false; setCreating(false); cancellingRef.current = false; setCancelling(false); setCancelSetup(undefined); }
  };

  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby="worktree-dialog-title" onCancel={(event) => { event.preventDefault(); void cancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (!creatingRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onCancel(); }}>
    <p className="eyebrow">Git</p><h2 id="worktree-dialog-title">Create worktree</h2><p>{fromProject ? "Create a matching branch and worktree from this project’s current commit, then run your environment setup scripts." : beforePrompt ? "Create a worktree and fork the conversation from before this response’s prompt. Restore the prompt and its attachments as a draft." : "Create a branch and worktree from this response’s settled commit and conversation."}</p>
    <input autoFocus aria-label="Worktree name" value={name} placeholder="Worktree name" disabled={creating} onChange={(event) => { setName(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void create(); }} />
    {name.trim() && <p className="worktree-preview" title={projectPath}>Name: <code>{name.trim()}</code>. The repository root determines the branch and directory prefix.</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {cancelSetup && <p role="status">{cancelling ? "Stopping environment setup…" : "Running environment setup. Cancelling keeps the created worktree."}</p>}
    <div className="dialog-actions"><button disabled={cancelling || (creating && !cancelSetup)} onClick={() => void cancel()}>{cancelSetup ? "Cancel setup" : "Cancel"}</button><button className="primary-button" disabled={creating} onClick={() => void create()}>{creating ? "Creating…" : "Create worktree"}</button></div>
  </dialog>;
}
