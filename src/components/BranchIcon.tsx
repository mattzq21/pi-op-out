import { createMemo, Show } from "solid-js";
import type { SessionSummary } from "../types";
import { z } from "zod";

const letterSchema = z.string().trim().regex(/^\p{L}\p{M}*$/u).optional().catch(undefined);

const colorSchema = z.string().regex(/^#[\da-f]{6}$/i).catch("#ffffff");

const cross = "M5 2L12 9L19 2L22 5L15 12L22 19L19 22L12 15L5 22L2 19L9 12L2 5Z";

export function BranchIcon(props: { branch: string; appearance?: SessionSummary["branchAppearance"] }) {
  const letter = createMemo(() => letterSchema.parse(props.appearance?.letter));
  const color = createMemo(() => colorSchema.parse(props.appearance?.color));

  return <span class="session-branch-icon" aria-hidden="true" style={{ color: color() }}><Show when={letter()} fallback={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"><path d={cross} /></svg>}>{letter()}</Show></span>;
}
