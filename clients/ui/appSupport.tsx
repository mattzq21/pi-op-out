import { type Accessor } from "solid-js";
import { z } from "zod";
import { createDependencyEffect, type Dispatch, type StateUpdate } from "./lib/solid";

import { NativeTransport } from "./lib/nativeTransport";
import { appendTerminalOutput as retainTerminalOutput } from "./lib/terminalOutput";
import { isTemporaryChatCwd } from "./lib/sessionGroups";
import type { AgentConfig, CodexUsage, DefinedAgentsCapability, ExtensionUiRequest, OpencodeGoUsage, SessionSummary } from "./types";

const staleExtensionContext = "This extension ctx is stale after session replacement or reload.";

type TerminalTabState = { id: string; output: string; outputEnd: number; inputDraft?: string; snapshot?: string; snapshotEnd?: number; placeholder?: boolean; started: boolean; exited?: boolean; owned?: boolean; generation?: string };

type SessionTerminals = { activeId: string; tabs: TerminalTabState[] };

type QueuedTerminalOutput = { data: string; length: number };

type SplitPaneState = { key: string; session: SessionSummary; request?: import("./plugins/types").SplitPaneRequest };

type OwnedExtensionDialog = { request: ExtensionUiRequest; transport: NativeTransport; owner: string; queueId: string };

type RenameTarget = { session: SessionSummary; transport: NativeTransport };

type TerminalTarget = { sessionKey: string; cwd?: string; hostId: string };

const PROMPT_CONTEXT_STATUS_KEY = "pi-desktop-prompt-context";

const MCP_STATUS_KEY = "pi-desktop-mcp-status";

const MAX_TERMINALS = 8;

const windowInstanceId = crypto.randomUUID();

const initialTerminals = (sessionId: string): SessionTerminals => { const id = `shared-terminal-${windowInstanceId}-${sessionId}-1`;

return { activeId: id, tabs: [{ id, output: "", outputEnd: 0, placeholder: true, started: false }] }; };

function appendTerminalOutputs(current: Record<string, SessionTerminals>, chunks: Map<string, QueuedTerminalOutput>) {
  let changed = false;

  const next = Object.fromEntries(Object.entries(current).map(([sessionId, session]) => {
    if (!session.tabs.some(terminal => chunks.has(terminal.id))) return [sessionId, session];
    changed = true;

    return [sessionId, {
      ...session, tabs: session.tabs.map((terminal) => {
        const chunk = chunks.get(terminal.id);

        return chunk ? { ...terminal, ...retainTerminalOutput(terminal.output, terminal.outputEnd, chunk.data, chunk.length) } : terminal;
      }),
    }];
  }));

  return changed ? next : current;
}

function selectedProjectCwd(cwd: string | undefined, temporary: boolean) { return !cwd || temporary || isTemporaryChatCwd(cwd) ? undefined : cwd; }

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

const usageWindowSchema = z.looseObject({
  remainingPercent: z.number(),
  resetAt: z.number().optional(),
});

const goUsageWindowSchema = usageWindowSchema.extend({ status: z.string().default("unknown") });

const normalizeOpencodeGoUsage = z.object({
  rolling: goUsageWindowSchema,
  weekly: goUsageWindowSchema,
  monthly: goUsageWindowSchema,
}).optional().catch(undefined).parse;

const normalizeCodexUsage = usageWindowSchema.optional().catch(undefined).parse;

function LimitBadge(componentProps: { label: string; prefix?: string; go?: boolean; detail?: string; remainingPercent: number; resetAt?: number; clock?: number }) {
  const resetLabel = () => { componentProps.clock;

  return componentProps.resetAt ? formatCodexReset(componentProps.resetAt) : ""; };

  return <span class={componentProps.go ? "codex-usage opencode-go-usage" : "codex-usage"} role="status" aria-label={`${componentProps.label} usage remaining: ${componentProps.remainingPercent}%${componentProps.resetAt ? `, resets ${resetLabel()}` : ""}${componentProps.detail ? ` (${(componentProps.detail)})` : ""}`} data-tooltip={`${componentProps.label} usage remaining`}><span>{componentProps.prefix}{componentProps.remainingPercent}%<span class="codex-usage-left"> left</span></span>{componentProps.resetAt && <span class="codex-usage-reset"><span class="codex-usage-separator"> · </span>{resetLabel()}</span>}</span>;
}

function goUsageBadge(usage?: OpencodeGoUsage) { return usage === undefined ? undefined : { window: usage.rolling, detail: usageWindowsDescription(usage) }; }

function dialogOwnerName(name?: string) { return name ? `Main: ${name}` : "Main conversation"; }

function splitConversationKey(pane?: SplitPaneState) { return pane ? `${pane.session.hostId ?? "local"}:${pane.session.id}` : ""; }

function terminalConversationKey(target: TerminalTarget | undefined, fallback: string) { return target?.sessionKey ?? fallback; }

function AppLoading(componentProps: { error?: string }) {
  return <main class="app app-loading" role={componentProps.error ? "alert" : "status"}>
    <p class="eyebrow">piop</p>
    <h1>{componentProps.error ? "Could not load settings" : "Loading settings…"}</h1>
    {componentProps.error && <p>{(componentProps.error)}</p>}
  </main>;
}

function useUsageClock(codexUsage: Accessor<CodexUsage | undefined>, opencodeGoUsage: Accessor<OpencodeGoUsage | undefined>, setUsageClock: Accessor<Dispatch<StateUpdate<number>>>) {
  createDependencyEffect(() => { const capturedCodexUsage = codexUsage(); const capturedOpencodeGoUsage = opencodeGoUsage(); const capturedSetUsageClock = setUsageClock();

    if (!capturedCodexUsage?.resetAt && !capturedOpencodeGoUsage?.rolling.resetAt && !capturedOpencodeGoUsage?.weekly.resetAt && !capturedOpencodeGoUsage?.monthly.resetAt) return;
    const timer = window.setInterval(() => capturedSetUsageClock((value) => value + 1), 60_000);

    return () => window.clearInterval(timer);
  }, () => [codexUsage()?.resetAt, opencodeGoUsage()?.rolling.resetAt, opencodeGoUsage()?.weekly.resetAt, opencodeGoUsage()?.monthly.resetAt]);
}

function definedAgentSettings(capability?: DefinedAgentsCapability): AgentConfig | undefined { return capability ? { agents: capability.config.agents } : undefined; }

export { appendTerminalOutputs,AppLoading,definedAgentSettings,dialogOwnerName,formatCodexReset,goUsageBadge,initialTerminals,LimitBadge,MAX_TERMINALS,MCP_STATUS_KEY,normalizeCodexUsage,normalizeOpencodeGoUsage,PROMPT_CONTEXT_STATUS_KEY,selectedProjectCwd,splitConversationKey,staleExtensionContext,terminalConversationKey,usageWindowsDescription,useUsageClock,windowInstanceId };

export type { OwnedExtensionDialog,QueuedTerminalOutput,RenameTarget,SessionTerminals,SplitPaneState,TerminalTabState,TerminalTarget };
