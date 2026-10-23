import { Show, createSignal } from "solid-js";
import { ChevronDown, FolderGit2, GitBranch, GitFork } from "lucide-solid";
import { ContainedPicker } from "./Composer";

export function NewChatWorktreePicker(props: {
  options: { repository: string; branches: string[]; defaultBranch: string | null };
  value?: string;
  disabled?: boolean;
  onChange: (branch?: string) => void;
}) {
  const [mode, setMode] = createSignal(props.value === undefined ? "main" : "new");
  const [branch, setBranch] = createSignal(props.value ?? props.options.defaultBranch ?? props.options.branches[0] ?? "");

  return <div class="worktree-picker" data-mode={mode()}>
    <ContainedPicker label="Worktree" value={mode()} disabled={props.disabled} anchorLeft menuMinWidth={220} icon={<>{mode() === "main" ? <FolderGit2 size={14} /> : <GitFork size={14} />}<span>{mode() === "main" ? "Main worktree" : "New worktree"}</span><ChevronDown size={12} class="worktree-picker-chevron" aria-hidden="true" /></>} options={[
      { value: "main", label: "Main worktree", detail: "Work in the project folder" },
      { value: "new", label: "New worktree", detail: props.options.branches.length ? "Separate folder on a new branch" : "No branches found", disabled: !props.options.branches.length },
    ]} onChange={value => { setMode(value); props.onChange(value === "new" ? branch() : undefined); }} />
    <Show when={mode() === "new"}>
      <span class="worktree-picker-divider" aria-hidden="true" />
      <ContainedPicker label="Start from branch" value={branch()} disabled={props.disabled} anchorLeft menuMinWidth={220} icon={<><GitBranch size={14} /><span>{branch()}</span><ChevronDown size={12} class="worktree-picker-chevron" aria-hidden="true" /></>} options={props.options.branches.map(name => ({ value: name, label: name, detail: name === props.options.defaultBranch ? "Main worktree branch" : undefined }))} onChange={value => { setBranch(value); props.onChange(value); }} />
    </Show>
  </div>;
}
