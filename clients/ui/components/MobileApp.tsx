import { Key } from "@solid-primitives/keyed";
import { z } from "zod";
import { createComputed, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import { App as AndroidApp } from "@capacitor/app";
import App from "../App";
import { cachedMobileHost, readMobileConnection, saveMobileConnection, readMobileHosts, removeMobileHost, saveMobileHost, validateMobileHost, type SavedMobileHost } from "../lib/mobileHosts";
import { remoteClient, validateHost } from "../lib/remoteClient";
import { loadMobileDebugConnection } from "../lib/mobileDebug";
import { MobileTailscaleStatus } from "./MobileTailscaleStatus";

async function connectionHost(address: string, label: string | undefined, debug: boolean) {
  const url = validateHost({ url: address.trim() });
  const saved = await readMobileHosts();
  const savedName = saved.find(host => host.url === url)?.name;

  return validateMobileHost(url, label ?? savedName ?? (debug ? "Development" : ""), saved);
}

export function MobileApp() {
  const [url, setUrl] = createSignal(cachedMobileHost());
  const [hosts, setHosts] = createSignal<SavedMobileHost[]>([]);
  let hostsChanged = false;
  const applyHosts = (saved: SavedMobileHost[]) => { hostsChanged = true; setHosts(saved); };

  const [name, setName] = createSignal("");
  const [autoReconnect, setAutoReconnect] = createSignal(false);
  let reconnectChanged = false;
  const [connected, setConnected] = createSignal(false);
  const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [error, setError] = createSignal("");
  createDependencyEffect(() => {
    let active = true;
    void readMobileHosts().then(saved => { if (active && !hostsChanged) setHosts(saved); }).catch(reason => { if (active) setError(String(reason)); });

    return () => { active = false; };
  });
  const [restartGrace, setRestartGrace] = createSignal(false);
  const restartGraceTimer = createRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = createRef(0);
  const retry = createRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryDelay = createRef(2000);
  const restartUntil = createRef(0);
  const reconnectEnabled = createRef(autoReconnect()); createComputed(() => { reconnectEnabled.current = autoReconnect(); });
  const intentionalDisconnect = createRef(false);
  const activeDebugAddress = createRef<string | undefined>(undefined);
  const connectRef = createRef<(address: string, label?: string) => Promise<void>>(async () => {});

  const scheduleReconnect = () => {
    clearTimeout(retry.current);
    const last = activeDebugAddress.current ?? cachedMobileHost();

    if ((!reconnectEnabled.current && Date.now() >= restartUntil.current) || intentionalDisconnect.current || !last) return;
    retry.current = setTimeout(() => { void connectRef.current(last); }, retryDelay.current);
    retryDelay.current = Math.min(retryDelay.current * 2, 30000);
  };

  const [disconnecting, setDisconnecting] = createSignal(false);

  const disconnect = async () => {
    if (disconnecting()) return;
    const tasks: Promise<unknown>[] = [];

    if (!window.dispatchEvent(new CustomEvent("piop-mobile-before-disconnect", { cancelable: true, detail: { waitUntil: (task: Promise<unknown>) => tasks.push(task) } }))) return;
    setDisconnecting(true);

    try { await Promise.all(tasks); }
    catch (reason) { setError(String(reason)); setDisconnecting(false);

    return; }

    intentionalDisconnect.current = true; generation.current++; clearTimeout(retry.current);
    setWorkspaceOpen(false); remoteClient.close(); setConnected(false); setConnecting(false); setError("");
    setDisconnecting(false);
  };

  const finishConnection = async (attempt: number, cleanUrl: string, label: string) => {
    const savedHosts = await saveMobileHost(cleanUrl, label);

    if (attempt !== generation.current) return;
    await saveMobileConnection({ lastHost: cleanUrl });

    if (attempt !== generation.current) return;
    applyHosts(savedHosts); setUrl(cleanUrl); setName(label); setConnected(true); setWorkspaceOpen(true); retryDelay.current = 2000; restartUntil.current = 0;
  };

  const connect = async (address: string, label?: string) => {
    if (address !== activeDebugAddress.current) activeDebugAddress.current = undefined;
    const attempt = ++generation.current;
    clearTimeout(retry.current); setConnecting(true); setError("");

    try {
      const host = await connectionHost(address, label, Boolean(activeDebugAddress.current));

      if (attempt !== generation.current) return;
      await remoteClient.connect({ url: host.url });

      if (attempt !== generation.current) return;
      await finishConnection(attempt, host.url, host.name);
    } catch (reason) {
      if (attempt !== generation.current) return;
      remoteClient.close(); setError(reason instanceof Error ? reason.message : String(reason));

      if (address === activeDebugAddress.current || address === cachedMobileHost()) scheduleReconnect();
    } finally { if (attempt === generation.current) setConnecting(false); }
  };

  createComputed(() => { connectRef.current = connect; });
  createDependencyEffect(() => {
    let disposed = false;
    remoteClient.onDisconnect = (reason) => { setConnected(false); setError(reason); scheduleReconnect(); };

    const restarting = () => {
      restartUntil.current = Date.now() + 240000; retryDelay.current = 500;
      clearTimeout(restartGraceTimer.current); setRestartGrace(true);
      restartGraceTimer.current = setTimeout(() => setRestartGrace(false), 5000);
    };

    const restartListener = remoteClient.listen("pi://daemon-restarting", ({ payload }) => {
      if (payload.hostId === "local") restarting();
    }, z.object({ hostId: z.string() }));

    window.addEventListener("piop-daemon-restarting", restarting);

    const startupGeneration = generation.current;
    const startupUrl = url();
    void Promise.all([loadMobileDebugConnection(), readMobileConnection(), readMobileHosts()]).then(([debugUrl, saved, savedHosts]) => {
      if (disposed) return;

      if (!reconnectChanged) { reconnectEnabled.current = saved.autoReconnect; setAutoReconnect(saved.autoReconnect); }

      if (generation.current !== startupGeneration) return;

      if (url() === startupUrl) { setUrl(saved.lastHost); setName(savedHosts.find(host => host.url === saved.lastHost)?.name ?? ""); }

      if (debugUrl) {
        activeDebugAddress.current = debugUrl;
        setAutoReconnect(true); setUrl(debugUrl);
        void connectRef.current(debugUrl);
      } else {
        const last = cachedMobileHost();

        if (reconnectEnabled.current && last) retry.current = setTimeout(() => { void connectRef.current(last); }, 0);
      }
    }).catch((reason) => { if (generation.current === startupGeneration) setError(String(reason)); });
    window.addEventListener("piop-mobile-disconnect", disconnect);

    const back = AndroidApp.addListener("backButton", () => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");

      if (dialog) { dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

      return; }

      window.dispatchEvent(new Event("piop-mobile-back"));
    });

    const viewport = () => document.documentElement.style.setProperty("--mobile-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    viewport(); window.visualViewport?.addEventListener("resize", viewport);

    return () => { disposed = true; generation.current++; clearTimeout(retry.current); clearTimeout(restartGraceTimer.current); remoteClient.close(); window.removeEventListener("piop-mobile-disconnect", disconnect); window.removeEventListener("piop-daemon-restarting", restarting); void restartListener.then(stop => stop()); remoteClient.onDisconnect = undefined; void back.then((handle) => handle.remove()); window.visualViewport?.removeEventListener("resize", viewport); };
  }, () => [disconnect, scheduleReconnect]);

  const saveHost = async () => {
    const address = url();

    try { applyHosts(await saveMobileHost(address, name()));

      if (url() === address) setUrl(validateHost({ url: address.trim() }));
      setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const forgetHost = async () => {
    const address = url();

    try { applyHosts(await removeMobileHost(address));

      if (url() === address) { setUrl(""); setName(""); }

      clearTimeout(retry.current); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const saveDisabled = () => connecting() || !url().trim() || !name().trim();
  const showConnectionNotice = () => !restartGrace() && (!connected() || Boolean(error()));
  const renderConnectionNotice = () => showConnectionNotice() && <div class="mobile-reconnect-banner"><div role="status">{error() || "Reconnecting…"}<button disabled={connecting() || disconnecting()} onClick={() => { if (connected()) void disconnect(); else void connect(url()); }}>{connected() ? "Retry disconnect" : connecting() ? "Connecting…" : "Reconnect"}</button></div>{!connected() && <MobileTailscaleStatus />}</div>;
  const savedHostValue = () => hosts().some((host) => host.url === url()) ? url() : "";

  return <>{workspaceOpen() ? (<><div style={{ display: "contents" }} inert={disconnecting()}><App suppressConnectionNotices={restartGrace()} /></div>{renderConnectionNotice()}<button class="mobile-host-button" aria-label="Disconnect from host" disabled={disconnecting()} onClick={() => void disconnect()}>Host</button></>) : (<main class="mobile-connect dark"><form onSubmit={(event) => { event.preventDefault(); intentionalDisconnect.current = false; retryDelay.current = 2000; void connect(url(), name()); }}>
    {hosts().length > 0 && <label>Saved hosts<select disabled={connecting()} value={savedHostValue()} onChange={(event) => { disconnect(); const host = hosts().find((item) => item.url === event.target.value); setUrl(host?.url ?? ""); setName(host?.name ?? ""); }}><option value="">New host</option>{<Key each={hosts()} by={(host) => host.url}>{(host, _index) => <option  value={host().url}>{host().name}</option>}</Key>}</select></label>}
    <label>Host address<input type="url" required disabled={connecting()} placeholder="wss://your-host.your-tailnet.ts.net" autoCapitalize="none" autocorrect="off" spellcheck={false} value={url()} onInput={(event) => { generation.current++; clearTimeout(retry.current); intentionalDisconnect.current = true; setUrl(event.target.value); }} /></label>
    <label>Host name<input required disabled={connecting()} value={name()} placeholder="My PC" onInput={(event) => setName(event.target.value)} /></label>
    <div class="mobile-host-actions"><button type="button" disabled={saveDisabled()} onClick={saveHost}>Save host</button>{hosts().some((host) => host.url === url()) && <button type="button" disabled={connecting()} onClick={forgetHost}>Remove host</button>}</div>
    <label class="mobile-auto-reconnect"><input type="checkbox" checked={autoReconnect()} onInput={(event) => { const enabled = event.target.checked; reconnectChanged = true; void saveMobileConnection({ autoReconnect: enabled }).catch(reason => setError(String(reason))); reconnectEnabled.current = enabled; setAutoReconnect(enabled);

    if (!enabled) clearTimeout(retry.current); }} />Automatically reconnect to last host</label>
    <p class="mobile-connect-hint">Connect this device and the host to the same Tailscale account, then enter the host’s Tailscale Serve wss:// address.</p>
    <MobileTailscaleStatus />
    {error() && <p role="alert">{error()}</p>}
    <button class="primary-button" disabled={saveDisabled()}>{connecting() ? "Connecting…" : "Connect to workspace"}</button>
    {connecting() && <button type="button" onClick={disconnect}>Cancel</button>}
  </form></main>)}</>;
}
