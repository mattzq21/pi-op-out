import { useEffect, type SetStateAction } from "react";
import { NativeTransport } from "./lib/nativeTransport";
import { appendTerminalOutput as retainTerminalOutput } from "./lib/terminalOutput";
import type { ChatMessage, CodexUsage, ExtensionUiRequest, OpencodeGoUsage, DefinedAgentsCapability, AgentConfig, SessionSummary } from "./types";

const staleExtensionContext = "This extension ctx is stale after session replacement or reload.";

type TerminalTabState = { id: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean };

type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };

type QueuedTerminalOutput = { data: string; length: number };

type BtwRequest = { task: string; forkFrom: string; requestId: string };

type SplitPaneState = { key: string; session: SessionSummary; btw?: BtwRequest };

type OwnedExtensionDialog = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };

type RenameTarget = { session: SessionSummary; transport: NativeTransport };

type WorktreeTarget = { transport: NativeTransport; cwd: string; hostId: string; message?: ChatMessage };

type TerminalTarget = { sessionKey: string; cwd?: string; hostId: string };

const BTW_REQUEST_TITLE = "__pi_desktop_btw__";

const PROMPT_CONTEXT_STATUS_KEY = "pi-desktop-prompt-context";

const MCP_STATUS_KEY = "pi-desktop-mcp-status";

const MAX_TERMINALS = 8;

const windowInstanceId = crypto.randomUUID();

const initialTerminals = (sessionId: string): SessionTerminals => { const id = `terminal-${windowInstanceId}-${sessionId}-1`; return { activeId: id, tabs: [{ id, output: "", outputEnd: 0, started: false }] }; };

function appendTerminalOutputs(current: Record<string, SessionTerminals>, chunks: Map<string, QueuedTerminalOutput>) {
  return Object.fromEntries(Object.entries(current).map(([sessionId, session]) => [sessionId, {
    ...session, tabs: session.tabs.map((terminal) => {
      const chunk = chunks.get(terminal.id);
      return chunk ? { ...terminal, ...retainTerminalOutput(terminal.output, terminal.outputEnd, chunk.data, chunk.length) } : terminal;
    })
  }]));
}

function selectedProjectCwd(cwd: string | undefined, temporary: boolean) { return !cwd || temporary ? undefined : cwd; }

function formatCodexReset(resetAt: number, now = Date.now()) {
  if (!Number.isFinite(resetAt)) return "—";
  const remaining = Math.max(0, resetAt * 1000 - now);
  if (!Number.isFinite(remaining)) return "—";
  if (remaining === 0) return "now";
  const day = 24 * 60 * 60 * 1000;
  if (remaining > day) return `${Math.ceil(remaining / day)}d`;
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ""}` : `${Math.max(1, minutes)}m`;
}

function usageWindowsDescription(usage: OpencodeGoUsage): string {
  return `rolling ${usage.rolling.remainingPercent}% left, weekly ${usage.weekly.remainingPercent}% left, monthly ${usage.monthly.remainingPercent}% left`;
}

function normalizeOpencodeGoUsage(value: unknown): OpencodeGoUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, { remainingPercent?: unknown }>;
  for (const window of ["rolling", "weekly", "monthly"] as const) {
    if (typeof usage[window]?.remainingPercent !== "number") return undefined;
  }
  return value as OpencodeGoUsage;
}

function normalizeCodexUsage(value: unknown): CodexUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return typeof (value as { remainingPercent?: unknown }).remainingPercent === "number" ? (value as CodexUsage) : undefined;
}

function LimitBadge({ label, prefix, go, detail, remainingPercent, resetAt }: { label: string; prefix?: string; go?: boolean; detail?: string; remainingPercent: number; resetAt?: number }) {
  return <span className={go ? "codex-usage opencode-go-usage" : "codex-usage"} role="status" aria-label={`${label} usage remaining: ${remainingPercent}%${resetAt ? `, resets ${formatCodexReset(resetAt)}` : ""}${detail ? ` (${detail})` : ""}`} title={`${label} usage remaining`}><span>{prefix}{remainingPercent}%<span className="codex-usage-left"> left</span></span>{resetAt && <span className="codex-usage-reset"><span className="codex-usage-separator"> · </span>{formatCodexReset(resetAt)}</span>}</span>;
}

function goUsageBadge(usage?: OpencodeGoUsage) { return usage === undefined ? undefined : { window: usage.rolling, detail: usageWindowsDescription(usage) }; }

function dialogOwnerName(name?: string) { return name ? `Main: ${name}` : "Main conversation"; }

function splitConversationKey(pane?: SplitPaneState) { return pane ? `${pane.session.hostId ?? "local"}:${pane.session.id}` : ""; }

function terminalConversationKey(target: TerminalTarget | undefined, fallback: string) { return target?.sessionKey ?? fallback; }

function AppLoading({ error }: { error?: string }) {
  return <main className="app app-loading dark" role={error ? "alert" : "status"}>
    <p className="eyebrow">piop</p>
    <h1>{error ? "Could not load settings" : "Loading settings…"}</h1>
    {error && <p>{error}</p>}
  </main>;
}

function useUsageClock(codexUsage: CodexUsage | undefined, opencodeGoUsage: OpencodeGoUsage | undefined, setUsageClock: React.Dispatch<SetStateAction<number>>) {
  useEffect(() => {
    if (!codexUsage?.resetAt && !opencodeGoUsage?.rolling.resetAt && !opencodeGoUsage?.weekly.resetAt && !opencodeGoUsage?.monthly.resetAt) return;
    const timer = window.setInterval(() => setUsageClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [codexUsage?.resetAt, opencodeGoUsage?.rolling.resetAt, opencodeGoUsage?.weekly.resetAt, opencodeGoUsage?.monthly.resetAt]);
}

function definedAgentSettings(capability?: DefinedAgentsCapability): AgentConfig | undefined { return capability ? { agents: capability.config.agents, fastModeModels: capability.config.fastModeModels } : undefined; }
export type { TerminalTabState, SessionTerminals, QueuedTerminalOutput, BtwRequest, SplitPaneState, OwnedExtensionDialog, RenameTarget, WorktreeTarget, TerminalTarget };
export { staleExtensionContext, BTW_REQUEST_TITLE, PROMPT_CONTEXT_STATUS_KEY, MCP_STATUS_KEY, MAX_TERMINALS, windowInstanceId, initialTerminals, appendTerminalOutputs, selectedProjectCwd, formatCodexReset, usageWindowsDescription, normalizeOpencodeGoUsage, normalizeCodexUsage, LimitBadge, goUsageBadge, dialogOwnerName, splitConversationKey, terminalConversationKey, AppLoading, useUsageClock, definedAgentSettings };
