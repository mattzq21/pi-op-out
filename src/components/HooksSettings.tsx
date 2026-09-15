import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw, Search } from "lucide-react";
import type { RemoteHost } from "../types";
import { listHooks, openHooksDirectory, type HookListing } from "../lib/nativeTransport";

export function HookIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="15" cy="5" r="2" /><path d="M15 7v8a5 5 0 0 1-10 0v-3l3 3" /></svg>;
}

export function HooksSettings({ hosts }: { hosts: RemoteHost[] }) {
  const [hostId, setHostId] = useState("local");
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<HookListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const owner = ++generation.current;
    setLoading(true); setListing(undefined); setError(undefined); setOpening(false);
    void listHooks(hostId).then((value) => { if (owner === generation.current) setListing(value); })
      .catch((reason) => { if (owner === generation.current) setError(String(reason)); })
      .finally(() => { if (owner === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [hostId, revision]);
  const openFolder = async () => {
    if (!listing || opening) return;
    const owner = generation.current;
    setOpening(true); setError(undefined);
    try { await openHooksDirectory(listing.directory); }
    catch (reason) { if (owner === generation.current) setError(String(reason)); }
    finally { if (owner === generation.current) setOpening(false); }
  };
  const hooks = listing?.hooks.filter((hook) => hook.entry.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];
  return <div className="settings-section">
    <div className="section-title"><div><h2>Hooks</h2><p>Hooks from the directory below on the selected machine. Reload the session after changing files.</p></div></div>
    <div className="hooks-toolbar">
      <label>Machine <select aria-label="Hooks machine" value={hostId} onChange={(event) => setHostId(event.target.value)}><option value="local">Local</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <label className="section-filter"><Search size={14} /><input aria-label="Filter hooks" placeholder="Filter hooks" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <button className="section-toggle-all" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} />Refresh</button>
      {hostId === "local" && <button className="section-toggle-all" disabled={!listing?.exists || opening || loading} onClick={() => void openFolder()}><FolderOpen size={14} />Open folder</button>}
    </div>
    {listing && <p className="hooks-directory">{listing.directory}</p>}
    {error && <p className="hooks-error" role="alert">{error}</p>}
    {loading ? <div className="empty-small" role="status">Loading hooks…</div> : listing && <>
      <div className="config-list">{hooks.map((hook) => <div className="config-row" key={hook.path}><span className="config-icon"><HookIcon size={16} /></span><span><strong>{hook.name}</strong><small>{hook.entry}</small></span><span className="skill-invocation">Loads with session</span></div>)}</div>
      {!hooks.length && <div className="empty-small">{listing.hooks.length ? "No hooks match your filter." : "No hooks found. Add a .ts, .js, .mjs, or .cjs file, or a folder with an index file, to the hooks directory shown above."}</div>}
    </>}
  </div>;
}
