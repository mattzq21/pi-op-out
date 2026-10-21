import { z } from "zod";
import { createComputed, createSignal } from "solid-js";
import { createDependencyEffect, createRef } from "../lib/solid";

import { App as AndroidApp } from "@capacitor/app";
import App from "../App";
import { cachedMobileHost, forgetMobileAnchor, readMobileAnchor, saveMobileAnchor, useDevelopmentAnchor, validateMobileAnchor, type MobileAnchor } from "../lib/mobileHosts";
import { remoteClient, validateHost } from "../lib/remoteClient";
import { loadMobileDebugConnection } from "../lib/mobileDebug";
import { MobileTailscaleStatus } from "./MobileTailscaleStatus";

export function MobileApp() {
  const [url, setUrl] = createSignal(cachedMobileHost());
  const [name, setName] = createSignal("");
  const [anchor, setAnchor] = createSignal<MobileAnchor>();
  const [anchorReadFailed, setAnchorReadFailed] = createSignal(false);
  const [forgetting, setForgetting] = createSignal(false);
  const pendingAnchorSave = createRef<Promise<MobileAnchor | undefined> | undefined>(undefined);
  const [connected, setConnected] = createSignal(false);
  const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [minimizeError, setMinimizeError] = createSignal("");
  const [restartGrace, setRestartGrace] = createSignal(false);
  const restartGraceTimer = createRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = createRef(0);
  const retry = createRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryDelay = createRef(2000);
  const intentionalDisconnect = createRef(false);
  const configuredDebugAddress = createRef<string | undefined>(undefined);
  const debugAddressLoaded = createRef<Promise<void>>(Promise.resolve());
  const activeDebugAddress = createRef<string | undefined>(undefined);
  /** The address of the last socket that the host accepted. A drop before the host address is saved reconnects to it. */
  const acceptedAddress = createRef<string | undefined>(undefined);
  const connectRef = createRef<(address: string, label?: string) => Promise<void>>(async () => {});
  const reconnectAddress = () => activeDebugAddress.current ?? acceptedAddress.current ?? cachedMobileHost();

  const scheduleReconnect = () => {
    clearTimeout(retry.current);
    const last = reconnectAddress();

    if (forgetting() || intentionalDisconnect.current || !last) return;
    retry.current = setTimeout(() => { void connectRef.current(last); }, retryDelay.current);
    retryDelay.current = Math.min(retryDelay.current * 2, 30000);
  };

  const [disconnecting, setDisconnecting] = createSignal(false);

  const disconnect = async () => {
    if (disconnecting()) return;
    const tasks: Promise<unknown>[] = [];

    if (!window.dispatchEvent(new CustomEvent("piop-mobile-before-disconnect", { cancelable: true, detail: { waitUntil: (task: Promise<unknown>) => tasks.push(task) } }))) return;
    setDisconnecting(true);

    const failed = (await Promise.allSettled(tasks)).find(result => result.status === "rejected");

    if (failed?.status === "rejected" && connected()) { setError(String(failed.reason)); setDisconnecting(false);

    return; }

    intentionalDisconnect.current = true; generation.current++; clearTimeout(retry.current);
    setWorkspaceOpen(false); remoteClient.close(); setConnected(false); setConnecting(false); setError("");
    setDisconnecting(false);
  };

  const connect = async (address: string, label?: string) => {
    if (forgetting()) return;
    const attempt = ++generation.current;
    let cleanUrl: string | undefined;
    clearTimeout(retry.current); setConnecting(true); setError("");

    try {
      cleanUrl = validateHost({ url: address.trim() });
      await debugAddressLoaded.current;

      if (attempt !== generation.current) return;
      activeDebugAddress.current = cleanUrl === configuredDebugAddress.current ? cleanUrl : undefined;
      const saved = anchor();
      const host = validateMobileAnchor(cleanUrl, label ?? (saved?.url === cleanUrl ? saved.name : activeDebugAddress.current ? "Development" : ""));
      await remoteClient.connect({ url: host.url });

      if (attempt !== generation.current) return;
      acceptedAddress.current = host.url;
      if (activeDebugAddress.current) useDevelopmentAnchor(host.url);
      else {
        const saving = saveMobileAnchor(host.url, host.name);
        pendingAnchorSave.current = saving;
        const stored = await saving;

        if (attempt !== generation.current) return;
        setAnchor(stored); setAnchorReadFailed(false);
      }

      // The socket can close while the address saves. The disconnect handler then shows the error and schedules the reconnect.
      if (!remoteClient.isConnected()) return;
      setUrl(host.url); setName(host.name); setConnected(true); setWorkspaceOpen(true); retryDelay.current = 2000;
    } catch (reason) {
      if (attempt !== generation.current) return;
      remoteClient.close(); setError(reason instanceof Error ? reason.message : String(reason));

      if (cleanUrl && (cleanUrl === reconnectAddress() || cleanUrl === cachedMobileHost())) scheduleReconnect();
    } finally { if (attempt === generation.current) setConnecting(false); }
  };

  createComputed(() => { connectRef.current = connect; });
  createDependencyEffect(() => {
    let disposed = false;
    remoteClient.onDisconnect = (reason) => { setConnected(false); setError(reason); scheduleReconnect(); };

    const restarting = () => {
      if (intentionalDisconnect.current || forgetting()) return;
      retryDelay.current = 500;
      clearTimeout(restartGraceTimer.current); setRestartGrace(true);
      restartGraceTimer.current = setTimeout(() => setRestartGrace(false), 5000);
    };

    const restartListener = remoteClient.listen("pi://daemon-restarting", ({ payload }) => {
      if (payload.hostId === "local") restarting();
    }, z.object({ hostId: z.string() }));

    window.addEventListener("piop-daemon-restarting", restarting);

    const reconnectOnResume = () => {
      const last = reconnectAddress();

      if (document.hidden || connected() || connecting() || forgetting() || intentionalDisconnect.current || !last) return;
      retryDelay.current = 2000;
      void connectRef.current(last);
    };

    document.addEventListener("visibilitychange", reconnectOnResume);

    const startupGeneration = generation.current;
    const debugConnection = loadMobileDebugConnection().then((debugUrl) => {
      configuredDebugAddress.current = debugUrl ? validateHost({ url: debugUrl.trim() }) : undefined;

      return debugUrl;
    });
    debugAddressLoaded.current = debugConnection.then(() => undefined, (reason) => { if (!disposed) setError((reason instanceof Error ? reason.message : String(reason))); });
    void Promise.all([debugConnection, readMobileAnchor().catch((reason) => {
      if (!disposed && generation.current === startupGeneration) setAnchorReadFailed(true);
      throw reason;
    })]).then(([debugUrl, saved]) => {
      if (disposed || generation.current !== startupGeneration) return;
      setAnchor(saved);

      if (saved) { setUrl(saved.url); setName(saved.name); }

      if (debugUrl) {
        setUrl(debugUrl);
        void connectRef.current(debugUrl);
      } else if (saved) void connectRef.current(saved.url);
    }).catch((reason) => { if (!disposed && generation.current === startupGeneration) setError((reason instanceof Error ? reason.message : String(reason))); });
    window.addEventListener("piop-mobile-disconnect", disconnect);

    const back = AndroidApp.addListener("backButton", () => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");

      if (dialog) { dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

      return; }

      if (window.dispatchEvent(new Event("piop-mobile-back", { cancelable: true }))) void AndroidApp.minimizeApp().then(() => setMinimizeError(""), (reason) => setMinimizeError((reason instanceof Error ? reason.message : String(reason))));
    });

    const viewport = () => document.documentElement.style.setProperty("--mobile-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    viewport(); window.visualViewport?.addEventListener("resize", viewport);

    return () => { disposed = true; generation.current++; clearTimeout(retry.current); clearTimeout(restartGraceTimer.current); remoteClient.close(); window.removeEventListener("piop-mobile-disconnect", disconnect); window.removeEventListener("piop-daemon-restarting", restarting); document.removeEventListener("visibilitychange", reconnectOnResume); void restartListener.then(stop => stop()); remoteClient.onDisconnect = undefined; void back.then((handle) => handle.remove()); window.visualViewport?.removeEventListener("resize", viewport); };
  }, () => [disconnect, scheduleReconnect]);

  const forgetAnchor = async () => {
    if (forgetting()) return;
    setForgetting(true); intentionalDisconnect.current = true; generation.current++;
    acceptedAddress.current = undefined;
    clearTimeout(retry.current); clearTimeout(restartGraceTimer.current); setRestartGrace(false);
    remoteClient.close(); setConnected(false); setConnecting(false);

    try {
      if (pendingAnchorSave.current) await Promise.allSettled([pendingAnchorSave.current]);
      await forgetMobileAnchor();
      pendingAnchorSave.current = undefined;
      setAnchor(undefined); setAnchorReadFailed(false); setUrl(""); setName(""); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setForgetting(false); }
  };

  const connectDisabled = () => forgetting() || connecting() || !url().trim() || !name().trim();
  const showConnectionNotice = () => !restartGrace() && (!connected() || Boolean(error()));
  const renderConnectionNotice = () => showConnectionNotice() && <div class="mobile-reconnect-banner"><div role="status">{error() || "Reconnecting…"}<button disabled={connecting() || disconnecting()} onClick={() => { if (connected()) void disconnect(); else void connect(url()); }}>{connected() ? "Retry disconnect" : connecting() ? "Connecting…" : "Reconnect"}</button></div>{!connected() && <MobileTailscaleStatus />}</div>;

  return <>{workspaceOpen() ? (<><div style={{ display: "contents" }} inert={disconnecting()}><App suppressConnectionNotices={restartGrace()} /></div><button class="mobile-host-button" aria-label="Disconnect from anchor host" disabled={disconnecting()} onClick={() => void disconnect()}>Host</button></>) : (<main class="mobile-connect dark"><form onSubmit={(event) => { event.preventDefault(); if (forgetting()) return; intentionalDisconnect.current = false; retryDelay.current = 2000; void connect(url(), name()); }}>
    <label>Anchor host address<input type="url" required disabled={connecting() || forgetting()} placeholder="wss://your-host.your-tailnet.ts.net" autoCapitalize="none" autocorrect="off" spellcheck={false} value={url()} onInput={(event) => { generation.current++; clearTimeout(retry.current); intentionalDisconnect.current = true; acceptedAddress.current = undefined; setUrl(event.target.value); }} /></label>
    <label>Host name<input required disabled={connecting() || forgetting()} value={name()} placeholder="My PC" onInput={(event) => setName(event.target.value)} /></label>
    <p class="mobile-connect-hint">Piop connects to this host. You can also use the hosts that this host has added. Connect this device and the host to the same Tailscale account, then enter the host’s Tailscale Serve wss:// address.</p>
    <MobileTailscaleStatus />
    {error() && <p role="alert">{error()}</p>}
    <button class="primary-button" disabled={connectDisabled()}>{connecting() ? "Connecting…" : "Connect"}</button>
    {connecting() && <button type="button" onClick={disconnect}>Cancel</button>}
    {(anchor() || anchorReadFailed()) && !connecting() && <button type="button" disabled={forgetting()} onClick={() => void forgetAnchor()}>Forget anchor host</button>}
  </form></main>)}{((workspaceOpen() && showConnectionNotice()) || minimizeError()) && <div class="mobile-notices">{workspaceOpen() && renderConnectionNotice()}{minimizeError() && <div class="mobile-reconnect-banner"><div role="status">{minimizeError()}</div></div>}</div>}</>;
}
