import { Key } from "@solid-primitives/keyed";
import { createEffect, createMemo, createSignal, Index, onCleanup, Show } from "solid-js";

import { FileDiff, Files } from "lucide-solid";
import type { turnDiff } from "../../lib/turnDiff";
import { diffFileSchema } from "../../lib/diffSchemas";
import { stringsSchema, validItems } from "../../lib/messageSchemas";
import type { DiffFile as ParsedDiffFile } from "../../lib/diff";
import "./diff.css";

const diffFilesSchema = validItems(diffFileSchema).catch([]);

const fileStatus = (file: Pick<ParsedDiffFile, 'status'>) => ({ added: '+file', deleted: '−file', modified: 'modified', renamed: 'renamed' })[file.status];

const canPreview = (file: ParsedDiffFile | undefined) => !!file && !file.omitted && !file.previewOmitted && file.lines.some(line => line.kind !== 'meta');

function unavailablePreview(file: ParsedDiffFile) {
  if (file.omitted === "binary") return "Binary file changes cannot be previewed.";

  if (file.omitted === "large" || file.previewOmitted) return "This file is too large to preview.";

  return "This file has no text changes to preview.";
}

export function DiffViewer(componentProps: ReturnType<typeof turnDiff> & { persistent?: boolean }) {
  const [previewId, setPreviewId] = createSignal<string>();
  let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = () => { clearTimeout(closeTimeout); closeTimeout = undefined; };

  const closePreview = () => { cancelClose(); setPreviewId(undefined); };

  const scheduleClose = () => { if (!componentProps.persistent && closeTimeout === undefined) closeTimeout = setTimeout(closePreview, 150); };

  let activeChip: HTMLButtonElement | undefined;
  let previewElement: HTMLElement | undefined;

  const openPreview = (id: string, chip: HTMLButtonElement) => {
    const file = safeFiles().find(file => file.id === id);

    if (!file || (!componentProps.persistent && !canPreview(file))) {
      closePreview();

      return;
    }

    cancelClose(); activeChip = chip; setPreviewId(id);
  };

  onCleanup(cancelClose);
  let filesElement: HTMLDivElement | undefined;
  createEffect(() => {
    if (componentProps.persistent || !previewId()) return;

    const trackPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = event.target instanceof Node ? event.target : null;

      if (activeChip?.contains(target) || previewElement?.contains(target)) cancelClose();
      else scheduleClose();
    };

    const leaveWindow = (event: PointerEvent) => { if (!event.relatedTarget) closePreview(); };

    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePreview(); };

    document.addEventListener("pointermove", trackPointer, true);
    document.addEventListener("pointerout", leaveWindow, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", closePreview);
    onCleanup(() => {
      document.removeEventListener("pointermove", trackPointer, true);
      document.removeEventListener("pointerout", leaveWindow, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", closePreview);
    });
  });
  const [placement, setPlacement] = createSignal({ below: false, height: 300 });
  createEffect(() => {
    if (componentProps.persistent || !previewId()) return;

    const position = () => {
      const bounds = filesElement?.getBoundingClientRect();

      if (!bounds) return;
      const above = bounds.top - 8; const below = window.innerHeight - bounds.bottom - 8;
      setPlacement({ below: below > above, height: Math.max(0, Math.min(620, Math.max(above, below) - 37)) });
    };

    position(); window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    onCleanup(() => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); });
  });
  const safeFiles = createMemo(() => diffFilesSchema.parse(componentProps.files));
  const safeWarnings = createMemo(() => stringsSchema.catch([]).parse(componentProps.warnings));

  const preview = createMemo(() => componentProps.persistent
    ? safeFiles().find(file => file.id === previewId()) ?? safeFiles()[0]
    : safeFiles().find(file => file.id === previewId() && canPreview(file)));

  const previewLines = createMemo(() => preview()?.lines.filter(line => line.kind !== "meta") ?? []);
  const additions = createMemo(() => (safeFiles().reduce((total, file) => total + file.additions, 0)));
  const deletions = createMemo(() => (safeFiles().reduce((total, file) => total + file.deletions, 0)));

  return <>{!safeFiles().length && !safeWarnings().length ? (null) : (<section class="diff-viewer" aria-label="File changes">
    <div class="diff-summary"><FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{safeFiles().length} {safeFiles().length === 1 ? "file" : "files"}</span><Show when={additions() || deletions()}><em class="diff-additions">+{additions()}</em><em class="diff-deletions">−{deletions()}</em></Show></div>
    {<Key each={safeWarnings()} by={(warning) => warning}>{(warning, _index) => <div class="diff-line meta" >{warning()}</div>}</Key>}
    <div ref={filesElement} class="diff-files" onMouseLeave={() => { if (!componentProps.persistent) closePreview(); }} onFocusOut={(event) => { if (!componentProps.persistent && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) closePreview(); }}>
      <nav aria-label="Changed files">{<Key each={safeFiles()} by={(file) => file.id}>{(file, _index) => <button class="diff-file-chip" type="button" data-tooltip={file().path} aria-pressed={componentProps.persistent ? preview()?.id === file().id : undefined} onClick={event => openPreview(file().id, event.currentTarget)} onMouseEnter={event => { if (!componentProps.persistent) openPreview(file().id, event.currentTarget); }} onMouseLeave={scheduleClose} onFocus={event => openPreview(file().id, event.currentTarget)}><span>{file().path}</span><small><Show when={!file().omitted && (file().additions || file().deletions)} fallback={fileStatus(file())}><b>+{file().additions}</b> <i>−{file().deletions}</i></Show></small></button>}</Key>}</nav>
      <Show when={preview()}>{file => <section ref={previewElement} class="diff-file" onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onFocusIn={cancelClose} style={componentProps.persistent ? undefined : { top: placement().below ? "100%" : "auto", bottom: placement().below ? "auto" : "100%" }}>
        <header><span>{file().path}</span><small><b>+{file().additions}</b><i>−{file().deletions}</i></small></header>
        <div class="diff-stream" style={componentProps.persistent ? undefined : { "max-height": `${placement().height}px` }} tabIndex={0} aria-label={`${file().path} diff`}><Show when={previewLines().length} fallback={<p class="diff-preview-unavailable">{unavailablePreview(file())}</p>}><div class="diff-code">{<Index each={previewLines()}>{(line, _index) => <div class={`diff-line ${line().kind}`} ><span>{line().oldLine ?? ""}</span><span>{line().newLine ?? ""}</span><code><span class="diff-sign">{line().kind === "add" ? "+" : line().kind === "delete" ? "−" : line().kind === "context" ? " " : ""}</span>{line().parts ? <Index each={line().parts}>{(part, _partIndex) => <span class={`diff-token${part().changed ? " changed" : ""}`} >{part().text}</span>}</Index> : <span class={line().kind === "add" || line().kind === "delete" ? "diff-token changed" : undefined}>{line().text}</span>}</code></div>}</Index>}</div></Show></div>
      </section>}</Show>
    </div>
  </section>)}</>;
}
