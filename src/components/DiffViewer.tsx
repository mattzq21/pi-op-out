import { useMemo, useState } from "react";
import { FileDiff, Files } from "lucide-react";
import type { GitDiffSnapshot } from "../types";
import { parseDiff } from "../lib/diff";

export function DiffViewer({ snapshot }: { snapshot: GitDiffSnapshot }) {
  const files = useMemo(() => parseDiff(snapshot), [snapshot]);
  const [previewId, setPreviewId] = useState<string>();
  const preview = files.find((file) => file.id === previewId);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  if (!files.length) return null;
  return <section className="diff-viewer" aria-label="Project changes">
    <div className="diff-summary"><FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{files.length} {files.length === 1 ? "file" : "files"}</span><em className="diff-additions">+{additions}</em><em className="diff-deletions">−{deletions}</em></div>
    <div className="diff-files" onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setPreviewId(undefined); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(undefined); }}>
      <nav aria-label="Changed files">{files.map((file) => <button className="diff-file-chip" type="button" key={file.id} title={file.path} onMouseEnter={() => setPreviewId(file.id)} onFocus={() => setPreviewId(file.id)}><span>{file.path}</span><small><b>+{file.additions}</b> <i>−{file.deletions}</i></small></button>)}</nav>
      {preview && <section className="diff-file">
        <header><span>{preview.path}</span><small><b>+{preview.additions}</b><i>−{preview.deletions}</i></small></header>
        <div className="diff-stream" tabIndex={0} aria-label={`${preview.path} diff`}><div className="diff-code">{preview.lines.map((line, index) => <div className={`diff-line ${line.kind}`} key={index}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code><span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "context" ? " " : ""}</span>{line.parts ? line.parts.map((part, partIndex) => <span className={`diff-token${part.changed ? " changed" : ""}`} key={partIndex}>{part.text}</span>) : <span className={line.kind === "add" || line.kind === "delete" ? "diff-token changed" : undefined}>{line.text}</span>}</code></div>)}</div></div>
      </section>}
    </div>
  </section>;
}
