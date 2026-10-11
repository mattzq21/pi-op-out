import { z } from "zod";
import { onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke, listen } from "./platform";
import type { DictationEngine } from "../types";

/** A speech model that this device can save from the internet. size and sha256 prove that the saved file is complete and correct. */
interface CatalogModel { id: string; engine: DictationEngine; label: string; file: string; url: string; size: number; sha256: string }

const catalog: CatalogModel[] = [
  {
    id: "whistle", engine: "needle", label: "Whistle (English, German, French, Spanish, Italian, Dutch, Polish)", file: "whistle.cact",
    url: "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact", size: 16_919_407,
    sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
  },
  {
    id: "parakeet-unified-en-0.6b-q8_0", engine: "transcribe.cpp", label: "Parakeet unified 0.6B, English, streaming (Q8_0)", file: "parakeet-unified-en-0.6b-Q8_0.gguf",
    url: "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q8_0.gguf", size: 731_357_568,
    sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
  },
  {
    id: "parakeet-unified-en-0.6b-q4_k_m", engine: "transcribe.cpp", label: "Parakeet unified 0.6B, English, streaming, smaller (Q4_K_M)", file: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
    url: "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q4_K_M.gguf", size: 477_274_496,
    sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
  },
];

/** The saved, saving and failed model files on this device. */
const modelFilesSchema = z.object({
  directory: z.string(),
  items: z.array(z.object({ file: z.string(), saved: z.boolean(), received: z.number().optional(), error: z.string().optional() })),
});

/** A speech model that this device can save. path is set when it is saved; received is set while it is being saved. */
export type DictationModel = { id: string; engine: DictationEngine; label: string; size: number; path?: string; received?: number; error?: string };

function models(files: z.output<typeof modelFilesSchema>): DictationModel[] {
  return catalog.map(model => {
    const item = files.items.find(entry => entry.file === model.file);
    const result: DictationModel = { id: model.id, engine: model.engine, label: model.label, size: model.size };

    if (item?.saved) result.path = `${files.directory}/${model.file}`;

    if (item?.received !== undefined) result.received = item.received;

    if (item?.error !== undefined) result.error = item.error;

    return result;
  });
}

/** Follows the speech models of this device. Each row updates only when its own data changes. */
export function useDictationModels() {
  const [state, setState] = createStore<{ models: DictationModel[]; error?: string }>({ models: [] });
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;

  const apply = (files: z.output<typeof modelFilesSchema>) => { setState("models", reconcile(models(files), { key: "id" })); setState("error", undefined); };

  onMount(() => {
    void listen("pi://dictation-models", ({ payload }) => {
      if (disposed) return;
      revision++; apply(payload);
    }, modelFilesSchema).then(async (stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      const request = ++revision;
      const files = await invoke("dictation_models", undefined, modelFilesSchema);
      if (!disposed && request === revision) apply(files);
    }).catch((reason) => { if (!disposed) setState("error", `Could not read the speech models: ${reason instanceof Error ? reason.message : String(reason)}`); });
  });
  onCleanup(() => { disposed = true; unlisten?.(); });

  return state;
}

function catalogModel(id: string) {
  const model = catalog.find(item => item.id === id);

  if (!model) throw new Error(`Unknown speech model ${id}`);

  return model;
}

export const saveDictationModel = async (id: string) => { const { file, url, size, sha256 } = catalogModel(id); await invoke("dictation_model_save", { file, url, size, sha256 }); };
export const cancelDictationModel = async (id: string) => { await invoke("dictation_model_cancel", { file: catalogModel(id).file }); };
export const removeDictationModel = async (id: string) => { await invoke("dictation_model_remove", { file: catalogModel(id).file }); };
