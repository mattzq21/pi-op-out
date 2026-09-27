import { createMemo } from "solid-js";
import type { SessionSummary } from "../types";

const shapes = {
  circle: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z",
  square: "M4 4h16v16H4Z",
  triangle: "M12 3L22 21H2Z",
  diamond: "M12 1L23 12L12 23L1 12Z",
  hexagon: "M7 3H17L23 12L17 21H7L1 12Z",
  star: "M12 1L15.4 8L23 9L17.5 14.5L19 22L12 18.5L5 22L6.5 14.5L1 9L8.6 8Z",
};
const cross = "M9 2H15V9H22V15H15V22H9V15H2V9H9Z";

export function BranchIcon(props: { branch: string; appearance?: SessionSummary["branchAppearance"] }) {
  const shape = createMemo(() => {
    const configured = props.appearance?.shape;
    return typeof configured === "string" && Object.hasOwn(shapes, configured) ? shapes[configured as keyof typeof shapes] : undefined;
  });
  const color = createMemo(() => {
    const configured = props.appearance?.color;
    return typeof configured === "string" && /^#[\da-f]{6}$/i.test(configured) ? configured : "#ffffff";
  });
  return <span class="session-branch-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill={shape() ? color() : "none"} stroke={shape() ? "none" : "#ffffff"} stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d={shape() ?? cross} /></svg></span>;
}
