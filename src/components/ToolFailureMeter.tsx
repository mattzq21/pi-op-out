import { createMemo, createUniqueId, Show } from "solid-js";
import type { ToolFailureStats } from "../lib/toolFailureStats";

const wrenchPath = "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z";

export function ToolFailureMeter(props: { stats?: ToolFailureStats }) {
  const clipId = `tool-error-fill-${createUniqueId()}`;

  const intensity = createMemo(() => {
    const rate = props.stats?.rate ?? 0;

    return Math.log1p(99 * (Number.isFinite(rate) ? Math.max(0, Math.min(100, rate)) / 100 : 0)) / Math.log(100);
  });

  return <Show when={props.stats}>{stats => <span class="cache-hit-rate tool-failure-rate" style={{ color: `color-mix(in srgb, var(--muted) ${100 - intensity() * 100}%, #d77865)` }} tabIndex={0} aria-label={`Tool failures ${stats().rate}%, ${stats().failed}/${stats().total} completed top-level calls; detected invalid use: ${stats().invalidUse}; other or unclassified: ${stats().other}`}>
    <svg class="tool-failure-icon" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <defs><clipPath id={clipId}><path d={wrenchPath} /></clipPath></defs>
      <rect x="0" y={22 - intensity() * 20} width="24" height={intensity() * 20} fill="currentColor" fill-opacity=".65" stroke="none" clip-path={`url(#${clipId})`} />
      <path d={wrenchPath} />
    </svg>
    {stats().rate}%
    <span class="tool-failure-tooltip" aria-hidden="true">
      <span>{stats().failed}/{stats().total} completed top-level calls failed</span>
      <span>Invalid use (detected): {stats().invalidUse}</span>
      <span>Other / unclassified: {stats().other}</span>
    </span>
  </span>}</Show>;
}
