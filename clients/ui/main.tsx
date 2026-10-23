import { ignoreSessionResume, initializeSessionResume } from "./lib/sessionResume";
import { required } from "./lib/required";
import { render } from "solid-js/web";
import { invoke, isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { MobileApp } from "./components/MobileApp";
import { isMobile } from "./lib/platform";
import { installTextEditingShortcuts } from "./lib/textEditingShortcuts";
import { installTooltips } from "./lib/tooltips";
import "./styles.css";
import "./index.css";
import "./mobile.css";

if (isMobile) document.documentElement.dataset.mobile = "true";

if (import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === "true" || import.meta.env.VITE_PIOP_DEBUG === "true") document.documentElement.dataset.debugPalette = "true";

const removeTextEditingShortcuts = installTextEditingShortcuts();

const removeTooltips = installTooltips();

const root = required(document.getElementById("root"));

let stopped = false;

let dispose = render(() => <p role="status">Restoring workspace…</p>, root);

const startApp = () => {
  if (stopped) return;
  dispose();
  dispose = render(() => isMobile ? <MobileApp /> : <App />, root);
};

void initializeSessionResume().then(startApp, error => {
  console.error("Could not restore saved conversations", error);

  if (stopped) return;
  dispose();
  dispose = render(() => <main><p role="alert">Could not restore the last conversation.</p><button onClick={() => window.location.reload()}>Retry</button><button onClick={() => { ignoreSessionResume(); startApp(); }}>Start without restoring</button></main>, root);
});

if (import.meta.hot) {
  const reloadDaemon = () => {
    if (isTauri()) void invoke("reload_development_window").catch(error => console.error("Could not reload after restarting the daemon:", error));
    else window.location.reload();
  };

  import.meta.hot.on("piop:daemon-restarted", reloadDaemon);
  import.meta.hot.dispose(() => {
    import.meta.hot?.off("piop:daemon-restarted", reloadDaemon);
    stopped = true; dispose(); removeTextEditingShortcuts(); removeTooltips();
  });
}
