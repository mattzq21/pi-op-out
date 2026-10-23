import { z } from "zod";
import { Key } from "@solid-primitives/keyed";
import { createMemo, createSignal, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { DeleteArchivesDialog } from "./DeleteArchivesDialog";
import { createDependencyEffect, createRef } from "../lib/solid";

import { Archive, Database, FolderClock, HardDrive, MessageSquare, RefreshCw, ShieldAlert, Trash2 } from "lucide-solid";
import { deleteArchivedConversations, loadStorageReport, openGroupDirectory } from "../lib/nativeTransport";
import { storageFailureText } from "../lib/storageFailure";
import type { ArchivedConversation, HostStorage, StorageCategory, StorageReport, StorageRoot } from "../types";

function includesTemporaryFolder(host: HostStorage, archives: ArchivedConversation[]) {
  const roots = host.categories.find(category => category.id === "temporary-chats")?.roots ?? [];

  return roots.some(root => archives.some(archive => root.owners.some(owner => owner.sessionId === archive.id)
    || archive.cwd === root.path || archive.cwd.startsWith(root.path + "/")));
}

const categoryDetails: Record<StorageCategory["id"], { name: string; description: string; icon: typeof Archive; item: string }> = {
  "active-conversations": { name: "Conversations", description: "Saved chats", icon: MessageSquare, item: "conversation" },
  "archived-conversations": { name: "Conversations", description: "Saved chats", icon: MessageSquare, item: "conversation" },
  "temporary-chats": { name: "No-project workdirs", description: "Working directories for conversations without a project", icon: FolderClock, item: "directory" },
  "other-storage": { name: "Other storage", description: "Settings, caches, logs, and other piop files", icon: HardDrive, item: "file" },
  "recovery-storage": { name: "Managed recovery", description: "Durable recovery containers with ownership records", icon: FolderClock, item: "recovery" },
  "unattributed-recovery-storage": { name: "Unresolved recovery storage", description: "Loose recovery files or unverified ownership records", icon: ShieldAlert, item: "recovery" },
  "goal-attachments": { name: "Goal assets", description: "Objective files and attachments owned by surviving history and forks", icon: Archive, item: "asset directory" },
  "unattributed-goal-attachments": { name: "Unattributed goal assets", description: "No readable surviving owner found · ownership unresolved", icon: ShieldAlert, item: "asset directory" },
};

const storageSections: { title: string; categories: StorageCategory["id"][] }[] = [
  { title: "General and shared history", categories: ["other-storage", "goal-attachments"] },
  { title: "Active sessions", categories: ["active-conversations"] },
  { title: "Archived sessions", categories: ["archived-conversations"] },
  { title: "Managed directories", categories: ["temporary-chats", "recovery-storage"] },
  { title: "Unresolved and temporary storage", categories: ["unattributed-recovery-storage", "unattributed-goal-attachments"] },
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
  const item = category.countUnit ?? categoryDetails[category.id]?.item ?? "item";
  const count = Number.isFinite(category.itemCount) ? category.itemCount : 0;
  const plural = item.endsWith("directory") ? item.replace(/directory$/, "directories") : item === "recovery" ? "recoveries" : `${item}s`;

  const incomplete = category.roots?.some(root => !root.available) ? " observed · incomplete" : "";

  return `${count} ${count === 1 ? item : plural}${incomplete}`;
}

function categoryAccounting(category: StorageCategory) {
  const ownership = { owned: "Piop-owned", referenced: "Referenced; ownership unproven", shared: "Shared by surviving owners or profiles", unattributed: "Ownership unresolved" };
  const reclaimability = { retained: "Retained by active owners", "requires-owner-check": "Reclaimable space requires checking all owners", unknown: "Reclaimable space unknown" };

  return `${category.ownership ? ownership[category.ownership] : "Ownership not reported"} · ${category.reclaimability ? reclaimability[category.reclaimability] : "Reclaimable space unknown"}`;
}

function countedBytes(category: StorageCategory) { return category.includedInTotal === false ? 0 : category.byteSize; }

function rootDetails(root: StorageRoot) {
  const owners = root.owners.map(owner => `${owner.sessionId} (${owner.kind})${owner.sessionPath ? ` — ${owner.sessionPath}` : ""}`).join("; ");

  return <div><strong>{root.path}</strong><small>{root.ownership} · {root.available ? "Available" : "Unavailable; size incomplete"}{root.state ? ` · ${root.state}` : ""}</small><small>{root.provenance.join(" · ")}</small><small>{owners || "No verified conversation owners reported"}</small></div>;
}

function coverageDetails(category: StorageCategory) {
  return <details><summary>Coverage and ownership</summary><p>{category.coverage ?? "Coverage was not reported by this host. Category bytes do not establish reclaimable space."}</p>{category.roots?.map(rootDetails)}</details>;
}

function categorySize(category: StorageCategory) {
  const prefix = category.estimated && category.byteSize > 0 ? "~" : "";
  const suffix = category.roots?.some(root => !root.available) ? " measured" : "";

  return `${prefix}${formatBytes(Number(category.byteSize) || 0)}${suffix}${category.includedInTotal === false ? " excluded" : ""}`;
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
    if (!archives.length) return;
    const keys = archives.map((archive) => archiveKey(host, archive));
    setDeleting((current) => new Set([...current, ...keys]));
    setError(undefined);
    let failure: string | undefined;
    const removed = new Set<string>();

    try { for (const path of await deleteArchivedConversations(archives.map(archive => archive.path), host.hostId)) removed.add(path); }
    catch (reason) { failure = storageFailureText("delete", reason, archives.length); }

    if (removed.size) setReport((current) => current ? { hosts: current.hosts.map((candidate) => candidate.hostId === host.hostId ? { ...candidate, archives: candidate.archives.filter((archive) => !removed.has(archive.path)) } : candidate) } : current);
    setDeleting((current) => { const next = new Set(current); keys.forEach((key) => next.delete(key));

      return next; });
    await refresh();

    if (failure) setError(failure);
  };

  const deleteOne = (host: HostStorage, archive: ArchivedConversation) => {
    if (!archive.deletable) return;

    const folderWarning = includesTemporaryFolder(host, [archive]) ? " Temporary folders that no other chat uses will also be deleted, with all their files." : "";

    if (!window.confirm(`Permanently delete “${archive.name}” and its attached reviews and subagents?${folderWarning} Forks will be kept.`)) return;

    void removeArchives(host, [archive]);
  };

  const deleteAll = (host: HostStorage) => {
    const archives = host.archives.filter((archive) => archive.deletable);

    if (archives.length) setArchiveDeletion({ host, archives });

  };

  return <div class="settings-section storage-settings">
    <Show when={archiveDeletion()}>{deletion => <DeleteArchivesDialog count={deletion().archives.length} hostName={deletion().host.hostName} includesTemporaryFolder={includesTemporaryFolder(deletion().host, deletion().archives)} onCancel={() => setArchiveDeletion(undefined)} onConfirm={() => {
      const selected = deletion();
      setArchiveDeletion(undefined);
      void removeArchives(selected.host, selected.archives);
    }} />}</Show>
    <div class="section-title"><div><h2>Storage</h2><p>Storage used on each host.</p></div><button class="storage-refresh" disabled={loading() || deleting().size > 0} onClick={() => void refresh()}><RefreshCw size={14} class={loading() ? "spinning" : ""} />{loading() ? "Scanning…" : "Refresh"}</button></div>
    {error() && <div class="storage-error" role="alert">{(error())}</div>}
    {!report() && loading() && <div class="storage-loading" role="status"><HardDrive size={20} />Scanning storage…</div>}
    {<Key each={report()?.hosts} by={host => host.hostId}>{(host, _index) => {
      const total = createMemo(() => (host().categories.reduce((sum, category) => sum + countedBytes(category), 0)));
      const approximate = createMemo(() => (host().categories.some((category) => category.estimated && category.byteSize > 0)));
      const maximum = createMemo(() => (Math.max(...host().categories.map((category) => category.byteSize), 1)));
      const deletableArchives = createMemo(() => (host().archives.filter((archive) => archive.deletable)));

      const storageRoot = createMemo(() => host().categories.find((category) => category.id === "other-storage")?.directories?.[0]);

      const renderHostHeader = () => (<header><button type="button" class="config-icon storage-directory-button" aria-label={`Open ${host().hostName} storage directory`} data-tooltip={host().hostId !== "local" ? "Remote directories cannot be opened in the local file manager" : storageRoot() ?? "Storage directory unavailable"} disabled={host().hostId !== "local" || !storageRoot()} onClick={() => { const directory = storageRoot();

        if (directory) void openDirectory(directory, host()); }}><Database size={16} /></button><span><strong>{host().hostName}</strong><small>{host().error ? "Storage unavailable" : `${approximate() ? "About " : ""}${formatBytes(total())} accounted storage${host().warnings.length ? " · incomplete" : ""}`}</small></span></header>);

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
            <button type="button" class="storage-category-icon storage-directory-button" aria-label={`Open ${details().name} ${directories().length > 1 ? "directories" : "directory"}`} aria-expanded={directories().length > 1 ? showDirectories() : undefined} data-tooltip={directoryTitle(host().hostId, directories())} disabled={host().hostId !== "local" || !directories().length} onClick={openCategory}><Dynamic component={CategoryIcon()} size={15} /></button>
            <span><strong>{details().name}</strong><small>{details().description} · {itemCount(category())}</small><small>{categoryAccounting(category())}</small><i><b style={{ width: `${Math.max(category().byteSize ? 2 : 0, category().byteSize / maximum() * 100)}%` }} /></i>
              {coverageDetails(category())}
            </span>
            <code>{categorySize(category())}</code>
            {showDirectories() && <div class="storage-directory-list" aria-label={`${details().name} directories`}>{directories().map((directory) => <button type="button" data-tooltip={directory} onClick={() => void openDirectory(directory, host())}>{directory}</button>)}</div>}
          </div>;
        }}</Key>}</div>
      );

      const renderStorageHostError = () => (<Show when={!host().error} fallback={<div class="storage-host-error" role="alert">{host().error}</div>}>
        {host().warnings.length > 0 && <div class="storage-warning"><details><summary>Storage coverage is incomplete · {host().warnings.length} warning{host().warnings.length === 1 ? "" : "s"}</summary>{host().warnings.map(warning => <p>{warning}</p>)}</details></div>}
        {storageSections.map((section) => {
          const categories = createMemo(() => section.categories.flatMap((id) => host().categories.filter((category) => category.id === id)));
          const subtotal = createMemo(() => categories().reduce((sum, category) => sum + countedBytes(category), 0));
          const estimated = createMemo(() => categories().some((category) => category.estimated && category.byteSize > 0));

          return <section class="storage-group" aria-label={section.title}>
            <div class="storage-group-heading"><h3>{section.title}</h3><code>{`${estimated() ? "~" : ""}${formatBytes(subtotal())}`}</code></div>
            {renderCategories(categories())}
            {section.title === "Archived sessions" && <>
              <div class="archive-heading"><span><strong>Archived conversations</strong><small>{host().archives.length ? `${host().archives.length} stored on ${host().hostName}` : `No archives on ${host().hostName}`}</small></span>{deletableArchives().length > 1 && <button class="storage-delete-all" disabled={deleting().size > 0 || loading()} onClick={() => deleteAll(host())}><Trash2 size={13} />{deletableArchives().length === host().archives.length ? "Delete all" : "Delete available"}</button>}</div>
              {host().archives.length > 0 && <div class="archive-list">{<Key each={host().archives} by={archive => archive.path}>{(archive, _index) => {
                if (!z.object({ path: z.string() }).safeParse(archive()).success) return null;
                const name = createMemo(() => (z.string().catch(archive().path).parse(archive().name)));
                const key = createMemo(() => (archiveKey(host(), { ...archive(), name: name() }))); const pending = createMemo(() => (deleting().has(key())));
                const renderArchiveDetails = () => (<span><strong>{name()}</strong><small>{archive().deletable ? `${z.string().catch("").parse(archive().cwd)} · ${formatDate(archive().modifiedAt)}` : `Cleanup unavailable · ${archive().deleteError}`}</small><small data-tooltip={archive().byteSizeCoverage ?? "Chat file size only; other saved files and shared assets are excluded. Freed disk space is unknown."}>Chat file only · logical size · freed space unknown</small></span>);
                const renderArchiveDelete = () => (<button aria-label={archive().deletable ? `Permanently delete ${name()}` : `Cannot safely delete ${name()}: ${archive().deleteError}`} disabled={!archive().deletable || deleting().size > 0 || loading()} onClick={() => deleteOne(host(), archive())}>{!archive().deletable ? <ShieldAlert size={14} /> : pending() ? <RefreshCw size={14} class="spinning" /> : <Trash2 size={14} />}</button>);

                return <div class={`archive-row${archive().deletable ? "" : " cleanup-unavailable"}`}  data-tooltip={archive().deleteError || archive().path}>
                  {renderArchiveDetails()}
                  <code>{formatBytes(Number(archive().byteSize) || 0)}</code>
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
