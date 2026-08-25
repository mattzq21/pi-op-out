import { useMemo, useState } from "react";
import { ChevronDown, FileDiff, Files } from "lucide-react";
import type { GitDiffSnapshot } from "../types";
import { parseDiff } from "../lib/diff";

export function DiffViewer({ snapshot }: { snapshot: GitDiffSnapshot }) {
  const files = useMemo(() => parseDiff(snapshot), [snapshot]);
  const [open, setOpen] = useState(false);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  if (!files.length) return null;
  return <section className={`diff-viewer${open ? " open" : ""}`} aria-label="Project changes">
    <button className="diff-summary" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{files.length} {files.length === 1 ? "file" : "files"}</span><em className="diff-additions">+{additions}</em><em className="diff-deletions">−{deletions}</em><ChevronDown className="diff-chevron" size={15} />
    </button>
    {open && <div className="diff-files">
      <nav aria-label="Changed files">{files.map((file) => <a key={file.id} href={`#diff-${encodeURIComponent(file.id)}`} title={file.path}><span>{file.path}</span><small><b>+{file.additions}</b> <i>−{file.deletions}</i></small></a>)}</nav>
      <div className="diff-stream">{files.map((file) => <section className="diff-file" id={`diff-${encodeURIComponent(file.id)}`} key={file.id}>
        <header><span>{file.path}</span><small><b>+{file.additions}</b><i>−{file.deletions}</i></small></header>
        <div className="diff-code">{file.lines.map((line, index) => <div className={`diff-line ${line.kind}`} key={index}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code><span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "context" ? " " : ""}</span>{line.parts ? line.parts.map((part, partIndex) => <span className={`diff-token${part.changed ? " changed" : ""}`} key={partIndex}>{part.text}</span>) : <span className={line.kind === "add" || line.kind === "delete" ? "diff-token changed" : undefined}>{line.text}</span>}</code></div>)}</div>
      </section>)}</div>
    </div>}
  </section>;
}
