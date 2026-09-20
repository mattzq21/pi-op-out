import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, Index } from "solid-js";

import { FileDiff, Files } from "lucide-solid";
import type { turnDiff } from "../lib/turnDiff";

export function DiffViewer(componentProps: ReturnType<typeof turnDiff>) {
  const [previewId, setPreviewId] = createSignal<string>();
  const safeFiles = createMemo(() => (Array.isArray(componentProps.files) ? componentProps.files.filter((file) => file && typeof file.id === "string" && typeof file.path === "string" && Array.isArray(file.lines)) : []));
  const safeWarnings = createMemo(() => (Array.isArray(componentProps.warnings) ? componentProps.warnings.filter((warning): warning is string => typeof warning === "string") : []));
  const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const preview = createMemo(() => (safeFiles().find((file) => file.id === previewId())));
  const additions = createMemo(() => (safeFiles().reduce((total, file) => total + count(file.additions), 0)));
  const deletions = createMemo(() => (safeFiles().reduce((total, file) => total + count(file.deletions), 0)));

  return <>{!safeFiles().length && !safeWarnings().length ? (null) : (<section class="diff-viewer" aria-label="File changes">
    <div class="diff-summary"><FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{safeFiles().length} {safeFiles().length === 1 ? "file" : "files"}</span><em class="diff-additions">+{additions()}</em><em class="diff-deletions">−{deletions()}</em></div>
    {<Key each={safeWarnings()} by={(warning) => warning}>{(warning, index) => <div class="diff-line meta" >{warning()}</div>}</Key>}
    <div class="diff-files" onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setPreviewId(undefined); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewId(undefined); }}>
      <nav aria-label="Changed files">{<Key each={safeFiles()} by={(file) => file.id}>{(file, index) => <button class="diff-file-chip" type="button"  title={file().path} onMouseEnter={() => setPreviewId(file().id)} onFocus={() => setPreviewId(file().id)}><span>{file().path}</span><small><b>+{count(file().additions)}</b> <i>−{count(file().deletions)}</i></small></button>}</Key>}</nav>
      {preview() && <section class="diff-file">
        <header><span>{(preview())!.path}</span><small><b>+{count((preview())!.additions)}</b><i>−{count((preview())!.deletions)}</i></small></header>
        <div class="diff-stream" tabIndex={0} aria-label={`${(preview())!.path} diff`}><div class="diff-code">{<Index each={(preview())!.lines}>{(line, index) => <div class={`diff-line ${line().kind}`} ><span>{line().oldLine ?? ""}</span><span>{line().newLine ?? ""}</span><code><span class="diff-sign">{line().kind === "add" ? "+" : line().kind === "delete" ? "−" : line().kind === "context" ? " " : ""}</span>{line().parts ? <Index each={line().parts}>{(part, partIndex) => <span class={`diff-token${part().changed ? " changed" : ""}`} >{part().text}</span>}</Index> : <span class={line().kind === "add" || line().kind === "delete" ? "diff-token changed" : undefined}>{line().text}</span>}</code></div>}</Index>}</div></div>
      </section>}
    </div>
  </section>)}</>;
}
