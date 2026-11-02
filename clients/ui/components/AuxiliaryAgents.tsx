import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { ChevronDown } from "lucide-solid";
import type { SidepaneTab } from "../lib/sidepaneTabs";
import type { SubagentFacts } from "../lib/subagentFacts";
import { AgentIcon } from "./AgentIcon";
import "./auxiliary-agents.css";

const KIND_ORDER = ["subagent", "review", "btw"];
const KIND_NAMES: Record<string, string> = { subagent: "Subagents", review: "Review", btw: "Btw" };

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

function AgentsPopover(props: Props & { anchor: () => HTMLElement | undefined; onClose: () => void }) {
  const grouped = createMemo(() => groups(props.agents));
  const pointer = (event: PointerEvent) => { if (!props.anchor()?.contains(event.target as Node)) props.onClose(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", key);
  onCleanup(() => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key); });

  return <div class="agents-popover" role="dialog" aria-label="Side agents">
    <For each={grouped()}>{group => <section class="agents-group" aria-label={KIND_NAMES[group.kind] ?? group.kind}>
      <header><span>{KIND_NAMES[group.kind] ?? group.kind}</span><span>{group.working ? `${group.working} working` : "idle"}</span></header>
      <Key each={group.agents} by={agent => agent.key}>{agent => <button type="button" class="agents-row" classList={{ "agents-row-idle": !agent().running }} onClick={() => { props.onClose(); props.onOpen(agent()); }}>
        <Icon agent={agent()} subagents={props.subagents} />
        <span class="agents-row-name">{agent().label}</span>
        <span class="agents-row-detail">{detail(agent(), props.subagents)}</span>
        <span class="agents-row-state">{agent().running ? "Working" : "Idle"}</span>
      </button>}</Key>
    </section>}</For>
  </div>;
}

export function AgentsPill(props: Props) {
  const [open, setOpen] = createSignal(false);
  const working = createMemo(() => props.agents.filter(agent => agent.running));
  let root: HTMLDivElement | undefined;

  return <Show when={working().length > 0 || open()}>
    <div class="agents-pill-root" ref={root}>
      <button type="button" class="agents-pill" aria-expanded={open()} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
        <span class="agents-stack"><Key each={working().slice(0, 4)} by={agent => agent.key}>{agent => <Icon agent={agent()} subagents={props.subagents} />}</Key></span>
        <span>{working().length} working</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      <Show when={open()}><AgentsPopover {...props} anchor={() => root} onClose={() => setOpen(false)} /></Show>
    </div>
  </Show>;
}
