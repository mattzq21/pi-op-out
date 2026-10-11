import { z } from "zod";
import { onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke, listen } from "./platform";

const modelSchema = z.object({ id: z.string(), engine: z.enum(["transcribe.cpp", "needle"]), label: z.string(), size: z.number(), path: z.string().optional(), received: z.number().optional(), error: z.string().optional() });
const modelsSchema = z.array(modelSchema);

/** A speech model that the daemon can save. path is set when it is saved; received is set while it is being saved. */
export type DictationModel = z.output<typeof modelSchema>;

/** Follows the speech models of the connected daemon. Each row updates only when its own data changes. */
export function useDictationModels() {
  const [state, setState] = createStore<{ models: DictationModel[]; error?: string }>({ models: [] });
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;

  const apply = (models: DictationModel[]) => { setState("models", reconcile(models, { key: "id" })); setState("error", undefined); };

  onMount(() => {
    void listen("pi://dictation-models", ({ payload }) => {
      if (disposed) return;
      revision++; apply(payload);
    }, modelsSchema).then(async (stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      const request = ++revision;
      const models = await invoke("dictation_models", undefined, modelsSchema);
      if (!disposed && request === revision) apply(models);
    }).catch((reason) => { if (!disposed) setState("error", `Could not read the speech models: ${reason instanceof Error ? reason.message : String(reason)}`); });
  });
  onCleanup(() => { disposed = true; unlisten?.(); });

  return state;
}

export const saveDictationModel = (id: string) => invoke("dictation_model_save", { id }).then(() => undefined);
export const cancelDictationModel = (id: string) => invoke("dictation_model_cancel", { id }).then(() => undefined);
export const removeDictationModel = (id: string) => invoke("dictation_model_remove", { id }).then(() => undefined);
