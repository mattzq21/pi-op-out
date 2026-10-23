import { createSignal } from "solid-js";
import type { AgentState, Model, RpcCommand } from "../types";

type Selection = { model?: Model | null; thinkingLevel?: string; fastMode?: boolean };

const fastKey = "pi-desktop-fast-mode";

const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function modelLevels(model: Model) {
  if (!model.reasoning) return ["off"];

  return effortLevels.filter(level => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
}

/** The nearest thinking level that the model supports, as Pi chooses it: the same or the next higher level, else the next lower one. */
export function clampEffort(level: string, model?: Model) {
  if (!model) return level;
  const levels = modelLevels(model);
  const index = effortLevels.indexOf(level);
  const ordered = [...effortLevels.slice(Math.max(index, 0)), ...effortLevels.slice(0, Math.max(index, 0)).reverse()];

  return ordered.find(candidate => levels.includes(candidate)) ?? "off";
}

export class PromptControls {
  private selection = createSignal<Selection>({});
  private effectiveModel = createSignal<Model | null | undefined>();
  private applied?: Selection;
  private applying = false;
  isApplying() { return this.applying; }
  hasPending() {
    const selected = this.selection[0]();

    return selected !== this.applied && (Boolean(selected.model) || selected.thinkingLevel !== undefined || selected.fastMode !== undefined);
  }
  reset() { this.selection[1]({}); this.applied = undefined; }
  /** True when the user chose no model, thinking level or fast mode. */
  untouched() { const selected = this.selection[0](); return selected.model === undefined && selected.thinkingLevel === undefined && selected.fastMode === undefined; }
  /** Show no model until the user chooses one. */
  clearModel() { this.effectiveModel[1](null); this.selection[1](current => ({ ...current, model: null })); }
  useEffectiveModel(model: Model | null) { this.effectiveModel[1](model); if (model && this.selection[0]().model === null) this.selection[1](current => ({ ...current, model: undefined })); }
  missingModel() { const selected = this.selection[0]().model; return (selected === undefined ? this.effectiveModel[0]() : selected) == null; }
  model(model: Model, thinkingLevel?: string) { this.selection[1](current => ({ ...current, model, thinkingLevel: clampEffort(thinkingLevel ?? current.thinkingLevel ?? "medium", model) })); }
  thinking(thinkingLevel: string) { this.selection[1](current => ({ ...current, thinkingLevel: clampEffort(thinkingLevel, current.model ?? undefined) })); }
  fast(fastMode: boolean) { this.selection[1](current => ({ ...current, fastMode })); }
  copyTo(target: PromptControls) { target.selection[1](current => ({ ...current, ...this.selection[0]() })); }
  levels(fallback: string[]) { const model = this.selection[0]().model;

  return model ? modelLevels(model) : fallback; }
  state(state: AgentState): AgentState {
    const selected = this.selection[0]();
    const model = selected.model === undefined ? this.effectiveModel[0]() : selected.model;

    if ((model === undefined || model === state.model) && selected.thinkingLevel === undefined) return state;

    return { ...state, model: model === undefined ? state.model : model, thinkingLevel: selected.thinkingLevel ?? state.thinkingLevel };
  }
  /** Shows the fast mode choice only for a model in the host's fast model list. The session status gives the saved choice. */
  statuses(statuses: Record<string, string>, fastModels: string[] | undefined, model: Model | null | undefined) {
    const { [fastKey]: status, ...rest } = statuses;

    if (!model || !fastModels?.includes(model.provider + "/" + model.id)) return rest;
    const enabled = this.selection[0]().fastMode ?? (status === "Fast mode on" ? true : status === "Fast mode off" ? false : undefined);

    return enabled === undefined ? rest : { ...rest, [fastKey]: enabled ? "Fast mode on" : "Fast mode off" };
  }
  toggle(statuses: Record<string, string>) { this.fast(statuses[fastKey] !== "Fast mode on");

  return Promise.resolve(); }
  acknowledge(state: AgentState) {
    this.effectiveModel[1](state.model);
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
