import type { Accessor, Setter } from "solid-js";
import type { SplitPaneState } from "./appSupport";
import { keybindDefinitions, matchesShortcut } from "./lib/keybindings";
import { isMobile } from "./lib/platform";
import { createDependencyEffect } from "./lib/solid";
import type { AppSettings } from "./types";

type KeyboardContext = {
  settings: Accessor<AppSettings | undefined>;
  activePane: Accessor<"main" | "split">;
  splitPane: Accessor<SplitPaneState | undefined>;
  canLeaveSettings: () => boolean;
  setView: Setter<"chat" | "settings">;
  panelOpen: Accessor<boolean>;
  setPanelOpen: Setter<boolean>;
  newSession: () => Promise<void>;
  toggleTerminal: () => void;
  toggleDebugMode: () => void;
  setSplitComposerFocusRequest: Setter<number>;
  setMainComposerFocusRequest: Setter<number>;
  settingsDirty: Accessor<boolean>;
  view: Accessor<"chat" | "settings">;
  terminalOpen: Accessor<boolean>;
  setTerminalOpen: Setter<boolean>;
};

/** Keys that send control codes to the shell, plus terminal copy and paste. */
function isTerminalKey(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  const key = event.key.toLowerCase();

  return event.shiftKey ? key === "c" || key === "v" : /^[a-z@[\\\]^_]$/.test(key);
}

export function useAppKeyboard(context: KeyboardContext) {
  const { settings, activePane, splitPane, canLeaveSettings, setView, panelOpen, setPanelOpen, newSession, toggleTerminal, toggleDebugMode, setSplitComposerFocusRequest, setMainComposerFocusRequest, settingsDirty, view, terminalOpen, setTerminalOpen } = context;
  createDependencyEffect(() => { const capturedSettings = settings(); const capturedActivePane = activePane(); const capturedSplitPane = splitPane();

    if (!capturedSettings) return;

    const ignoreAppShortcut = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector("dialog[open]")) return true;
      const target = event.target instanceof HTMLElement ? event.target : undefined;

      if (target?.closest(".keybind-input")) return true;
      if (target?.closest(".terminal-shell") && isTerminalKey(event)) return true;

      return target?.closest("input, textarea, select, [contenteditable='true'], .keybind-input") && !event.ctrlKey && !event.metaKey && !event.altKey;
    };

    const isConversationSearchShortcut = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g";

    const handleKeybind = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ignoreAppShortcut(event)) return;

      if (isConversationSearchShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();

        if (!canLeaveSettings()) return;
        setView("chat"); setPanelOpen(true);
        window.setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')?.focus(), 0);

        return;
      }

      const binding = keybindDefinitions.find((item) => matchesShortcut(event, (capturedSettings).keybindings[item.action]));

      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();

      if (view() === "settings" && ["toggleTerminal", "focusComposer", "toggleConversations"].includes(binding.action)) return;
      const actions = new Map(Object.entries({ newConversation: () => { void newSession(); }, toggleConversations: () => { if (!canLeaveSettings()) return; setView("chat"); setPanelOpen((open) => !open); }, toggleTerminal, toggleDebugMode, openSettings: (): void => { setView("settings"); } }));

      const action = actions.get(binding.action);

      if (action) { action();

      return; }

      if (!canLeaveSettings()) return; setView("chat"); window.setTimeout(() => { if (capturedActivePane === "split" && capturedSplitPane) setSplitComposerFocusRequest((value) => value + 1); else setMainComposerFocusRequest((value) => value + 1); }, 0);
    };

    window.addEventListener("keydown", handleKeybind, true);

    return () => window.removeEventListener("keydown", handleKeybind, true);
  }, () => [settings(), toggleDebugMode, settingsDirty(), view(), activePane(), splitPane()]);
  createDependencyEffect(() => { const capturedView = view(); const capturedTerminalOpen = terminalOpen();

    if (!isMobile) return;
    // A handled back press cancels the event. An unhandled one lets the app go to the background.
    const back = (event: Event) => {
      if (capturedView === "settings") { if (canLeaveSettings()) setView("chat"); }
      else if (capturedTerminalOpen) setTerminalOpen(false);
      else if (panelOpen()) setPanelOpen(false);
      else return;
      event.preventDefault();
    };

    window.addEventListener("piop-mobile-back", back);

    return () => window.removeEventListener("piop-mobile-back", back);
  });
}
