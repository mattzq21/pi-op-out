import { createSignal } from "solid-js";
import type { AgentState, Model, RpcCommand } from "../types";

type Selection = { model?: Model; thinkingLevel?: string; fastMode?: boolean };

const fastKey = "pi-desktop-fast-mode";

const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function modelLevels(model: Model) {
  if (!model.reasoning) return ["off"];

  return effortLevels.filter(level => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
}

function clampEffort(level: string, model?: Model) {
  if (!model) return level;
  const levels = modelLevels(model);
  const index = effortLevels.indexOf(level);
  const ordered = [...effortLevels.slice(Math.max(index, 0)), ...effortLevels.slice(0, Math.max(index, 0)).reverse()];

  return ordered.find(candidate => levels.includes(candidate)) ?? "off";
}

export class PromptControls {
  private selection = createSignal<Selection>({});
  private applied?: Selection;
  private applying = false;
  isApplying() { return this.applying; }
  hasPending() {
    const selected = this.selection[0]();

    return selected !== this.applied && (selected.model !== undefined || selected.thinkingLevel !== undefined || selected.fastMode !== undefined);
  }
  reset() { this.selection[1]({}); this.applied = undefined; }
  model(model: Model, thinkingLevel?: string) { this.selection[1](current => ({ ...current, model, thinkingLevel: clampEffort(thinkingLevel ?? current.thinkingLevel ?? "medium", model) })); }
  thinking(thinkingLevel: string) { this.selection[1](current => ({ ...current, thinkingLevel: clampEffort(thinkingLevel, current.model) })); }
  fast(fastMode: boolean) { this.selection[1](current => ({ ...current, fastMode })); }
  copyTo(target: PromptControls) { target.selection[1](current => ({ ...current, ...this.selection[0]() })); }
  levels(fallback: string[]) { const model = this.selection[0]().model;

  return model ? modelLevels(model) : fallback; }
  state(state: AgentState): AgentState {
    const selected = this.selection[0]();

    if (!selected.model && selected.thinkingLevel === undefined) return state;

    return { ...state, model: selected.model ?? state.model, thinkingLevel: selected.thinkingLevel ?? state.thinkingLevel };
  }
  statuses(statuses: Record<string, string>, fastModels?: string[]) {
    const selected = this.selection[0]();

    if (selected.model && fastModels) {
      const id = `${selected.model.provider}/${selected.model.id}`;

      if (!fastModels.includes(id)) return { ...statuses, [fastKey]: "Fast mode unavailable" };
    }

    const enabled = selected.fastMode ?? (selected.model && fastModels ? statuses[fastKey] === "Fast mode on" : undefined);

    return enabled === undefined ? statuses : { ...statuses, [fastKey]: enabled ? "Fast mode on" : "Fast mode off" };
  }
  toggle(statuses: Record<string, string>) { this.fast(this.statuses(statuses)[fastKey] !== "Fast mode on");

  return Promise.resolve(); }
  acknowledge(state: AgentState) {
    const applied = this.applied;

    if (!applied || this.selection[0]() !== applied) return;

    if (applied.model && (state.model?.id !== applied.model.id || state.model?.provider !== applied.model.provider)) return;

    if (applied.thinkingLevel !== undefined && state.thinkingLevel !== applied.thinkingLevel) return;
    this.selection[1]({}); this.applied = undefined;
  }
  async flush<T>(command: (value: RpcCommand) => Promise<T>, fast: (enabled: boolean) => Promise<void>) {
    const selected = this.selection[0]();

    if (!this.hasPending()) return;
    this.applying = true;

    try {
      if (selected.model) await command({ type: "set_model", provider: selected.model.provider, modelId: selected.model.id });

      if (selected.thinkingLevel !== undefined) await command({ type: "set_thinking_level", level: selected.thinkingLevel });

      if (selected.fastMode !== undefined) await fast(selected.fastMode);
      this.applied = selected;
    } finally { this.applying = false; }
  }
}
