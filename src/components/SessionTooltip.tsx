import { Folder, GitBranch } from "lucide-solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionSummary } from "../types";

export function SessionTooltip(props: { session: SessionSummary; anchor: HTMLElement; onClose: () => void }) {
  let element!: HTMLDivElement;
  const [position, setPosition] = createSignal({ left: "0px", top: "0px" });
  const worktree = () => {
    const root = props.session.worktreeRoot ?? props.session.cwd;
    return root.split(/[\\/]/).filter(Boolean).at(-1) || root;
  };
  onMount(() => {
    const anchor = props.anchor.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const top = anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
    setPosition({ left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`, top: `${Math.max(8, top)}px` });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("scroll", props.onClose, true);
    window.addEventListener("resize", props.onClose);
    window.addEventListener("keydown", escape);
    onCleanup(() => {
      window.removeEventListener("scroll", props.onClose, true);
      window.removeEventListener("resize", props.onClose);
      window.removeEventListener("keydown", escape);
    });
  });
  return <Portal><div ref={element} class="session-tooltip" role="tooltip" style={position()}>
    <span><GitBranch size={14} aria-label="Branch" /><span>{props.session.branch}</span></span>
    <span><Folder size={14} aria-label="Worktree" /><span>{worktree()}</span></span>
  </div></Portal>;
}
