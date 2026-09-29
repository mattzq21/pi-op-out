import { type Accessor } from "solid-js";
import { createDependencyEffect } from "./lib/solid";
import type { AppTerminals } from "./appTerminals";
import type { AppExtensions } from "./appExtensions";
import type { NativeTransport } from "./lib/nativeTransport";
import type { AppSettings, RpcEvent } from "./types";

type AppEventsContext = {
  transport: NativeTransport;
  isCurrent: () => boolean;
  handleEvent: (event: RpcEvent) => void;
  refresh: () => Promise<AppSettings>;
  refreshSession: () => Promise<unknown>;
  configureRuntime: (value: AppSettings) => Promise<void>;
  hostChanged: () => void;
  connected: (value: boolean) => void;
  failed: (message?: string) => void;
  extensions: Pick<AppExtensions, "activate" | "disconnect" | "handleEvent" | "closeTransportDialogs">;
  terminals: Pick<AppTerminals, "handleEvent" | "flush">;
};

export function useAppEvents(options: Accessor<AppEventsContext>) {
  createDependencyEffect(() => { const capturedOptions = options();
    let cancelled = false; let reconnecting = false; const refreshTimers = new Set<number>();
    capturedOptions.extensions.activate();
    const loadSelectedSession = async () => {
      const current = () => !cancelled && capturedOptions.isCurrent();
      await capturedOptions.transport.connect();
      if (!current()) return;
      const settings = await capturedOptions.refresh();
      if (!current()) return;
      await capturedOptions.configureRuntime(settings);
      if (!current()) return;
      await capturedOptions.refreshSession();
      if (!current()) return;
      capturedOptions.failed(undefined);
      capturedOptions.connected(true);
    };
    const unsubscribe = capturedOptions.transport.subscribe((event: RpcEvent) => {
      capturedOptions.handleEvent(event);
      capturedOptions.terminals.handleEvent(event);
      capturedOptions.extensions.handleEvent(capturedOptions.transport, event);
      const handleMessageEnd = () => {
        const timer = window.setTimeout(() => { refreshTimers.delete(timer); if (!cancelled) void capturedOptions.refresh().catch(() => undefined); }, 30);
        refreshTimers.add(timer);
      };
      const handleSessionSwitched = () => {
        void capturedOptions.refresh().catch(() => undefined);
      };
      const handleSettingsApplied = () => {
        const current = () => !cancelled && capturedOptions.isCurrent();
        if (!current()) return;
        capturedOptions.hostChanged();
        void capturedOptions.refresh().then((value) => current() ? capturedOptions.configureRuntime(value) : undefined).then(() => { if (current()) { capturedOptions.failed(undefined); capturedOptions.connected(true); } }).catch((reason) => { if (current()) capturedOptions.failed(String(reason)); });
      };
      const handleSessionInfoChanged = () => {
        void capturedOptions.refresh().catch(() => undefined);
      };
      const handleOwnershipLost = () => {
        capturedOptions.connected(false);
        void capturedOptions.extensions.closeTransportDialogs(capturedOptions.transport);
      };
      const handleOwnershipAcquired = () => {
        capturedOptions.connected(false);
      };
      const handleDisconnected = () => {
        capturedOptions.extensions.disconnect(capturedOptions.transport);
        capturedOptions.connected(false);
        if (reconnecting) return;
        reconnecting = true;
        window.setTimeout(() => {
          if (cancelled) return; const diagnostic = capturedOptions.transport.lastDiagnostic();
          void loadSelectedSession().catch((reason: unknown) => { if (!cancelled) { const message = reason instanceof Error ? reason.message : String(reason); capturedOptions.failed(diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message); } }).finally(() => { reconnecting = false; });
        }, 50);
      };
      const handlers: Record<string, () => void> = {
        "message_end": handleMessageEnd,
        "session_switched": handleSessionSwitched,
        "settings_applied": handleSettingsApplied,
        "session_info_changed": handleSessionInfoChanged,
        "ownership_lost": handleOwnershipLost,
        "ownership_acquired": handleOwnershipAcquired,
        "disconnected": handleDisconnected,
        "connection_restored": handleDisconnected
      };
      if (Object.hasOwn(handlers, event.type)) handlers[event.type]();
    });
    loadSelectedSession().catch((reason: unknown) => { if (!cancelled) capturedOptions.failed(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; refreshTimers.forEach(window.clearTimeout); unsubscribe(); capturedOptions.terminals.flush(); };
  }, () => [options().configureRuntime, options().handleEvent, options().extensions, options().terminals, options().refresh, options().refreshSession, options().transport]);
}
