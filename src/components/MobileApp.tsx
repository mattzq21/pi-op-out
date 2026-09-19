import { useCallback, useEffect, useRef, useState } from "react";
import { App as AndroidApp } from "@capacitor/app";
import App from "../App";
import { voiceSession } from "../lib/voiceSession";
import { closeMobileVoice } from "../lib/mobileVoice";
import { remoteClient, validateHost } from "../lib/remoteClient";
import { readMobileHosts, removeMobileHost, saveMobileHost } from "../lib/mobileHosts";

export function MobileApp() {
  const [url, setUrl] = useState(() => localStorage.getItem("piop-mobile-host") ?? "");
  const [hosts, setHosts] = useState(readMobileHosts);
  const [name, setName] = useState("");
  const [autoReconnect, setAutoReconnect] = useState(() => localStorage.getItem("piop-mobile-auto-reconnect") === "true");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryDelay = useRef(2000);
  const reconnectEnabled = useRef(autoReconnect); reconnectEnabled.current = autoReconnect;
  const intentionalDisconnect = useRef(false);
  const connectRef = useRef<(address: string, label?: string) => Promise<void>>(async () => {});
  const scheduleReconnect = useCallback(() => {
    clearTimeout(retry.current);
    const last = localStorage.getItem("piop-mobile-host");
    if (!reconnectEnabled.current || intentionalDisconnect.current || !last) return;
    retry.current = setTimeout(() => { void connectRef.current(last); }, retryDelay.current);
    retryDelay.current = Math.min(retryDelay.current * 2, 30000);
  }, []);
  const disconnect = useCallback(() => {
    intentionalDisconnect.current = true; generation.current++; clearTimeout(retry.current);
    closeMobileVoice(); remoteClient.close(); voiceSession.connectionLost(); setConnected(false); setConnecting(false); setError("");
  }, []);
  const connect = useCallback(async (address: string, label = "") => {
    const attempt = ++generation.current;
    clearTimeout(retry.current); setConnecting(true); setError("");
    try {
      const cleanUrl = validateHost({ url: address.trim() });
      await remoteClient.connect({ url: cleanUrl });
      if (attempt !== generation.current) return;
      localStorage.setItem("piop-mobile-host", cleanUrl);
      setHosts(saveMobileHost(cleanUrl, label)); setUrl(cleanUrl); setConnected(true); retryDelay.current = 2000;
    } catch (reason) {
      if (attempt !== generation.current) return;
      remoteClient.close(); setError(reason instanceof Error ? reason.message : String(reason));
      if (address === localStorage.getItem("piop-mobile-host")) scheduleReconnect();
    } finally { if (attempt === generation.current) setConnecting(false); }
  }, [scheduleReconnect]);
  connectRef.current = connect;
  useEffect(() => {
    remoteClient.onDisconnect = (reason) => { closeMobileVoice(); voiceSession.connectionLost(); setConnected(false); setError(reason); scheduleReconnect(); };
    const last = localStorage.getItem("piop-mobile-host");
    if (reconnectEnabled.current && last) retry.current = setTimeout(() => { void connectRef.current(last); }, 0);
    window.addEventListener("piop-mobile-disconnect", disconnect);
    const back = AndroidApp.addListener("backButton", () => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (dialog) { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); return; }
      window.dispatchEvent(new Event("piop-mobile-back"));
    });
    const viewport = () => document.documentElement.style.setProperty("--mobile-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    viewport(); window.visualViewport?.addEventListener("resize", viewport);
    return () => { generation.current++; clearTimeout(retry.current); remoteClient.close(); window.removeEventListener("piop-mobile-disconnect", disconnect); remoteClient.onDisconnect = undefined; void back.then((handle) => handle.remove()); window.visualViewport?.removeEventListener("resize", viewport); };
  }, [disconnect, scheduleReconnect]);
  const saveHost = () => {
    try { setHosts(saveMobileHost(url, name)); setUrl(validateHost({ url: url.trim() })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const forgetHost = () => {
    try { setHosts(removeMobileHost(url)); setUrl(""); setName(""); clearTimeout(retry.current); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  if (connected) return <><App /><button className="mobile-host-button" aria-label="Disconnect from host" onClick={disconnect}>Host</button></>;
  return <main className="mobile-connect dark"><form onSubmit={(event) => { event.preventDefault(); intentionalDisconnect.current = false; retryDelay.current = 2000; void connect(url, name); }}>
    <p className="eyebrow">piop · Android</p><h1>Your workspace,<br />wherever you are.</h1>
    <p>Connect to your Piop daemon. Your projects, agents, and tools stay on that host, even when the desktop app is closed.</p>
    {hosts.length > 0 && <label>Saved hosts<select disabled={connecting} value={hosts.some((host) => host.url === url) ? url : ""} onChange={(event) => { disconnect(); const host = hosts.find((item) => item.url === event.target.value); setUrl(host?.url ?? ""); setName(host?.name ?? ""); }}><option value="">New host</option>{hosts.map((host) => <option key={host.url} value={host.url}>{host.name}</option>)}</select></label>}
    <label>Host address<input type="url" required disabled={connecting} placeholder="wss://your-host.your-tailnet.ts.net" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(event) => { clearTimeout(retry.current); intentionalDisconnect.current = true; setUrl(event.target.value); }} /></label>
    <label>Host name (optional)<input disabled={connecting} value={name} placeholder="My PC" onChange={(event) => setName(event.target.value)} /></label>
    <div className="mobile-host-actions"><button type="button" disabled={connecting || !url.trim()} onClick={saveHost}>Save host</button>{hosts.some((host) => host.url === url) && <button type="button" disabled={connecting} onClick={forgetHost}>Remove host</button>}</div>
    <label className="mobile-auto-reconnect"><input type="checkbox" checked={autoReconnect} onChange={(event) => { const enabled = event.target.checked; localStorage.setItem("piop-mobile-auto-reconnect", String(enabled)); reconnectEnabled.current = enabled; setAutoReconnect(enabled); if (!enabled) clearTimeout(retry.current); }} />Automatically reconnect to last host</label>
    <p className="mobile-connect-hint">Connect this device and the host to the same Tailscale account, then enter the host’s Tailscale Serve wss:// address.</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={connecting}>{connecting ? "Connecting…" : "Connect to workspace"}</button>
    {connecting && <button type="button" onClick={disconnect}>Cancel</button>}
  </form></main>;
}
