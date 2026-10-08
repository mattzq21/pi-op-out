import { Rerun } from "@solid-primitives/keyed";
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import { FileDiff } from "lucide-solid";
import { IconButton } from "../../components/IconButton";
import type { PluginContext, PluginConversation, PluginInstance } from "../types";
import { DiffPane } from "./DiffPane";

export function createPlugin(context: PluginContext): PluginInstance {
  const [selectedSource, setSelectedSource] = createSignal<PluginConversation>();
  const conversation = createMemo(() => JSON.stringify([context.source().hostId, context.source().sessionId]));
  createEffect(() => { conversation(); setSelectedSource(undefined); });

  const followedSource = createMemo(() => {
    const selected = selectedSource();

    return untrack(() => selected?.follow?.()) ?? (() => selected ?? context.source());
  });

  const source = () => followedSource()();
  const target = createMemo(() => JSON.stringify([source().hostId, source().sessionId]));

  const open = (value: PluginConversation) => {
    const current = context.source();
    setSelectedSource(value.hostId === current.hostId && value.sessionId === current.sessionId ? undefined : value);
    context.activate();
  };

  return {
    transcript: props => <Show when={Object.keys(props.source().gitDiffs ?? {}).length}><IconButton class="diff-plugin-button" label="View file changes" aria-controls="plugin-panel-diff" onClick={() => open(props.source())}><FileDiff size={19} /></IconButton></Show>,
    panel: () => {
      onCleanup(() => setSelectedSource(undefined));

      return <Rerun on={target}>{() => <DiffPane source={source} />}</Rerun>;
    },
  };
}
