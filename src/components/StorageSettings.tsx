import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Camera, Database, FolderClock, GitBranch, HardDrive, MessageSquare, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { deleteArchivedConversation, loadStorageReport } from "../lib/nativeTransport";
import type { ArchivedConversation, HostStorage, StorageCategory, StorageReport } from "../types";

const categoryDetails: Record<StorageCategory["id"], { name: string; description: string; icon: typeof Archive; item: string }> = {
  "active-conversations": { name: "Active conversations", description: "Saved chats and their diff histories", icon: MessageSquare, item: "conversation" },
  "archived-conversations": { name: "Archived conversations", description: "Archived chats and their diff histories", icon: Archive, item: "conversation" },
  "project-checkpoints": { name: "Project checkpoints", description: "Estimated Git objects retained only by piop checkpoint refs", icon: GitBranch, item: "ref" },
  "git-diff-snapshots": { name: "Diff snapshots", description: "Temporary Git state used to calculate turn diffs", icon: Camera, item: "snapshot" },
  "temporary-chats": { name: "Temporary conversations", description: "Projectless conversation working directories", icon: FolderClock, item: "directory" },
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) { value /= 1024; unit = units[index]; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function itemCount(category: StorageCategory) {
  const item = categoryDetails[category.id]?.item ?? "item";
  const count = Number.isFinite(category.itemCount) ? category.itemCount : 0;
  return `${count} ${item}${count === 1 ? "" : "s"}`;
}

function formatDate(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "Unknown date";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function archiveKey(host: HostStorage, archive: ArchivedConversation) { return `${host.hostId}:${archive.path}`; }

export function StorageSettings({ hostId }: { hostId?: string }) {
  const [report, setReport] = useState<StorageReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  const refreshGeneration = useRef(0);
  const pendingRefreshes = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    pendingRefreshes.current += 1;
    setLoading(true); setError(undefined);
    try {
      const next = await loadStorageReport(hostId);
      if (generation === refreshGeneration.current) setReport(next);
    } catch (reason) {
      if (generation === refreshGeneration.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingRefreshes.current -= 1;
      if (pendingRefreshes.current === 0) setLoading(false);
    }
  }, [hostId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const removeArchives = async (host: HostStorage, archives: ArchivedConversation[]) => {
    const keys = archives.map((archive) => archiveKey(host, archive));
    setDeleting((current) => new Set([...current, ...keys]));
    setError(undefined);
    const failures: string[] = [];
    const removed = new Set<string>();
    for (const archive of archives) {
      try { await deleteArchivedConversation(archive.path, host.hostId); removed.add(archive.path); }
      catch (reason) { failures.push(`${archive.name}: ${reason instanceof Error ? reason.message : String(reason)}`); }
    }
    if (removed.size) setReport((current) => current ? { hosts: current.hosts.map((candidate) => candidate.hostId === host.hostId ? { ...candidate, archives: candidate.archives.filter((archive) => !removed.has(archive.path)) } : candidate) } : current);
    setDeleting((current) => { const next = new Set(current); keys.forEach((key) => next.delete(key)); return next; });
    await refresh();
    if (failures.length) setError(failures.join("\n"));
  };

  const deleteOne = (host: HostStorage, archive: ArchivedConversation) => {
    if (!archive.deletable) return;
    if (!window.confirm(`Permanently delete “${archive.name}”? Its diff history and project checkpoint refs will also be removed.`)) return;
    void removeArchives(host, [archive]);
  };
  const deleteAll = (host: HostStorage) => {
    const archives = host.archives.filter((archive) => archive.deletable);
    if (!archives.length || !window.confirm(`Permanently delete ${archives.length === host.archives.length ? `all ${archives.length}` : `the ${archives.length} safely readable`} archived conversations on ${host.hostName}? Their diff histories and project checkpoint refs will also be removed.`)) return;
    void removeArchives(host, archives);
  };

  return <div className="settings-section storage-settings">
    <div className="section-title"><div><h2>Storage</h2><p>See what piop stores on each machine and permanently remove archived conversations.</p></div><button className="storage-refresh" disabled={loading || deleting.size > 0} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spinning" : ""} />{loading ? "Scanning…" : "Refresh"}</button></div>
    {error && <div className="storage-error" role="alert">{error}</div>}
    {!report && loading && <div className="storage-loading" role="status"><HardDrive size={20} />Scanning storage…</div>}
    {report?.hosts.map((host) => {
      const total = host.categories.reduce((sum, category) => sum + category.byteSize, 0);
      const approximate = host.categories.some((category) => category.estimated && category.byteSize > 0);
      const maximum = Math.max(...host.categories.map((category) => category.byteSize), 1);
      const deletableArchives = host.archives.filter((archive) => archive.deletable);
      const renderHostHeader = () => (<header><span className="config-icon"><Database size={16} /></span><span><strong>{host.hostName}</strong><small>{host.error ? "Storage unavailable" : `${approximate ? "About " : ""}${formatBytes(total)} tracked`}</small></span></header>);
      const renderStorageHostError = () => (host.error ? <div className="storage-host-error" role="alert">{host.error}</div> : <>
        <div className="storage-categories">{host.categories.filter((category) => category && categoryDetails[category.id]).map((category) => {
          const details = categoryDetails[category.id]; const CategoryIcon = details.icon;
          return <div className="storage-category" key={category.id}>
            <span className="storage-category-icon"><CategoryIcon size={15} /></span>
            <span><strong>{details.name}</strong><small>{details.description} · {itemCount(category)}</small><i><b style={{ width: `${Math.max(category.byteSize ? 2 : 0, category.byteSize / maximum * 100)}%` }} /></i></span>
            <code>{category.estimated && category.byteSize > 0 ? "~" : ""}{formatBytes(Number(category.byteSize) || 0)}</code>
          </div>;
        })}</div>
        {host.warnings.length > 0 && <div className="storage-warning" title={host.warnings.join("\n")}>Checkpoint size could not be measured for {host.warnings.length} checkpoint location{host.warnings.length === 1 ? "" : "s"}; other totals are unaffected.</div>}
        <div className="archive-heading"><span><strong>Archived conversations</strong><small>{host.archives.length ? `${host.archives.length} stored on ${host.hostName}` : `No archives on ${host.hostName}`}</small></span>{deletableArchives.length > 1 && <button className="storage-delete-all" disabled={deleting.size > 0 || loading} onClick={() => deleteAll(host)}><Trash2 size={13} />{deletableArchives.length === host.archives.length ? "Delete all" : "Delete available"}</button>}</div>
        {host.archives.length > 0 && <div className="archive-list">{host.archives.map((archive, index) => {
          if (!archive || typeof archive.path !== "string") return null;
          const name = typeof archive.name === "string" ? archive.name : archive.path;
          const key = archiveKey(host, { ...archive, name }); const pending = deleting.has(key);
          const renderArchiveDetails = () => (<span><strong>{name}</strong><small>{archive.deletable ? `${typeof archive.cwd === "string" ? archive.cwd : ""} · ${formatDate(archive.modifiedAt)}` : `Cleanup unavailable · ${archive.deleteError}`}</small></span>);
          const renderArchiveDelete = () => (<button aria-label={archive.deletable ? `Permanently delete ${name}` : `Cannot safely delete ${name}: ${archive.deleteError}`} disabled={!archive.deletable || deleting.size > 0 || loading} onClick={() => deleteOne(host, archive)}>{!archive.deletable ? <ShieldAlert size={14} /> : pending ? <RefreshCw size={14} className="spinning" /> : <Trash2 size={14} />}</button>);
          return <div className={`archive-row${archive.deletable ? "" : " cleanup-unavailable"}`} key={key} title={archive.deleteError || archive.path}>
            {renderArchiveDetails()}
            <code>{formatBytes(Number(archive.byteSize) || 0)}</code>
            {renderArchiveDelete()}
          </div>;
        })}</div>}
      </>);
      return <section className="storage-host" key={host.hostId}>
        {renderHostHeader()}
        {renderStorageHostError()}
      </section>;
    })}
  </div>;
}
