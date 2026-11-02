import { createMemo, Index, Show } from "solid-js";
import { subagentLook } from "../lib/subagentLooks";

const KIND_BADGES: Record<string, { letter: string; color: string }> = {
  review: { letter: "R", color: "#c58d43" },
  btw: { letter: "B", color: "#6d8fb8" },
};

export function SubagentAvatar(props: { seed: string; look?: number; size?: number }) {
  const look = createMemo(() => {
    const value = subagentLook(props.seed, props.look);
    const size = value.petals === 3 ? 4.6 : value.petals === 4 ? 4 : 3.2;
    return { color: value.color, size, radius: size * value.roundness, angles: Array.from({ length: value.petals }, (_, index) => index * 360 / value.petals + value.turn) };
  });

  return <svg class="subagent-avatar" width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 18 18" aria-hidden="true">
    <Index each={look().angles}>{angle => <rect x={9 - look().size / 2} y={9 - 5 - look().size / 2} width={look().size} height={look().size} rx={look().radius} transform={`rotate(${angle()} 9 9) rotate(45 9 4)`} fill={look().color} fill-opacity="0.18" stroke={look().color} stroke-width="1.2" />}</Index>
    <circle cx="9" cy="9" r="1.3" fill={look().color} />
  </svg>;
}

export function AgentIcon(props: { kind: string; name: string; look?: number; running: boolean; size?: number }) {
  const badge = () => KIND_BADGES[props.kind] ?? { letter: props.kind.slice(0, 1).toUpperCase(), color: "#8f8b82" };

  return <span class="agent-icon" classList={{ "agent-running": props.running }} style={{ "--agent-icon-size": `${props.size ?? 18}px` }} aria-hidden="true">
    <Show when={props.kind === "subagent"} fallback={<span class="agent-kind-badge" style={{ background: badge().color }}>{badge().letter}</span>}>
      <SubagentAvatar seed={props.name} look={props.look} size={props.size} />
    </Show>
  </span>;
}
