import { createSignal, type Accessor } from "solid-js";
import { createDependencyEffect } from "../../lib/solid";

export interface ChatPreset { name: string; model: string; thinkingEffort?: string }

export interface ChatModel { id: string; name: string; presets: ChatPreset[] }

interface Selection { model: string; thinkingEffort?: string; versionId?: string }

export function createModelSelection(models: Accessor<ChatModel[]>) {
  const [selection, setSelection] = createSignal<Selection>({ model: "auto", versionId: "latest" });
  const matches = (preset: ChatPreset, value: Selection) => preset.model === value.model && preset.thinkingEffort === value.thinkingEffort;
  const version = () => models().find(model => model.id === selection().versionId);
  const presets = () => version()?.presets ?? [];
  const index = () => Math.max(0, presets().findIndex(preset => matches(preset, selection())));
  const choose = (version: ChatModel, preset: ChatPreset) => setSelection({ model: preset.model, thinkingEffort: preset.thinkingEffort, versionId: version.id });

  const restore = (value: Selection) => {
    const preferred = models().find(version => version.id === value.versionId);
    const target = preferred ?? models().find(version => version.presets.some(preset => matches(preset, value))) ?? models()[0];

    if (!target) { setSelection(value);

    return; }

    const preset = target.presets.find(preset => matches(preset, value)) ?? target.presets.find(preset => preset.thinkingEffort === "standard") ?? target.presets[0];
    choose(target, preset);
  };

  const setVersion = (id: string) => {
    const target = models().find(version => version.id === id);

    if (!target) return;
    const current = presets()[index()];
    choose(target, target.presets.find(preset => preset.name === current?.name) ?? target.presets[0]);
  };

  const setIndex = (index: number) => { const target = version(); const preset = presets()[index];

  if (target && preset) choose(target, preset); };

  createDependencyEffect(() => restore(selection()), () => [models()]);

  return { selection, version, presets, index, setVersion, setIndex, restore };
}
