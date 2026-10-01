import { z } from "zod";
import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { DeleteArchivesDialog } from "./DeleteArchivesDialog";
import { createDependencyEffect, createRef } from "../lib/solid";

import { Archive, Camera, Database, FolderClock, GitBranch, HardDrive, MessageSquare, RefreshCw, ShieldAlert, Trash2 } from "lucide-solid";
import { deleteArchivedConversation, loadStorageReport, openGroupDirectory, restoreArchivedWorktree } from "../lib/nativeTransport";
import type { ArchivedConversation, HostStorage, StorageCategory, StorageReport } from "../types";

const categoryDetails: Record<StorageCategory["id"], { name: string; description: string; icon: typeof Archive; item: string }> = {
  "active-conversations": { name: "Conversations", description: "Saved chats and their diff histories", icon: MessageSquare, item: "conversation" },
  "archived-conversations": { name: "Conversations", description: "Saved chats and their diff histories", icon: MessageSquare, item: "conversation" },
  "project-checkpoints": { name: "Project checkpoints", description: "Estimated Git objects retained by active session checkpoints, including shared objects", icon: GitBranch, item: "ref" },
  "archived-project-checkpoints": { name: "Project checkpoints", description: "Estimated Git objects retained only by archived session checkpoints", icon: GitBranch, item: "ref" },
  "git-diff-snapshots": { name: "Diff snapshots", description: "Comparison baselines for turn diffs", icon: Camera, item: "snapshot" },
  "archived-git-diff-snapshots": { name: "Diff snapshots", description: "Comparison baselines for turn diffs", icon: Camera, item: "snapshot" },
  "temporary-chats": { name: "No-project workdirs", description: "Working directories for conversations without a project", icon: FolderClock, item: "directory" },
  "worktrees": { name: "Worktrees", description: "Working copies, including dependencies and build outputs", icon: GitBranch, item: "worktree" },
  "archived-worktrees": { name: "No-project workdirs", description: "Working directories for conversations without a project", icon: FolderClock, item: "directory" },
  "other-storage": { name: "Other storage", description: "Settings, caches, logs, and other piop files", icon: HardDrive, item: "directory" },
};

const storageSections: { title: string; categories: StorageCategory["id"][] }[] = [
  { title: "General", categories: ["other-storage"] },
  { title: "Active sessions", categories: ["active-conversations", "git-diff-snapshots", "project-checkpoints", "worktrees", "temporary-chats"] },
  { title: "Archived sessions", categories: ["archived-conversations", "archived-git-diff-snapshots", "archived-project-checkpoints", "archived-worktrees"] },
];

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

  return `${count} ${count === 1 ? item : item === "directory" ? "directories" : `${item}s`}`;
}

function formatDate(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "Unknown date";
  const date = new Date(timestamp * 1000);

  if (Number.isNaN(date.getTime())) return "Unknown date";

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function archiveKey(host: HostStorage, archive: ArchivedConversation) { return `${host.hostId}:${archive.path}`; }

function directoryTitle(hostId: string, directories: string[]) {
  if (hostId !== "local") return "Remote directories cannot be opened in the local file manager";

  return directories.length ? directories.join("\n") : "No stored directory";
}

export function StorageSettings(componentProps: { hostId?: string }) {
  const [report, setReport] = createSignal<StorageReport>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [archiveDeletion, setArchiveDeletion] = createSignal<{ host: HostStorage; archives: ArchivedConversation[] }>();
  const [deleting, setDeleting] = createSignal<Set<string>>((() => new Set())());
  const refreshGeneration = createRef(0);
  const pendingRefreshes = createRef(0);

  const openDirectory = async (directory: string, host: HostStorage) => {
    setError(undefined);

    try { await openGroupDirectory(directory, host.hostId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const refresh = async () => { const capturedHostId0 = componentProps.hostId;
    const generation = ++refreshGeneration.current;
    pendingRefreshes.current += 1;
    setLoading(true); setError(undefined);

    try {
      const next = await loadStorageReport(capturedHostId0);

      if (generation === refreshGeneration.current) setReport(next);
    } catch (reason) {
      if (generation === refreshGeneration.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingRefreshes.current -= 1;

      if (pendingRefreshes.current === 0) setLoading(false);
    }
  };

  createDependencyEffect(() => { void refresh(); }, () => [componentProps.hostId]);

  const removeArchives = async (host: HostStorage, archives: ArchivedConversation[]) => {
    const keys = archives.map((archive) => archiveKey(host, archive));
    setDeleting((current) => new Set([...current, ...keys]));
    setError(undefined);
    const failures: string[] = [];
    const removed = new Set<string>();

    for (const archive of archives) {
      if (removed.has(archive.path)) continue;
      try { for (const path of await deleteArchivedConversation(archive.path, host.hostId)) removed.add(path); }
      catch (reason) { failures.push(`${archive.name}: ${reason instanceof Error ? reason.message : String(reason)}`); }
    }

    if (removed.size) setReport((current) => current ? { hosts: current.hosts.map((candidate) => candidate.hostId === host.hostId ? { ...candidate, archives: candidate.archives.filter((archive) => !removed.has(archive.path)) } : candidate) } : current);
    setDeleting((current) => { const next = new Set(current); keys.forEach((key) => next.delete(key));

      return next; });
    await refresh();

    if (failures.length) setError(failures.join("\n"));
  };

  const deleteOne = (host: HostStorage, archive: ArchivedConversation) => {
    if (!archive.deletable) return;

    if (!window.confirm(`Permanently delete “${archive.name}” and its attached reviews and subagents? Their diff histories, project checkpoint refs, and any archived directory no other chat uses will also be removed. Forks and branch-offs will be kept.`)) return;

    void removeArchives(host, [archive]);
  };

  const changeWorktree = async (host: HostStorage, archive: ArchivedConversation) => {
    const key = archiveKey(host, archive);
    setDeleting((current) => new Set([...current, key]));
    setError(undefined);
    let failure: string | undefined;

    try {
      await restoreArchivedWorktree(archive.path, host.hostId);
    } catch (reason) { failure = reason instanceof Error ? reason.message : String(reason); }
    finally { setDeleting((current) => { const next = new Set(current); next.delete(key);

        return next; }); }

    await refresh();

    if (failure) setError(failure);
  };

  const deleteAll = (host: HostStorage) => {
    const archives = host.archives.filter((archive) => archive.deletable);

    if (archives.length) setArchiveDeletion({ host, archives });

  };

  return <div class="settings-section storage-settings">
    <Show when={archiveDeletion()}>{deletion => <DeleteArchivesDialog count={deletion().archives.length} hostName={deletion().host.hostName} onCancel={() => setArchiveDeletion(undefined)} onConfirm={() => {
      const selected = deletion();
      setArchiveDeletion(undefined);
      void removeArchives(selected.host, selected.archives);
    }} />}</Show>
    <div class="section-title"><div><h2>Storage</h2><p>See what piop stores on each machine and permanently remove archived conversations.</p></div><button class="storage-refresh" disabled={loading() || deleting().size > 0} onClick={() => void refresh()}><RefreshCw size={14} class={loading() ? "spinning" : ""} />{loading() ? "Scanning…" : "Refresh"}</button></div>
    {error() && <div class="storage-error" role="alert">{(error())}</div>}
    {!report() && loading() && <div class="storage-loading" role="status"><HardDrive size={20} />Scanning storage…</div>}
    {<Key each={report()?.hosts} by={host => host.hostId}>{(host, _index) => {
      const total = createMemo(() => (host().categories.reduce((sum, category) => sum + category.byteSize, 0)));
      const approximate = createMemo(() => (host().categories.some((category) => category.estimated && category.byteSize > 0)));
      const maximum = createMemo(() => (Math.max(...host().categories.map((category) => category.byteSize), 1)));
      const deletableArchives = createMemo(() => (host().archives.filter((archive) => archive.deletable)));

      const storageRoot = createMemo(() => host().categories.find((category) => category.id === "other-storage")?.directories?.[0]);

      const renderHostHeader = () => (<header><button type="button" class="config-icon storage-directory-button" aria-label={`Open ${host().hostName} storage directory`} title={host().hostId !== "local" ? "Remote directories cannot be opened in the local file manager" : storageRoot() ?? "Storage directory unavailable"} disabled={host().hostId !== "local" || !storageRoot()} onClick={() => { const directory = storageRoot();

        if (directory) void openDirectory(directory, host()); }}><Database size={16} /></button><span><strong>{host().hostName}</strong><small>{host().error ? "Storage unavailable" : `${approximate() ? "About " : ""}${formatBytes(total())} ${host().warnings.length ? "measured · incomplete" : "total disk usage"}`}</small></span></header>);

      const renderCategories = (categories: StorageCategory[]) => (
        <div class="storage-categories">{<Key each={categories} by={(category) => category.id}>{(category, _index) => {
          const details = createMemo(() => (categoryDetails[category().id])); const CategoryIcon = createMemo(() => (details().icon));
          const directories = createMemo(() => category().directories ?? []);
          const [showDirectories, setShowDirectories] = createSignal(false);

          const openCategory = () => {
            if (directories().length === 1) void openDirectory(directories()[0], host());
            else setShowDirectories((visible) => !visible);
          };

          return <div class="storage-category" >
            <button type="button" class="storage-category-icon storage-directory-button" aria-label={`Open ${details().name} ${directories().length > 1 ? "directories" : "directory"}`} aria-expanded={directories().length > 1 ? showDirectories() : undefined} title={directoryTitle(host().hostId, directories())} disabled={host().hostId !== "local" || !directories().length} onClick={openCategory}><Dynamic component={CategoryIcon()} size={15} /></button>
            <span><strong>{details().name}</strong><small>{details().description} · {itemCount(category())}</small><i><b style={{ width: `${Math.max(category().byteSize ? 2 : 0, category().byteSize / maximum() * 100)}%` }} /></i></span>
            <code>{category().estimated && category().byteSize > 0 ? "~" : ""}{formatBytes(Number(category().byteSize) || 0)}</code>
            {showDirectories() && <div class="storage-directory-list" aria-label={`${details().name} directories`}>{directories().map((directory) => <button type="button" title={directory} onClick={() => void openDirectory(directory, host())}>{directory}</button>)}</div>}
          </div>;
        }}</Key>}</div>
      );

      const renderStorageHostError = () => (<Show when={!host().error} fallback={<div class="storage-host-error" role="alert">{host().error}</div>}>
        {host().warnings.length > 0 && <div class="storage-warning" title={host().warnings.join("\n")}>Storage could not be fully measured at {host().warnings.length} location{host().warnings.length === 1 ? "" : "s"}. The total is incomplete.</div>}
        {storageSections.map((section) => {
          const categories = createMemo(() => section.categories.flatMap((id) => host().categories.filter((category) => category.id === id)));
          const subtotal = createMemo(() => categories().reduce((sum, category) => sum + category.byteSize, 0));
          const estimated = createMemo(() => categories().some((category) => category.estimated && category.byteSize > 0));

          return <section class="storage-group" aria-label={section.title}>
            <div class="storage-group-heading"><h3>{section.title}</h3><code>{estimated() ? "~" : ""}{formatBytes(subtotal())}</code></div>
            {renderCategories(categories())}
            {section.title === "Archived sessions" && <>
              <div class="archive-heading"><span><strong>Archived conversations</strong><small>{host().archives.length ? `${host().archives.length} stored on ${host().hostName}` : `No archives on ${host().hostName}`}</small></span>{deletableArchives().length > 1 && <button class="storage-delete-all" disabled={deleting().size > 0 || loading()} onClick={() => deleteAll(host())}><Trash2 size={13} />{deletableArchives().length === host().archives.length ? "Delete all" : "Delete available"}</button>}</div>
              {host().archives.length > 0 && <div class="archive-list">{<Key each={host().archives} by={archive => archive.path}>{(archive, _index) => {
                if (!z.object({ path: z.string() }).safeParse(archive()).success) return null;
                const name = createMemo(() => (z.string().catch(archive().path).parse(archive().name)));
                const key = createMemo(() => (archiveKey(host(), { ...archive(), name: name() }))); const pending = createMemo(() => (deleting().has(key())));
                const renderArchiveDetails = () => (<span><strong>{name()}</strong><small>{archive().deletable ? `${z.string().catch("").parse(archive().cwd)} · ${formatDate(archive().modifiedAt)}` : `Cleanup unavailable · ${archive().deleteError}`}</small></span>);
                const renderArchiveDelete = () => (<button aria-label={archive().deletable ? `Permanently delete ${name()}` : `Cannot safely delete ${name()}: ${archive().deleteError}`} disabled={!archive().deletable || deleting().size > 0 || loading()} onClick={() => deleteOne(host(), archive())}>{!archive().deletable ? <ShieldAlert size={14} /> : pending() ? <RefreshCw size={14} class="spinning" /> : <Trash2 size={14} />}</button>);

                const renderWorktreeAction = () => ((!archive().worktreePath && archive().restorable) && <button class="archive-worktree-action" disabled={deleting().size > 0 || loading()} onClick={() => void changeWorktree(host(), archive())}>{pending() ? "Working…" : "Restore conversation"}</button>);

                return <div class={`archive-row${archive().deletable ? "" : " cleanup-unavailable"}`}  title={archive().deleteError || archive().path}>
                  {renderArchiveDetails()}
                  <code>{formatBytes(Number(archive().byteSize) || 0)}</code>
                  {renderWorktreeAction()}
                  {archive().restoreError && <small role="status">{archive().restoreError}</small>}
                  {renderArchiveDelete()}
                </div>;
              }}</Key>}</div>}
            </>}
          </section>;
        })}
      </Show>);

      return <section class="storage-host" >
        {renderHostHeader()}
        {renderStorageHostError()}
      </section>;
    }}</Key>}
  </div>;
}
