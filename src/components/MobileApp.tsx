import { useEffect, useState } from "react";
import { App as AndroidApp } from "@capacitor/app";
import App from "../App";
import { voiceSession } from "../lib/voiceSession";
import { closeMobileVoice } from "../lib/mobileVoice";
import { remoteClient } from "../lib/remoteClient";

export function MobileApp() {
  const [url, setUrl] = useState(() => localStorage.getItem("piop-mobile-host") ?? "");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    remoteClient.onDisconnect = (reason) => { closeMobileVoice(); voiceSession.connectionLost(); setConnected(false); setError(reason); };
    const disconnect = () => { closeMobileVoice(); remoteClient.close(); voiceSession.connectionLost(); setConnected(false); };
    window.addEventListener("piop-mobile-disconnect", disconnect);
    const back = AndroidApp.addListener("backButton", () => {
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (dialog) { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); return; }
      window.dispatchEvent(new Event("piop-mobile-back"));
    });
    const viewport = () => document.documentElement.style.setProperty("--mobile-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    viewport(); window.visualViewport?.addEventListener("resize", viewport);
    return () => { window.removeEventListener("piop-mobile-disconnect", disconnect); remoteClient.onDisconnect = undefined; void back.then((handle) => handle.remove()); window.visualViewport?.removeEventListener("resize", viewport); };
  }, []);
  const connect = async () => {
    setConnecting(true); setError("");
    try {
      const cleanUrl = url.trim();
      if (!cleanUrl.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "").trim()) throw new Error("Enter the host address.");
      await remoteClient.connect({ url: cleanUrl });
      localStorage.setItem("piop-mobile-host", cleanUrl); setConnected(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setConnecting(false); }
  };
  if (connected) return <><App /><button className="mobile-host-button" aria-label="Disconnect from host" onClick={() => { remoteClient.close(); setConnected(false); }}>Host</button></>;
  return <main className="mobile-connect dark"><form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
    <p className="eyebrow">piop · Android</p><h1>Your workspace,<br />wherever you are.</h1>
    <p>Connect to your Piop daemon. Your projects, agents, and tools stay on that host, even when the desktop app is closed.</p>
    <label>Host address<input type="url" required placeholder="wss://your-host.your-tailnet.ts.net" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
    <p className="mobile-connect-hint">Connect this device and the host to the same Tailscale account, then enter the host’s Tailscale Serve wss:// address.</p>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={connecting}>{connecting ? "Connecting…" : "Connect to workspace"}</button>
  </form></main>;
}
