import { render } from "solid-js/web";
import App from "./App";
import { MobileApp } from "./components/MobileApp";
import "./index.css";
import { isMobile } from "./lib/platform";
import { installTextEditingShortcuts } from "./lib/textEditingShortcuts";
import "./mobile.css";
import "./styles.css";

if (isMobile) document.documentElement.dataset.mobile = "true";

if (import.meta.env.MODE === "e2e") document.documentElement.dataset.testPalette = "warm-swap";

const removeTextEditingShortcuts = installTextEditingShortcuts();

const dispose = render(() => isMobile ? <MobileApp /> : <App />, document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.dispose(() => { dispose(); removeTextEditingShortcuts(); });
