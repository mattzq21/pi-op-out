import type { CSSProperties } from "react";
import type { HookCounts } from "../lib/hookStats";

export function HookWheel({ counts, label }: { counts?: HookCounts; label: string }) {
  if (!counts) return null;
  const rate = counts.completed ? counts.failed / counts.completed * 100 : 0;
  const description = counts.completed ? `${label}: ${counts.completed - counts.failed} succeeded, ${counts.failed} failed (${Math.round(rate)}%) of ${counts.completed} completed hooks` : `${label}: no hooks completed`;
  return <span className="hook-wheel" role="img" aria-label={description} title={description} style={{ "--hook-failure": `${rate}%` } as CSSProperties}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="15" cy="5" r="2" /><path d="M15 7v8a5 5 0 0 1-10 0v-3l3 3" /></svg>
  </span>;
}
