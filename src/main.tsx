import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installTextEditingShortcuts } from "./lib/textEditingShortcuts";
import "./styles.css";
import "./index.css";

if (import.meta.env.MODE === "e2e") document.documentElement.dataset.testPalette = "warm-swap";

const removeTextEditingShortcuts = installTextEditingShortcuts();
if (import.meta.hot) import.meta.hot.dispose(removeTextEditingShortcuts);

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
