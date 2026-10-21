import { DictationControls } from "./DictationControls";
import type { PluginInstance } from "../types";

export function createPlugin(): PluginInstance {
  return { composer: DictationControls };
}
