import { createSignal, For, lazy, Suspense, type Accessor, type Setter, type JSX } from "solid-js";
import type { FileProject, FileReference } from "../lib/projectFiles";
import { FilePaneContext } from "../lib/filePaneContext";
import "./file-pane.css";

export interface FilePaneRequest { project: FileProject; file?: FileReference; }
const FilePane = lazy(() => import("./FilePane").then(module => ({ default: module.FilePane })));

export function FileWorkspace(props: { sessionKey: string; children: JSX.Element; onDirtyChange?: (key: string, dirty: boolean) => void }) {
  const [panes, setPanes] = createSignal<{ key: string; request: Accessor<FilePaneRequest>; setRequest: Setter<FilePaneRequest> }[]>([]);
  const open = (project: FileProject, file?: FileReference) => {
    const existing = panes().find(pane => pane.key === props.sessionKey);
    if (existing) existing.setRequest({ project, file });
    else {
      const [request, setRequest] = createSignal<FilePaneRequest>({ project, file });
      setPanes(current => [...current, { key: props.sessionKey, request, setRequest }]);
    }
  };
  return <FilePaneContext.Provider value={{ open }}>
    <div class={`chat-with-files${panes().some(pane => pane.key === props.sessionKey) ? " files-open" : ""}`}>
      {props.children}
      <For each={panes()}>{pane => <Suspense fallback={<aside class="file-pane" hidden={pane.key !== props.sessionKey} aria-label="Project files"><p role="status">Loading editor…</p></aside>}><FilePane hidden={pane.key !== props.sessionKey} request={pane.request()} onDirtyChange={dirty => props.onDirtyChange?.(pane.key, dirty)} onClose={() => setPanes(current => current.filter(item => item !== pane))} /></Suspense>}</For>
    </div>
  </FilePaneContext.Provider>;
}
