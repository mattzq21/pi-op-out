import { createSignal, onCleanup, Show } from "solid-js";
import { GitBranch } from "lucide-solid";
import { createDependencyEffect } from "../lib/solid";
import { projectBranches, type ProjectBranches } from "../lib/nativeTransport";
import { BranchPickerDialog } from "./BranchPickerDialog";

export function NewChatBranchPicker(props: { cwd: string; hostId: string; disabled?: boolean; onSelect: (path: string) => Promise<void> }) {
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [listing, setListing] = createSignal<ProjectBranches | null>();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [open, setOpen] = createSignal(false);
  createDependencyEffect(() => {
    let cancelled = false;
    setListing(undefined); setError(undefined);
    void projectBranches(props.cwd, props.hostId).then((value) => { if (!cancelled) setListing(value); }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, () => [props.cwd, props.hostId]);
  const select = async (branch: string) => {
    if (pending()) return;
    if (branch === listing()?.current) { setOpen(false); return; }
    const cwd = props.cwd; const host = props.hostId;
    setPending(true); setError(undefined);
    try {
      const selected = await projectBranches(cwd, host, branch);
      if (!disposed && selected && props.cwd === cwd && props.hostId === host) { await props.onSelect(selected.path); setOpen(false); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  return <><Show when={listing()}>{(value) => <><div class="project-picker"><button type="button" class={value().current ? "selected" : undefined} aria-label={`Choose branch: ${value().current ?? "none selected"}`} aria-haspopup="dialog" aria-expanded={open()} title={value().current ?? "Choose branch"} disabled={props.disabled || pending()} onClick={() => { setError(undefined); setOpen(true); }}><GitBranch size={14} />{value().current ?? "Choose branch"}</button></div><Show when={open()}><BranchPickerDialog branches={value().branches} current={value().current} pending={pending()} error={error()} onSelect={(branch) => void select(branch)} onCancel={() => setOpen(false)} /></Show></>}</Show><Show when={error() && !open()}><small role="alert">{error()}</small></Show></>;
}
