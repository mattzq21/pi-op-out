import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { ChevronDown } from "lucide-solid";
import type { SidepaneTab } from "../lib/sidepaneTabs";
import type { SubagentFacts } from "../lib/subagentFacts";
import { AgentIcon } from "./AgentIcon";
import "./auxiliary-agents.css";

const KIND_ORDER = ["subagent", "review", "btw"];
const KIND_NAMES: Record<string, string> = { subagent: "Subagents", review: "Review", btw: "Btw" };
const SHORT_KIND_NAMES: Record<string, string> = { subagent: "Sub", review: "Rev", btw: "Btw" };

type Facts = Accessor<ReadonlyMap<string, SubagentFacts>>;

interface Props { agents: SidepaneTab[]; subagents: Facts; onOpen: (agent: SidepaneTab) => void }

interface Group { kind: string; agents: SidepaneTab[]; working: number }

function groups(agents: SidepaneTab[]): Group[] {
  const kinds = [...new Set(agents.map(agent => agent.kind))].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));

  return kinds.map(kind => {
    const members = agents.filter(agent => agent.kind === kind);

    return { kind, agents: [...members.filter(agent => agent.running), ...members.filter(agent => !agent.running)], working: members.filter(agent => agent.running).length };
  });
}

function rank(kind: string) {
  const index = KIND_ORDER.indexOf(kind);

  return index < 0 ? KIND_ORDER.length : index;
}

function Icon(props: { agent: SidepaneTab; subagents: Facts; size?: number }) {
  return <AgentIcon kind={props.agent.kind} name={props.agent.label} look={props.subagents().get(props.agent.key)?.look} running={props.agent.running} size={props.size} />;
}

const detail = (agent: SidepaneTab, subagents: Facts) => agent.session.preview || subagents().get(agent.key)?.task || "";

function dismissOnOutside(element: () => HTMLElement | undefined, close: () => void) {
  const pointer = (event: PointerEvent) => { if (!element()?.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", key);
  onCleanup(() => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key); });
}

export function AgentsPill(props: Props) {
  const [open, setOpen] = createSignal(false);
  const working = createMemo(() => props.agents.filter(agent => agent.running));
  const grouped = createMemo(() => groups(props.agents));
  let root: HTMLDivElement | undefined;

  return <Show when={working().length > 0 || open()}>
    <div class="agents-pill-root" ref={root}>
      <button type="button" class="agents-pill" aria-expanded={open()} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
        <span class="agents-stack"><Key each={working().slice(0, 4)} by={agent => agent.key}>{agent => <Icon agent={agent()} subagents={props.subagents} />}</Key></span>
        <span>{working().length} working</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      <Show when={open()}>{(() => {
        dismissOnOutside(() => root, () => setOpen(false));

        return <div class="agents-popover" role="dialog" aria-label="Side agents">
          <For each={grouped()}>{group => <section class="agents-group" aria-label={KIND_NAMES[group.kind] ?? group.kind}>
            <header><span>{KIND_NAMES[group.kind] ?? group.kind}</span><span>{group.working ? `${group.working} working` : "idle"}</span></header>
            <Key each={group.agents} by={agent => agent.key}>{agent => <button type="button" class="agents-row" classList={{ "agents-row-idle": !agent().running }} onClick={() => { setOpen(false); props.onOpen(agent()); }}>
              <Icon agent={agent()} subagents={props.subagents} />
              <span class="agents-row-name">{agent().label}</span>
              <span class="agents-row-detail">{detail(agent(), props.subagents)}</span>
              <span class="agents-row-state">{agent().running ? "Working" : "Idle"}</span>
            </button>}</Key>
          </section>}</For>
        </div>;
      })()}</Show>
    </div>
  </Show>;
}

export function AgentsDock(props: Props) {
  const grouped = createMemo(() => groups(props.agents));
  const [shown, setShown] = createSignal<{ key: string; top: number }>();
  const card = createMemo(() => { const target = shown(); return target && props.agents.find(agent => agent.key === target.key); });
  let dock: HTMLElement | undefined;
  const show = (agent: SidepaneTab, element: HTMLElement) => setShown({ key: agent.key, top: element.offsetTop + (dock?.offsetTop ?? 0) });

  return <Show when={props.agents.some(agent => agent.running)}>
    <nav class="agents-dock" aria-label="Side agents" ref={dock} onPointerLeave={() => setShown(undefined)}>
      <For each={grouped()}>{(group, index) => <>
        <Show when={index() > 0}><span class="agents-dock-divider" aria-hidden="true" /></Show>
        <span class="agents-dock-kind" aria-hidden="true">{SHORT_KIND_NAMES[group.kind] ?? group.kind.slice(0, 3)}</span>
        <Key each={group.agents} by={agent => agent.key}>{agent => <button type="button" class="agents-dock-slot" classList={{ "agents-row-idle": !agent().running }} aria-label={`${agent().label}, ${agent().running ? "working" : "idle"}`}
          onPointerEnter={event => show(agent(), event.currentTarget)} onFocus={event => show(agent(), event.currentTarget)} onBlur={() => setShown(undefined)} onClick={() => props.onOpen(agent())}>
          <Icon agent={agent()} subagents={props.subagents} size={22} />
        </button>}</Key>
      </>}</For>
    </nav>
    <Show when={card()}>{agent => <div class="agents-dock-card" role="tooltip" style={{ top: `${shown()!.top - 4}px` }}>
      <div class="agents-dock-card-title"><Icon agent={agent()} subagents={props.subagents} /><strong>{agent().label}</strong><span>{KIND_NAMES[agent().kind] ?? agent().kind}</span><span class="agents-row-state">{agent().running ? "Working" : "Idle"}</span></div>
      <Show when={detail(agent(), props.subagents)}>{text => <p>{text()}</p>}</Show>
      <span class="agents-dock-card-hint">Click to open</span>
    </div>}</Show>
  </Show>;
}
