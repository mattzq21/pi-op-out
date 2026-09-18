import { useState } from "react";
import { FileDiff, Files } from "lucide-react";
import type { turnDiff } from "../lib/turnDiff";

export function DiffViewer({ files, warnings }: ReturnType<typeof turnDiff>) {
  const [previewId, setPreviewId] = useState<string>();
  const safeFiles = Array.isArray(files) ? files.filter((file) => file && typeof file.id === "string" && typeof file.path === "string" && Array.isArray(file.lines)) : [];
  const safeWarnings = Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : [];
  const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const preview = safeFiles.find((file) => file.id === previewId);
  const additions = safeFiles.reduce((total, file) => total + count(file.additions), 0);
  const deletions = safeFiles.reduce((total, file) => total + count(file.deletions), 0);
  if (!safeFiles.length && !safeWarnings.length) return null;
  return <section className="diff-viewer" aria-label="File changes">
    <div className="diff-summary"><FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{safeFiles.length} {safeFiles.length === 1 ? "file" : "files"}</span><em className="diff-additions">+{additions}</em><em className="diff-deletions">−{deletions}</em></div>
    {safeWarnings.map((warning) => <div className="diff-line meta" key={warning}>{warning}</div>)}
    <div className="diff-files" onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setPreviewId(undefined); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(undefined); }}>
      <nav aria-label="Changed files">{safeFiles.map((file) => <button className="diff-file-chip" type="button" key={file.id} title={file.path} onMouseEnter={() => setPreviewId(file.id)} onFocus={() => setPreviewId(file.id)}><span>{file.path}</span><small><b>+{count(file.additions)}</b> <i>−{count(file.deletions)}</i></small></button>)}</nav>
      {preview && <section className="diff-file">
        <header><span>{preview.path}</span><small><b>+{count(preview.additions)}</b><i>−{count(preview.deletions)}</i></small></header>
        <div className="diff-stream" tabIndex={0} aria-label={`${preview.path} diff`}><div className="diff-code">{preview.lines.map((line, index) => <div className={`diff-line ${line.kind}`} key={index}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code><span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "context" ? " " : ""}</span>{line.parts ? line.parts.map((part, partIndex) => <span className={`diff-token${part.changed ? " changed" : ""}`} key={partIndex}>{part.text}</span>) : <span className={line.kind === "add" || line.kind === "delete" ? "diff-token changed" : undefined}>{line.text}</span>}</code></div>)}</div></div>
      </section>}
    </div>
  </section>;
}
