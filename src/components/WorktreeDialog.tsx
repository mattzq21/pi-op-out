import { useEffect, useRef, useState } from "react";
import type { GitWorktree } from "../lib/nativeTransport";

interface Props {
  projectPath: string;
  beforePrompt?: boolean;
  onCreate: (name: string) => Promise<GitWorktree>;
  onCancel: () => void;
}

export function WorktreeDialog({ projectPath, beforePrompt = false, onCreate, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); requestAnimationFrame(() => returnFocusRef.current?.focus()); }; }, []);

  const create = async () => {
    if (creatingRef.current) return;
    const suffix = name.trim();
    if (!suffix) { setError("Name can't be empty"); return; }
    creatingRef.current = true; setCreating(true); setError(undefined);
    try { await onCreate(suffix); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); creatingRef.current = false; setCreating(false); }
  };

  return <dialog ref={dialogRef} className="extension-dialog" aria-labelledby="worktree-dialog-title" onCancel={(event) => { event.preventDefault(); if (!creatingRef.current) onCancel(); }} onMouseDown={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (!creatingRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onCancel(); }}>
    <p className="eyebrow">Git</p><h2 id="worktree-dialog-title">{beforePrompt ? "Branch before this prompt" : "Create worktree"}</h2><p>{beforePrompt ? "Create a worktree with the files and conversation from before this prompt. The latest 10 prompt checkpoints are retained." : "Create a branch and worktree beside the current project."}</p>
    <input autoFocus aria-label="Worktree name" value={name} placeholder="Worktree name" disabled={creating} onChange={(event) => { setName(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void create(); }} />
    {name.trim() && <p className="worktree-preview" title={projectPath}>Name: <code>{name.trim()}</code>. The repository root determines the branch and directory prefix.</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={creating} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={creating} onClick={() => void create()}>{creating ? "Creating…" : "Create worktree"}</button></div>
  </dialog>;
}
