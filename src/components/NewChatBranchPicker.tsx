import { createSignal, onCleanup, Show } from "solid-js";
import { GitBranch } from "lucide-solid";
import { createDependencyEffect } from "../lib/solid";
import { projectBranches, type ProjectBranches, type NativeTransport } from "../lib/nativeTransport";
import { NewChatWorktreePicker } from "./NewChatWorktreePicker";
import { BranchPickerDialog } from "./BranchPickerDialog";
import { chatSubmission, registeredWorktreePreparation, registerWorktreePreparation } from "../lib/newChatWorktree";

export function NewChatBranchPicker(props: { transport?: NativeTransport; cwd: string; hostId: string; disabled?: boolean; onSelect: (path: string) => Promise<void> }) {
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [listing, setListing] = createSignal<ProjectBranches | null>();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [open, setOpen] = createSignal(false);
  const [branchPickingEnabled, setBranchPickingEnabled] = createSignal(false);
  const branchDisabled = () => props.disabled || pending() || Boolean(props.transport && listing()?.mainPath && !branchPickingEnabled());
  let listingRequest: Promise<unknown> = Promise.resolve();
  const waitForListing = async (): Promise<string | undefined> => { await listingRequest; return props.transport ? registeredWorktreePreparation(props.transport, waitForListing) : undefined; };
  if (props.transport) onCleanup(registerWorktreePreparation(props.transport, waitForListing));
  createDependencyEffect(() => {
    const selection = chatSubmission(props.transport)?.selection;
    if (selection) { setListing(selection.listing); setBranchPickingEnabled(selection.createNew); return; }
    let cancelled = false;
    setListing(undefined); setError(undefined); setBranchPickingEnabled(false); setOpen(false);
    listingRequest = projectBranches(props.cwd, props.hostId).then((value) => { if (!cancelled) setListing(value); }).catch((reason) => { if (!cancelled) setError(String(reason)); throw reason; });
    void listingRequest.catch(() => undefined);
    return () => { cancelled = true; };
  }, () => [props.cwd, props.hostId]);
  const select = async (branch: string) => {
    if (branchDisabled()) return;
    if (branch === listing()?.current) { setOpen(false); return; }
    const cwd = props.cwd; const host = props.hostId;
    setPending(true); setError(undefined);
    try {
      const selected = await projectBranches(cwd, host, branch);
      if (!disposed && selected && props.cwd === cwd && props.hostId === host) { await props.onSelect(selected.path); setOpen(false); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  return <><Show when={listing()}>{(value) => <><Show when={props.transport && value().mainPath}><NewChatWorktreePicker transport={props.transport!} listing={value()} disabled={props.disabled || pending()} onSelect={props.onSelect} onBranchPickingChange={setBranchPickingEnabled} /></Show><Show when={!props.transport || !value().mainPath || branchPickingEnabled()}><div class="project-picker"><button type="button" class={value().current ? "selected" : undefined} aria-label={`Choose branch: ${value().current ?? "none selected"}`} aria-haspopup="dialog" aria-expanded={open()} title={value().current ?? "Choose branch"} disabled={branchDisabled()} onClick={() => { setError(undefined); setOpen(true); }}><GitBranch size={14} />{value().current ?? "Choose branch"}</button></div></Show><Show when={open() && !branchDisabled()}><BranchPickerDialog branches={value().branches} current={value().current} pending={pending()} error={error()} onSelect={(branch) => void select(branch)} onCancel={() => setOpen(false)} /></Show></>}</Show><Show when={error() && !open()}><small role="alert">{error()}</small></Show></>;
}
