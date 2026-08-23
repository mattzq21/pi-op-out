import { useState } from "react";

interface Props {
  initialPath: string;
  onChooseDirectory: (currentPath: string) => Promise<string | null>;
  onOpen: (path: string) => void;
  onCancel: () => void;
}

export function ProjectDialog({ initialPath, onChooseDirectory, onOpen, onCancel }: Props) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const open = () => { const value = path.trim(); if (!value) { setError("Path can't be empty"); return; } onOpen(value); };
  const choose = async () => {
    setChoosing(true); setError(undefined);
    try { const selected = await onChooseDirectory(path.trim()); if (selected) setPath(selected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChoosing(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <p className="eyebrow">Project</p><h2 id="project-dialog-title">Open project</h2><p>Open Pi in a project directory.</p>
      <input autoFocus aria-label="Project directory" value={path} placeholder="/path/to/project" onChange={(event) => { setPath(event.target.value); setError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") open(); }} />
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="browse-directory" disabled={choosing} onClick={() => void choose()}>{choosing ? "Choosing…" : "Choose directory…"}</button><button onClick={onCancel}>Cancel</button><button className="primary-button" onClick={open}>Open project</button></div>
    </section>
  </div>;
}
