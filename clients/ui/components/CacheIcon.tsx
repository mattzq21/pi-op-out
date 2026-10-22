import { createUniqueId } from "solid-js";

const arrows = "M8.2 13.5A4 4 0 0 1 15.5 12.5M15.5 10.5V12.8H13.2M15.8 16.5A4 4 0 0 1 8.5 17.5M8.5 19.5V17.2H10.8";

export function CacheIcon(props: { rate: number }) {
  const clipId = `cache-fill-${createUniqueId()}`;
  const coverage = () => Number.isFinite(props.rate) ? Math.max(0, Math.min(100, props.rate)) / 100 : 0;

  return <svg class="cache-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <defs><clipPath id={clipId}><path d="M4 6C4 10 20 10 20 6V19C20 23 4 23 4 19Z" /></clipPath></defs>
    <rect x="4" y={22 - coverage() * 14} width="16" height={coverage() * 14} clip-path={`url(#${clipId})`} fill="var(--accent)" fill-opacity=".75" stroke="none" />
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6V19C4 23 20 23 20 19V6M4 12C4 13 5 13.5 6.5 13.8M17.5 13.8C19 13.5 20 13 20 12M4 17C4 18 5 18.5 6.5 18.8M17.5 18.8C19 18.5 20 18 20 17" />
    {/* A thin accent outline under the black arrows keeps them visible above the gray background. */}
    <path d={arrows} stroke="var(--accent)" stroke-width="3.1" />
    <path d={arrows} stroke="#000000" stroke-width="1.7" />
  </svg>;
}
