/// <reference types="vite/client" />
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, CodexUsage, DirectoryListing, GitDiffSnapshot, GitDiffSnapshots, PendingMessage, RpcCommand, RpcEvent, SessionSummary } from "../types";

const call = <T>(command: string, args?: Record<string, unknown>) => {
  if (import.meta.env.MODE !== "e2e") return invoke<T>(command, args);
  const key = command === "pi_command" ? `${command}:${String((args?.command as RpcCommand)?.type)}` : command;
  const responseField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-responses"); const callField = document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls");
  const responses = JSON.parse(responseField?.value || "{}");
  if (callField?.value) { const calls = JSON.parse(callField.value); calls.push({ command, args, mocked: key in responses }); callField.value = JSON.stringify(calls); }
  if (!(key in responses)) return invoke<T>(command, args);
  const response = responses[key]; return response?.error ? Promise.reject(new Error(response.error)) : Promise.resolve(response as T);
};

export interface NativeConnectionTarget { cwd?: string; sessionPath?: string; sessionId?: string; hostId?: string; }
export interface GitWorktree { branch: string; path: string; }

export const openExternalUrl = (url: string) => call<void>("open_external_url", { url });

export class NativeTransport {
  private readonly runtimeId = globalThis.crypto?.randomUUID?.() ?? `runtime-${Date.now()}-${Math.random()}`;
  private pendingMessages: PendingMessage[] = [];
  private queueSnapshot: RpcEvent = { type: "queue_update", steering: [], followUp: [] };
  private changingQueue = false;
  private clearingQueue = false;
  private sendingPending = new Set<string>();
  private awaitingSteering: string[] = [];
  private steeringTimestamps = new Set<number>();
  private queueCommands: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(event: RpcEvent) => void>();
  private retainedStatuses = new Map<string, RpcEvent>();
  private retainedRequests = new Map<string, RpcEvent>();
  private unlisten?: UnlistenFn;
  private stderrUnlisten?: UnlistenFn;
  private stderrLines: string[] = [];
  private connectionVersion = 0;
  private connectPromise?: Promise<void>;
  private processLifecycle: Promise<unknown> = Promise.resolve();
  private settingsLifecycle: Promise<unknown> = Promise.resolve();
  private cwd?: string;
  private sessionPath?: string;
  private sessionId?: string;
  private hostId = "local";
  private running = false;
  private temporaryChat = false;
  private temporaryChatUsed = false;
  private fastStatusCommand?: string;
  private fastCommands = new Set<string>();
  constructor(target: NativeConnectionTarget = {}) { this.cwd = target.cwd; this.sessionPath = target.sessionPath; this.sessionId = target.sessionId; this.hostId = target.hostId ?? "local"; }
  currentHostId() { return this.hostId; }
  currentCwd() { return this.cwd; }
  currentSessionPath() { return this.sessionPath; }
  isTemporaryChat() { return this.temporaryChat; }
  lastDiagnostic() { return this.stderrLines.join("\n"); }
  private runProcessCommand<T>(command: () => Promise<T>) { const result = this.processLifecycle.then(command, command); this.processLifecycle = result.then(() => undefined, () => undefined); return result; }
  private publishQueue() {
    const available = [...this.pendingMessages];
    const pending: PendingMessage[] = [];
    // Consumption is FIFO within each mode. When identical texts remain, keep
    // the newest matching payloads so a consumed image cannot attach to a later row.
    for (const behavior of ["steer", "followUp"] as const) {
      const texts = (this.queueSnapshot[behavior === "steer" ? "steering" : "followUp"] as string[] | undefined) ?? [];
      for (const text of new Set(texts)) {
        const matches = available.filter((item) => !item.retry && !this.sendingPending.has(item.id) && item.behavior === behavior && item.message === text);
        const count = texts.filter((item) => item === text).length;
        for (const stale of matches.slice(0, Math.max(0, matches.length - count))) available.splice(available.indexOf(stale), 1);
      }
    }
    for (const behavior of ["steer", "followUp"] as const) {
      for (const message of (this.queueSnapshot[behavior === "steer" ? "steering" : "followUp"] as string[] | undefined) ?? []) {
        const index = available.findIndex((item) => !item.retry && item.behavior === behavior && item.message === message);
        if (index >= 0) pending.push(available.splice(index, 1)[0]);
      }
    }
    const visible = [...pending, ...available.filter((item) => item.retry)];
    this.pendingMessages = [...visible, ...available.filter((item) => !item.retry && this.sendingPending.has(item.id))];
    const event = { ...this.queueSnapshot, pendingMessages: visible };
    this.listeners.forEach((listener) => listener(event));
  }
  private emit(event: RpcEvent) {
    if (event.type === "queue_update") {
      if (!this.clearingQueue) {
        const remaining = [...((event.steering as string[]) ?? [])];
        for (const text of (this.queueSnapshot.steering as string[]) ?? []) {
          const index = remaining.indexOf(text);
          if (index >= 0) remaining.splice(index, 1); else this.awaitingSteering.push(text);
        }
      }
      this.queueSnapshot = event;
      if (!this.changingQueue) this.publishQueue();
      return;
    }
    if ((event.type === "message_start" || event.type === "message_end") && event.message) {
      const message = event.message as Record<string, unknown>;
      if (message.role === "user" && typeof message.timestamp === "number") {
        const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
        if (event.type === "message_start") {
          const index = this.awaitingSteering.indexOf(text);
          const sending = this.pendingMessages.some((item) => this.sendingPending.has(item.id) && item.behavior === "steer" && item.message === text);
          if (index >= 0 || sending) this.steeringTimestamps.add(message.timestamp);
          if (index >= 0) this.awaitingSteering.splice(index, 1);
        }
        if (this.steeringTimestamps.has(message.timestamp)) event = { ...event, message: { ...message, deliveryBehavior: "steer" } };
      }
    }
    if (event.type === "agent_settled") this.awaitingSteering = [];
    if (event.type === "extension_ui_request" && event.method === "setStatus" && typeof event.statusKey === "string") {
      if (event.statusText) this.retainedStatuses.set(event.statusKey, event); else this.retainedStatuses.delete(event.statusKey);
    }
    if (event.type === "extension_ui_request" && ["input", "editor", "select", "confirm"].includes(String(event.method)) && typeof event.id === "string") this.retainedRequests.set(event.id, event);
    this.listeners.forEach((listener) => listener(event));
  }
  async connect(cwd?: string, sessionPath?: string, hostId?: string, forkPath?: string, ephemeral = false) {
    if (cwd !== undefined) this.cwd = cwd; if (sessionPath !== undefined) { this.sessionPath = sessionPath; this.sessionId = undefined; } if (hostId !== undefined) this.hostId = hostId;
    if (this.running) return;
    if (this.connectPromise) return this.connectPromise;
    const pending = this.establishConnection(forkPath, ephemeral); this.connectPromise = pending;
    try { await pending; } finally { if (this.connectPromise === pending) this.connectPromise = undefined; }
  }
  private async establishConnection(forkPath?: string, ephemeral = false) {
    if (this.cwd === undefined && this.sessionPath === undefined) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId: this.hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionId = chat.sessionId; this.temporaryChat = true; }
    const version = ++this.connectionVersion;
    this.fastStatusCommand = undefined; this.fastCommands.clear();
    this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; this.stderrLines = [];
    const unlisten = await listen<RpcEvent | { runtimeId: string; event: RpcEvent }>("pi://event", ({ payload }) => {
      const envelope = payload as { runtimeId?: unknown; event?: RpcEvent };
      if (typeof envelope.runtimeId === "string") { if (envelope.runtimeId === this.runtimeId && envelope.event) { if (envelope.event.type === "disconnected") { this.running = false; this.retainedStatuses.clear(); this.retainedRequests.clear(); } this.emit(envelope.event); } }
      else this.emit(payload as RpcEvent);
    });
    const stderrUnlisten = await listen<{ runtimeId?: string; line?: string } | string>("pi://stderr", ({ payload }) => {
      const runtimeId = typeof payload === "string" ? this.runtimeId : payload.runtimeId;
      const line = typeof payload === "string" ? payload : payload.line;
      if (runtimeId !== this.runtimeId || !line?.trim()) return;
      this.stderrLines = [...this.stderrLines.slice(-4), line.trim()];
    });
    if (version !== this.connectionVersion) { unlisten(); stderrUnlisten(); return; }
    this.unlisten = unlisten; this.stderrUnlisten = stderrUnlisten;
    await this.runProcessCommand(() => call("start_pi", { runtimeId: this.runtimeId, cwd: this.cwd, sessionPath: this.sessionPath, sessionId: this.sessionId, forkPath, noSession: ephemeral, hostId: this.hostId }));
    if (version === this.connectionVersion) this.running = true;
  }
  async disconnect(discardBlank = false) { ++this.connectionVersion; this.unlisten?.(); this.stderrUnlisten?.(); this.unlisten = undefined; this.stderrUnlisten = undefined; await this.runProcessCommand(() => call("stop_pi", { runtimeId: this.runtimeId, discardBlank })); this.running = false; this.retainedStatuses.clear(); this.retainedRequests.clear(); }
  async reconnectForSettings(settings: AppSettings) {
    await this.disconnect();
    if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) { this.emit({ type: "disconnected" }); return; }
    try { await this.connect(); }
    catch (reason) { this.emit({ type: "disconnected" }); throw reason; }
  }
  async dispose() { const temporaryPath = this.temporaryChat && !this.temporaryChatUsed ? this.cwd : undefined; const temporaryHost = this.hostId; await this.disconnect(true); if (temporaryPath) await call<void>("remove_temporary_chat", { path: temporaryPath, hostId: temporaryHost }); this.temporaryChat = false; this.temporaryChatUsed = false; }
  private async refreshFastStatus(reload: boolean) {
    if (!this.fastStatusCommand) return;
    try {
      // Internal queries must not count as prompts that keep a temporary chat.
      await call("pi_command", { runtimeId: this.runtimeId, command: { type: "prompt", message: `/${this.fastStatusCommand}${reload ? " refresh" : ""}` } });
    } catch {
      this.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: "Fast mode status unavailable" });
    }
  }
  async toggleFastMode() {
    const command = this.fastCommands.values().next().value;
    if (!command) throw new Error("Fast mode is unavailable in this conversation");
    await call("pi_command", { runtimeId: this.runtimeId, command: { type: "prompt", message: `/${command} toggle` } });
    await this.refreshFastStatus(true);
  }
  private serializeQueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queueCommands.then(action, action);
    this.queueCommands = next.catch(() => undefined);
    return next;
  }
  command<T>(command: RpcCommand): Promise<T> {
    if (command.type !== "steer" && command.type !== "follow_up") {
      if (["clear_queue", "new_session", "switch_session", "fork", "clone"].includes(command.type)) return this.serializeQueue(() => this.executeCommand<T>(command));
      return this.executeCommand<T>(command);
    }
    return this.serializeQueue(async () => {
      const pending: PendingMessage = { id: crypto.randomUUID(), message: String(command.message), behavior: command.type === "steer" ? "steer" : "followUp", images: command.images as PendingMessage["images"] };
      this.pendingMessages.push(pending);
      this.sendingPending.add(pending.id);
      try { return await this.deliverPending<T>(pending); }
      catch (reason) { this.pendingMessages = this.pendingMessages.filter((item) => item !== pending); throw reason; }
      finally { this.sendingPending.delete(pending.id); this.publishQueue(); }
    });
  }
  private async deliverPending<T>(item: PendingMessage): Promise<T> {
    // Let the runtime choose atomically: steer/queue during a run, start a new
    // prompt if the run ended before the command arrived. Bare steer never wakes an idle agent.
    this.sendingPending.add(item.id);
    try { return await this.executeCommand<T>({ type: "prompt", message: item.message, streamingBehavior: item.behavior, ...(item.images?.length ? { images: item.images } : {}) }); }
    finally { this.sendingPending.delete(item.id); }
  }
  changePendingMessage(id: string, behavior: "steer" | "followUp"): Promise<void> {
    return this.serializeQueue(async () => {
      const target = this.pendingMessages.find((item) => item.id === id);
      if (!target) return; // Already consumed by the runtime.
      const send = (item: PendingMessage) => this.deliverPending(item);
      if (target.retry) {
        target.retry = false; target.behavior = behavior;
        try { await send(target); } catch (reason) { target.retry = true; this.publishQueue(); throw reason; }
        return;
      }
      // clear_queue returns text only. Only rewrite queues whose complete payloads
      // we own; duplicate text cannot be matched safely to distinct attachments.
      const snapshot = [...((this.queueSnapshot.steering as string[]) ?? []), ...((this.queueSnapshot.followUp as string[]) ?? [])];
      if (new Set(snapshot).size !== snapshot.length || snapshot.some((message) => !this.pendingMessages.some((item) => !item.retry && item.message === message))) throw new Error("This queue contains messages that cannot be safely switched. Use Ctrl+Enter to steer a new message.");
      const originals = [...this.pendingMessages];
      this.changingQueue = true;
      try {
        const cleared = await this.executeCommand<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" });
        const remaining = (["steer", "followUp"] as const).flatMap((mode) => (cleared[mode === "steer" ? "steering" : "followUp"] ?? []).map((text) => {
          const original = originals.find((item) => !item.retry && item.behavior === mode && item.message === text);
          return original ? { ...original, behavior: original.id === id ? behavior : mode } : { id: crypto.randomUUID(), message: text, behavior: mode, retry: true };
        }));
        this.pendingMessages = [...originals.filter((item) => item.retry), ...remaining];
        if (remaining.some((item) => item.retry)) {
          remaining.forEach((item) => { item.retry = true; });
          throw new Error("Another source changed the queue while switching. Pending text has been kept for retry; reattach any images from messages sent outside this window.");
        }
        for (let index = 0; index < remaining.length; index += 1) {
          try { await send(remaining[index]); }
          catch (reason) {
            // Keep full payloads, including images, available for an explicit retry.
            remaining.slice(index).forEach((item) => { item.retry = true; });
            throw reason;
          }
        }
      } finally { this.changingQueue = false; this.publishQueue(); }
    });
  }
  private async executeCommand<T>(command: RpcCommand) {
    const compact = command.type === "prompt" && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;
    if (compact) command = { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) };
    if (command.type === "clear_queue") this.clearingQueue = true;
    try {
      const result = await call<T>("pi_command", { runtimeId: this.runtimeId, command });
      if (command.type === "get_state") { const state = result as { sessionFile?: string; sessionId?: string }; this.sessionPath = state.sessionFile; this.sessionId = state.sessionId; }
      if (command.type === "get_entries") {
        const history = result as { entries: Array<{ message?: { role?: string; timestamp?: number; deliveryBehavior?: string } }> };
        for (const entry of history.entries) if (entry.message?.role === "user" && this.steeringTimestamps.has(entry.message.timestamp!)) entry.message.deliveryBehavior = "steer";
      }
      if (["new_session", "switch_session"].includes(command.type)) { this.awaitingSteering = []; this.steeringTimestamps.clear(); }
      if (command.type === "clear_queue") this.awaitingSteering = [];
      if (command.type === "get_commands") {
        const { commands } = result as { commands: Array<{ name: string; source: string; sourceInfo?: { source?: string; path?: string } }> };
        const fromPackage = (item: typeof commands[number], name: string) => item.sourceInfo?.source === `npm:${name}` || item.sourceInfo?.path?.split(/[\\/]/).includes(name);
        const fastCommands = commands.filter((item) => item.source === "extension" && /^fast(?::\d+)?$/.test(item.name) && ["pi-openai-fast-mode-piop", "pi-openai-fast-mode"].some((name) => fromPackage(item, name)));
        this.fastCommands = new Set(fastCommands.map((item) => item.name));
        // The local fork publishes its live state directly. Only the original
        // TUI-only package needs the compatibility query after each command.
        this.fastStatusCommand = fastCommands.some((item) => fromPackage(item, "pi-openai-fast-mode-piop")) ? undefined : commands.find((item) => item.source === "extension" && item.name === "pi-desktop-fast-status")?.name;
        await this.refreshFastStatus(false);
      }
      if (command.type === "prompt") {
        this.temporaryChatUsed = true;
        const invocation = typeof command.message === "string" ? command.message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/) : undefined;
        if (invocation && this.fastCommands.has(invocation[1]) && ["", "on", "off", "toggle"].includes((invocation[2] ?? "").trim().toLowerCase())) await this.refreshFastStatus(true);
      }
      if (command.type === "extension_ui_response" && typeof command.id === "string") this.retainedRequests.delete(command.id);
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason); const diagnostics = this.stderrLines.join("\n");
      throw new Error(diagnostics && /disconnect|connect|start|running/i.test(message) ? `${message}\n${diagnostics}` : message);
    } finally { if (command.type === "clear_queue") this.clearingQueue = false; }
  }
  subscribe(listener: (event: RpcEvent) => void) { this.listeners.add(listener); listener({ ...this.queueSnapshot, pendingMessages: this.pendingMessages }); this.retainedStatuses.forEach((event) => listener(event)); this.retainedRequests.forEach((event) => listener(event)); return () => this.listeners.delete(listener); }
  listSessions() { return call<SessionSummary[]>("list_sessions"); }
  captureGitTree(cwd: string, hostId = "local") { return call<string | null>("capture_git_tree", { cwd, hostId }); }
  discardGitTree(snapshot: string, hostId = "local") { return call<void>("discard_git_tree", { snapshot, hostId }); }
  loadGitDiff(cwd: string, baseTree: string, hostId = "local") { return call<GitDiffSnapshot | null>("load_git_diff", { cwd, baseTree, hostId }); }
  loadGitDiffs(sessionPath: string, hostId = "local") { return call<GitDiffSnapshots>("load_git_diffs", { sessionPath, hostId }); }
  saveGitDiffs(sessionPath: string, snapshots: GitDiffSnapshots, hostId = "local") { return call<void>("save_git_diffs", { sessionPath, snapshots, hostId }); }
  archiveSession(sessionPath: string, hostId = "local", terminalIds: string[] = []) { return call<void>("archive_session", { sessionPath, hostId, terminalIds }); }
  deleteSession(sessionPath: string, hostId = "local") { return call<void>("delete_session", { sessionPath, hostId }); }
  relocateSession(sessionPath: string, cwd: string, hostId = "local") { return call<void>("relocate_session", { sessionPath, cwd, hostId }); }
  openProjectDirectory(cwd: string, hostId = "local") { return call<void>("open_project_directory", { cwd, hostId }); }
  createGitWorktree(cwd: string, name: string, hostId = "local") { return call<GitWorktree>("create_git_worktree", { cwd, name, hostId }); }
  async isGitRepository() { if (!this.cwd) return false; return call<boolean>("is_git_repository", { cwd: this.cwd, hostId: this.hostId }); }
  async gitBranch() { if (!this.cwd) return null; const branch = await call<unknown>("git_branch", { cwd: this.cwd, hostId: this.hostId }); return typeof branch === "string" ? branch : null; }
  loadSettings() { return call<AppSettings>("load_app_settings"); }
  loadCodexUsage() { return call<CodexUsage>("codex_usage"); }
  saveSettings(settings: AppSettings, reconnect = true) {
    const save = async () => {
      const previous = await this.loadSettings(); const connection = { cwd: this.cwd, sessionPath: this.sessionPath, hostId: this.hostId };
      await call<void>("save_app_settings", { settings }); if (!reconnect) return;
      try { if (this.hostId !== "local" && !settings.hosts.some((host) => host.id === this.hostId)) { this.hostId = "local"; this.cwd = undefined; this.sessionPath = undefined; this.sessionId = undefined; this.temporaryChat = false; this.temporaryChatUsed = false; } await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); }
      catch (reason) {
        await call<void>("save_app_settings", { settings: previous }); this.cwd = connection.cwd; this.sessionPath = connection.sessionPath; this.hostId = connection.hostId;
        try { await this.disconnect(); await this.connect(this.cwd, this.sessionPath, this.hostId); } catch { /* Preserve the original failure; the persisted settings are already restored. */ }
        throw reason;
      }
    };
    const result = this.settingsLifecycle.then(save, save);
    this.settingsLifecycle = result.then(() => undefined, () => undefined);
    return result;
  }
  async selectProjectDirectory(defaultPath?: string) { const selected = await open({ directory: true, multiple: false, title: "Open project", defaultPath }); return typeof selected === "string" ? selected : null; }
  homeDirectory(hostId: string) { return call<string>("home_directory", { hostId }); }
  validateProjectDirectory(path: string, hostId: string) { return call<string>("validate_project_directory", { path, hostId }); }
  listDirectories(hostId: string, path?: string) { return call<DirectoryListing>("list_directories", { hostId, path }); }
  async prepareTemporaryChat(hostId: string) { const chat = await call<{ cwd: string; sessionId: string }>("create_temporary_chat", { hostId, e2e: import.meta.env.MODE === "e2e" }); this.cwd = chat.cwd; this.sessionPath = undefined; this.sessionId = chat.sessionId; this.hostId = hostId; this.temporaryChat = true; this.temporaryChatUsed = false; return chat.cwd; }
  startTerminal(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId = this.hostId) { return call<void>("start_terminal", { terminalId, sessionKey, cwd, cols, rows, hostId }); }
  writeTerminal(terminalId: string, data: string) { return call<void>("write_terminal", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return call<void>("resize_terminal", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return call<void>("close_terminal", { terminalId }); }
}

export async function readDroppedFile(path: string): Promise<File> {
  const result = await call<{ name: string; data: number[] }>("read_dropped_file", { path });
  const extension = result.name.split(".").pop()?.toLowerCase() ?? "";
  const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return new File([new Uint8Array(result.data)], result.name, { type: imageTypes[extension] ?? "" });
}
