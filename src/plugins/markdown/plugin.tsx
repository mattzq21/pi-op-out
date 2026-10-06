import { Rerun } from "@solid-primitives/keyed";
import { createMemo, Show } from "solid-js";
import { NotesPane } from "./NotesPane";
import type { PluginContext, PluginInstance } from "../types";

export function createPlugin(context: PluginContext): PluginInstance {
  const target = createMemo(() => JSON.stringify([context.source().hostId, context.source().sessionId]));

  return { panel: () => <Rerun on={target}>{() => <Show when={context.source().sessionId} fallback={<p class="empty-small">Choose a conversation to write a note.</p>} keyed>{sessionId => <NotesPane sessionId={sessionId} hostId={context.source().hostId} visible={context.visible} />}</Show>}</Rerun> };
}
