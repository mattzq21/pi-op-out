import { App as AndroidApp } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { createSignal } from "solid-js";
import { createDependencyEffect } from "../lib/solid";

type State = "checking" | "active" | "off" | "other-vpn" | "missing" | "unknown";

const tailscale = registerPlugin<{ check(): Promise<{ state: State }>; open(): Promise<void> }>("TailscaleStatus");

const messages: Record<State, { title: string; detail: string }> = {
  checking: { title: "Checking Tailscale…", detail: "Checking this phone’s VPN connection." },
  active: { title: "Tailscale network active", detail: "This phone has a Tailscale VPN address. The host must also be online in the same tailnet." },
  off: { title: "Tailscale is off", detail: "Open Tailscale and turn it on before connecting to your Tailscale host." },
  "other-vpn": { title: "VPN active · Tailscale unconfirmed", detail: "A VPN is running, but no Tailscale address was found. Open Tailscale to check its connection." },
  missing: { title: "Tailscale is not installed", detail: "Install Tailscale and connect this phone to your host’s tailnet." },
  unknown: { title: "Tailscale status unavailable", detail: "Open Tailscale to check whether it is connected." },
};

export function MobileTailscaleStatus() {
  const [state, setState] = createSignal<State>("checking");
  const [error, setError] = createSignal("");
  let disposed = false;

  const check = async () => {
    try {
      const status = await tailscale.check();

      if (!disposed) setState(status.state);
    } catch { if (!disposed) setState("unknown"); }
  };

  const open = async () => {
    setError("");

    try { await tailscale.open(); }
    catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  createDependencyEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    disposed = false;
    void check();
    const interval = setInterval(() => { if (!document.hidden) void check(); }, 5000);
    const resume = AndroidApp.addListener("appStateChange", ({ isActive }) => { if (isActive) void check(); });

    return () => { disposed = true; clearInterval(interval); void resume.then((handle) => handle.remove()); };
  }, () => []);

  return Capacitor.getPlatform() === "android" && <div class="mobile-tailscale-status" data-state={state()}>
    <div role="status"><strong><span class="mobile-tailscale-dot" aria-hidden="true" />{messages[state()].title}</strong><p>{messages[state()].detail}</p></div>
    <div class="mobile-host-actions"><button type="button" onClick={() => void check()}>Check again</button>{state() !== "missing" && <button type="button" onClick={() => void open()}>Open Tailscale</button>}</div>
    {error() && <p role="alert">{error()}</p>}
  </div>;
}
