import { createSignal, For, onCleanup, Show } from "solid-js";
import { GitBranch } from "lucide-solid";
import { createDependencyEffect } from "../lib/solid";
import { projectBranches, type ProjectBranches } from "../lib/nativeTransport";

export function NewChatBranchPicker(props: { cwd: string; hostId: string; disabled?: boolean; onSelect: (path: string) => Promise<void> }) {
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [listing, setListing] = createSignal<ProjectBranches | null>();
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  createDependencyEffect(() => {
    let cancelled = false;
    setListing(undefined); setError(undefined);
    void projectBranches(props.cwd, props.hostId).then((value) => { if (!cancelled) setListing(value); }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, () => [props.cwd, props.hostId]);
  const select = async (branch: string) => {
    if (pending()) return;
    const cwd = props.cwd; const host = props.hostId;
    setPending(true); setError(undefined);
    try {
      const selected = await projectBranches(cwd, host, branch);
      if (!disposed && selected && props.cwd === cwd && props.hostId === host) await props.onSelect(selected.path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(false); }
  };
  return <><Show when={listing()}>{(value) => <label class="new-chat-branch-picker"><GitBranch size={14} /><select aria-label="Branch for new chat" disabled={props.disabled || pending()} value={value().current ?? ""} onChange={(event) => void select(event.currentTarget.value)}>
    {!value().current && <option value="" disabled>Choose branch</option>}
    <For each={value().branches}>{(branch) => <option value={branch}>{branch}</option>}</For>
  </select></label>}</Show><Show when={error()}><small role="alert">{error()}</small></Show></>;
}
