import { useMemo } from "react";
import { FileDiff, Files } from "lucide-react";
import type { GitDiffSnapshot } from "../types";
import { parseDiff } from "../lib/diff";

export function DiffViewer({ snapshot }: { snapshot: GitDiffSnapshot }) {
  const files = useMemo(() => parseDiff(snapshot), [snapshot]);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  if (!files.length) return null;
  return <section className="diff-viewer" aria-label="Project changes">
    <div className="diff-summary"><FileDiff size={16} /><strong>Changes</strong><span><Files size={13} />{files.length} {files.length === 1 ? "file" : "files"}</span><em className="diff-additions">+{additions}</em><em className="diff-deletions">−{deletions}</em></div>
    <div className="diff-files"><nav aria-label="Changed files">{files.map((file) => <div className="diff-file-entry" key={file.id} tabIndex={0}>
      <div className="diff-file-label" title={file.path}><span>{file.path}</span><small><b>+{file.additions}</b> <i>−{file.deletions}</i></small></div>
      <section className="diff-file">
        <header><span>{file.path}</span><small><b>+{file.additions}</b><i>−{file.deletions}</i></small></header>
        <div className="diff-stream"><div className="diff-code">{file.lines.map((line, index) => <div className={`diff-line ${line.kind}`} key={index}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code><span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "context" ? " " : ""}</span>{line.parts ? line.parts.map((part, partIndex) => <span className={`diff-token${part.changed ? " changed" : ""}`} key={partIndex}>{part.text}</span>) : <span className={line.kind === "add" || line.kind === "delete" ? "diff-token changed" : undefined}>{line.text}</span>}</code></div>)}</div></div>
      </section>
    </div>)}</nav></div>
  </section>;
}
