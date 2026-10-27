import { createUniqueId } from "solid-js";

const arrows = "M8.2 10.5A4 4 0 0 1 15.5 9.5M15.5 7.5V9.8H13.2M15.8 13.5A4 4 0 0 1 8.5 14.5M8.5 16.5V14.2H10.8";

export function CacheIcon(props: { rate: number }) {
  const clipId = `cache-fill-${createUniqueId()}`;
  const coverage = () => Number.isFinite(props.rate) ? Math.max(0, Math.min(100, props.rate)) / 100 : 0;

  return <svg class="cache-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <defs><clipPath id={clipId}><path d="M4 5.5C4 9.5 20 9.5 20 5.5V18.5C20 22.5 4 22.5 4 18.5Z" /></clipPath></defs>
    <rect x="4" y={21.5 - coverage() * 14} width="16" height={coverage() * 14} clip-path={`url(#${clipId})`} fill="var(--accent)" fill-opacity=".75" stroke="none" />
    <path d="M4 18.5V5.5A8 3 0 0 1 20 5.5V18.5C20 22.5 4 22.5 4 18.5" />
    <path d={arrows} stroke="var(--accent)" stroke-width="2.5" />
    <path d={arrows} stroke="#000000" stroke-width="1.7" />
  </svg>;
}
