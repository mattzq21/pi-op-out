import { createSignal, lazy, Show, Suspense, type JSX } from "solid-js";
import type { FileProject, FileReference } from "../lib/projectFiles";
import { FilePaneContext } from "../lib/filePaneContext";
import "./file-pane.css";

export interface FilePaneRequest { project: FileProject; file?: FileReference; }
const FilePane = lazy(() => import("./FilePane").then(module => ({ default: module.FilePane })));

export function FileWorkspace(props: { children: JSX.Element }) {
  const [request, setRequest] = createSignal<FilePaneRequest>();
  const open = (project: FileProject, file?: FileReference) => setRequest({ project, file });
  return <FilePaneContext.Provider value={{ open }}>
    <div class={`chat-with-files${request() ? " files-open" : ""}`}>
      {props.children}
      <Show when={Boolean(request())}><Suspense fallback={<aside class="file-pane" aria-label="Project files"><p role="status">Loading editor…</p></aside>}><FilePane request={request()!} onClose={() => setRequest(undefined)} /></Suspense></Show>
    </div>
  </FilePaneContext.Provider>;
}
