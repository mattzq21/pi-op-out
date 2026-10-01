import { createMemo, Show } from "solid-js";
import type { SessionSummary } from "../types";

const cross = "M5 2L12 9L19 2L22 5L15 12L22 19L19 22L12 15L5 22L2 19L9 12L2 5Z";

export function BranchIcon(props: { branch: string; appearance?: SessionSummary["branchAppearance"] }) {
  const letter = createMemo(() => {
    const configured = props.appearance?.letter;

    return typeof configured === "string" && /^\p{L}\p{M}*$/u.test(configured.trim()) ? configured.trim() : undefined;
  });

  const color = createMemo(() => {
    const configured = props.appearance?.color;

    return typeof configured === "string" && /^#[\da-f]{6}$/i.test(configured) ? configured : "#ffffff";
  });

  return <span class="session-branch-icon" aria-hidden="true" style={{ color: color() }}><Show when={letter()} fallback={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"><path d={cross} /></svg>}>{letter()}</Show></span>;
}
