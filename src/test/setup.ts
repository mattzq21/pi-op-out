import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; private dataListeners = new Set<(data: string) => void>(); private host?: HTMLElement; private output?: HTMLElement;
  loadAddon() {}
  open(host: HTMLElement) { this.host = host; const input = document.createElement("textarea"); input.setAttribute("aria-label", "Terminal input"); input.addEventListener("keydown", (event) => { const data = event.key === "Enter" ? "\r" : event.key === "Backspace" ? "\x7f" : event.key.length === 1 ? event.key : ""; if (data) this.dataListeners.forEach((listener) => listener(data)); }); this.output = document.createElement("pre"); this.output.className = "xterm-test-output"; host.append(input, this.output); }
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onResize() { return { dispose() {} }; }
  write(data: string) { if (this.output) this.output.textContent += data; }
  reset() { if (this.output) this.output.textContent = ""; }
  focus() { this.host?.querySelector("textarea")?.focus(); }
  dispose() { if (this.host) this.host.textContent = ""; }
} }));

if (typeof Element !== "undefined") Element.prototype.scrollIntoView = vi.fn();
afterEach(() => { if (typeof document !== "undefined") cleanup(); if (typeof localStorage !== "undefined") localStorage.clear(); });
