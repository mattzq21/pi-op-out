import { render } from "solid-js/web";
import App from "./App";
import { MobileApp } from "./components/MobileApp";
import { isMobile } from "./lib/platform";
import { installTextEditingShortcuts } from "./lib/textEditingShortcuts";
import "./styles.css";
import "./index.css";
import "./mobile.css";

if (isMobile) document.documentElement.dataset.mobile = "true";

if (import.meta.env.MODE === "e2e") document.documentElement.dataset.testPalette = "warm-swap";

const removeTextEditingShortcuts = installTextEditingShortcuts();

const dispose = render(() => isMobile ? <MobileApp /> : <App />, document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.dispose(() => { dispose(); removeTextEditingShortcuts(); });
