import { Show, createSignal } from "solid-js";
import { GitBranch, FolderGit2 } from "lucide-solid";
import { ContainedPicker } from "./Composer";

export function NewChatWorktreePicker(props: {
  options: { repository: string; branches: string[]; defaultBranch: string | null };
  value?: string;
  disabled?: boolean;
  onChange: (branch?: string) => void;
}) {
  const [mode, setMode] = createSignal(props.value === undefined ? "main" : "new");
  const [branch, setBranch] = createSignal(props.value ?? props.options.defaultBranch ?? props.options.branches[0] ?? "");

  return <>
    <ContainedPicker label="Worktree" value={mode()} disabled={props.disabled} anchorLeft menuMinWidth={170} icon={<><FolderGit2 size={14} /><span>{mode() === "main" ? "Main worktree" : "New worktree"}</span></>} options={[
      { value: "main", label: "Main worktree" },
      { value: "new", label: "New worktree", disabled: !props.options.branches.length },
    ]} onChange={value => { setMode(value); props.onChange(value === "new" ? branch() : undefined); }} />
    <Show when={mode() === "new"}>
      <ContainedPicker label="Start from branch" value={branch()} disabled={props.disabled} anchorLeft menuMinWidth={200} icon={<><GitBranch size={14} /><span>{branch()}</span></>} options={props.options.branches.map(name => ({ value: name, label: name }))} onChange={value => { setBranch(value); props.onChange(value); }} />
    </Show>
  </>;
}
