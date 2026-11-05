import { createSignal, type Accessor, type Setter } from "solid-js";
import type { AgentState, Model, RpcCommand } from "../types";

type Selection = { model?: Model | null; thinkingLevel?: string; fastMode?: boolean };

const fastKey = "pi-desktop-fast-mode";

const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function modelLevels(model: Model) {
  if (!model.reasoning) return ["off"];

  return effortLevels.filter(level => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
}

export function clampEffort(level: string, model?: Model) {
  if (!model) return level;
  const levels = modelLevels(model);
  const index = effortLevels.indexOf(level);
  const ordered = [...effortLevels.slice(Math.max(index, 0)), ...effortLevels.slice(0, Math.max(index, 0)).reverse()];

  return ordered.find(candidate => levels.includes(candidate)) ?? "off";
}

export class PromptControls {
  private readonly selection: Accessor<Selection>;
  private readonly setSelection: Setter<Selection>;
  private readonly effectiveModel: Accessor<Model | null | undefined>;
  private readonly setEffectiveModel: Setter<Model | null | undefined>;
  private applied?: Selection;
  private applying = false;
  constructor() {
    const [selection, setSelection] = createSignal<Selection>({});
    const [effectiveModel, setEffectiveModel] = createSignal<Model | null | undefined>();
    this.selection = selection; this.setSelection = setSelection;
    this.effectiveModel = effectiveModel; this.setEffectiveModel = setEffectiveModel;
  }
  isApplying() { return this.applying; }
  hasPending() {
    const selected = this.selection();

    return selected !== this.applied && (Boolean(selected.model) || selected.thinkingLevel !== undefined || selected.fastMode !== undefined);
  }
  reset() { this.setSelection({}); this.applied = undefined; }
  // True when the user chose no model, effort or fast mode. A null model only marks that the host has no model.
  untouched() { const selected = this.selection(); return !selected.model && selected.thinkingLevel === undefined && selected.fastMode === undefined; }
  clearModel() { this.setEffectiveModel(null); this.setSelection(current => ({ ...current, model: null })); }
  useEffectiveModel(model: Model | null) { this.setEffectiveModel(model); if (model && this.selection().model === null) this.setSelection(current => ({ ...current, model: undefined })); }
  missingModel() { const selected = this.selection().model; return (selected === undefined ? this.effectiveModel() : selected) == null; }
  model(model: Model, thinkingLevel?: string) { this.setSelection(current => ({ ...current, model, thinkingLevel: clampEffort(thinkingLevel ?? current.thinkingLevel ?? "medium", model) })); }
  thinking(thinkingLevel: string) { this.setSelection(current => ({ ...current, thinkingLevel: clampEffort(thinkingLevel, current.model ?? undefined) })); }
  fast(fastMode: boolean) { this.setSelection(current => ({ ...current, fastMode })); }
  copyTo(target: PromptControls) { target.setSelection(current => ({ ...current, ...this.selection() })); }
  levels(fallback: string[]) { const selected = this.selection().model;
    const model = selected === undefined ? this.effectiveModel() : selected;

  return model ? modelLevels(model) : model === null ? ["off"] : fallback; }
  state(state: AgentState): AgentState {
    const selected = this.selection();
    const model = selected.model === undefined ? this.effectiveModel() : selected.model;

    if ((model === undefined || model === state.model) && selected.thinkingLevel === undefined) return state;

    return { ...state, model: model === undefined ? state.model : model, thinkingLevel: selected.thinkingLevel ?? state.thinkingLevel };
  }
  statuses(statuses: Record<string, string>, fastModels: string[] | undefined, model: Model | null | undefined) {
    const { [fastKey]: status, ...rest } = statuses;

    if (!model || !fastModels?.includes(model.provider + "/" + model.id)) return rest;
    const enabled = this.selection().fastMode ?? (status === "Fast mode on" ? true : status === "Fast mode off" ? false : undefined);

    return enabled === undefined ? rest : { ...rest, [fastKey]: enabled ? "Fast mode on" : "Fast mode off" };
  }
  toggle(statuses: Record<string, string>) { this.fast(statuses[fastKey] !== "Fast mode on");

  return Promise.resolve(); }
  acknowledge(state: AgentState) {
    this.setEffectiveModel(state.model);
    const applied = this.applied;

    if (!applied || this.selection() !== applied) return;

    if (applied.model && (state.model?.id !== applied.model.id || state.model?.provider !== applied.model.provider)) return;

    if (applied.thinkingLevel !== undefined && state.thinkingLevel !== applied.thinkingLevel) return;
    this.setSelection({}); this.applied = undefined;
  }
  async flush<T>(command: (value: RpcCommand) => Promise<T>, fast: (enabled: boolean) => Promise<void>) {
    const selected = this.selection();

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
