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
const names = Object.keys(shapes) as Array<keyof typeof shapes>;
const colors = ["#22c55e", "#3b82f6", "#f59e0b", "#a78bfa", "#f472b6", "#2dd4bf", "#fb7185", "#a3e635"];

function branchHash(branch: string) {
  let hash = 2166136261;
  for (const character of branch) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return hash >>> 0;
}

export function BranchIcon(props: { branch: string; appearance?: SessionSummary["branchAppearance"] }) {
  const hash = createMemo(() => branchHash(props.branch));
  const shape = createMemo(() => {
    const configured = props.appearance?.shape;
    return typeof configured === "string" && Object.hasOwn(shapes, configured) ? configured as keyof typeof shapes : names[hash() % names.length];
  });
  const color = createMemo(() => {
    const configured = props.appearance?.color;
    return typeof configured === "string" && /^#[\da-f]{6}$/i.test(configured) ? configured : colors[Math.floor(hash() / names.length) % colors.length];
  });
  return <svg width="12" height="12" viewBox="0 0 24 24" fill={color()} aria-hidden="true"><path d={shapes[shape()]} /></svg>;
}
