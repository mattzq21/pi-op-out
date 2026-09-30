import { createSignal, onCleanup } from "solid-js";
import { WorkflowManager } from "./runtime";

export function useWorkflows() {
  const manager = new WorkflowManager();
  const [runs, setRuns] = createSignal(manager.list());
  const [selected, setSelected] = createSignal<string>();
  const unsubscribe = manager.subscribe(() => setRuns(manager.list()));
  const shutdown = () => manager.dispose();
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!manager.list().some((run) => run.status === "running")) return;
    event.preventDefault(); event.returnValue = "";
  };
  window.addEventListener("pagehide", shutdown);
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => { unsubscribe(); manager.dispose(); window.removeEventListener("pagehide", shutdown); window.removeEventListener("beforeunload", beforeUnload); });
  return { manager, runs, selected, setSelected };
}
