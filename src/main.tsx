import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./index.css";

if (import.meta.env.MODE === "e2e") document.documentElement.dataset.testPalette = "warm-swap";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
