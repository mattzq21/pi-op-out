import { Key } from "@solid-primitives/keyed";
import { Archive, ArchiveRestore, RefreshCw, Search } from "lucide-solid";
import { createMemo, createSignal, Show } from "solid-js";
import { loadStorageReport, restoreArchivedConversation } from "../lib/nativeTransport";
import { createDependencyEffect, createRef } from "../lib/solid";
import { IconButton } from "./IconButton";
import type { StorageReport } from "../types";

export function ArchivedSessionPanel() {
  const [report, setReport] = createSignal<StorageReport>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [query, setQuery] = createSignal("");
  const [restoring, setRestoring] = createSignal<string>();
  const searchRef = createRef<HTMLInputElement>(null);

  const refresh = async () => {
    if (loading()) return;
    setLoading(true); setError(undefined);

    try { setReport(await loadStorageReport()); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };

  createDependencyEffect(() => { void refresh(); }, () => []);

  const restore = async (hostId: string, path: string) => {
    if (restoring()) return;
    setRestoring(`${hostId}:${path}`); setError(undefined);

    try {
      await restoreArchivedConversation(path, hostId);
      setReport(current => current ? { hosts: current.hosts.map(host => host.hostId === hostId ? { ...host, archives: host.archives.filter(archive => archive.path !== path) } : host) } : current);
    } catch (reason) { setError(`Could not restore conversation: ${String(reason)}`); }
    finally { setRestoring(undefined); }
  };

  const hosts = createMemo(() => {
    const search = query().trim().toLowerCase();

    return (report()?.hosts ?? []).map(host => ({
      ...host,
      archives: host.archives.filter(archive => `${archive.name} ${archive.cwd} ${host.hostName}`.toLowerCase().includes(search)).sort((a, b) => b.modifiedAt - a.modifiedAt),
    }));
  });

  createDependencyEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select();
      }
    };

    window.addEventListener("keydown", focusSearch);

    return () => window.removeEventListener("keydown", focusSearch);
  }, () => []);

  return <aside class="session-panel" aria-label="Archived sessions">
    <div class="archived-session-heading"><span><Archive size={15} />Archived sessions</span><IconButton label="Refresh archived sessions" disabled={loading()} onClick={() => void refresh()}><RefreshCw size={15} class={loading() ? "spinning" : ""} /></IconButton></div>
    <label class="search"><Search size={15} /><input ref={element => { searchRef.current = element; }} aria-label="Search archived sessions" placeholder="Search archived sessions" value={query()} onInput={event => setQuery(event.target.value)} /><kbd>Ctrl G</kbd></label>
    <div class="session-scroll" aria-busy={loading()}>
      <Show when={loading() && !report()}><p class="empty-small" role="status">Loading archived sessions…</p></Show>
      <Show when={error()}><p class="group-error" role="alert">{error()}</p></Show>
      <Key each={hosts()} by={host => host.hostId}>{host => <section class="project">
        <div class="project-label"><span>{host().hostName}</span></div>
        <Show when={host().error}><p class="group-error" role="alert">{host().error}</p></Show>
        <Key each={host().warnings} by={warning => warning}>{warning => <p class="group-error" role="status">{warning()}</p>}</Key>
        <Key each={host().archives} by={archive => archive.path}>{archive => <div class="session-item" data-tooltip={archive().cwd}>
          <div class="session-main"><div class="session-copy">
            <div class="session-title-row"><strong>{archive().name}</strong></div>
            <small class="archived-session-detail">{archive().cwd}</small>
            <small class="archived-session-detail">{new Date(archive().modifiedAt * 1000).toLocaleString()}</small>
          </div></div>
          <IconButton label={`Restore ${archive().name} to active sessions`} disabled={Boolean(restoring())} onClick={() => void restore(host().hostId, archive().path)}>{restoring() === `${host().hostId}:${archive().path}` ? <RefreshCw size={15} class="spinning" /> : <ArchiveRestore size={15} />}</IconButton>
        </div>}</Key>
      </section>}</Key>
      <Show when={!loading() && !error() && hosts().every(host => !host.archives.length && !host.error)}><p class="empty-small">{query().trim() ? "No matching archived sessions." : "No archived sessions."}</p></Show>
    </div>
  </aside>;
}
