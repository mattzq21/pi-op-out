import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "piop-session-cost";
const LIMIT_ENTRY = "piop-session-cost-limit";
const MIN_LIMIT = 0.01;
const MAX_LIMIT = 100000;
const USAGE = "Usage: /cost <amount in USD> or /cost clear";

type CostContext = Pick<ExtensionContext, "sessionManager" | "ui">;

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_LIMIT && value <= MAX_LIMIT;
}

function parseAmount(raw: string): number {
  const normalized = raw.trim().replace(/^\$/, "").replaceAll(",", "");
  const amount = Number(normalized);
  if (normalized === "" || !validAmount(amount)) {
    throw new Error(`Invalid amount "${raw.trim()}". ${USAGE} (between $0.01 and $100,000)`);
  }
  return amount;
}

function entryCost(entry: unknown): number {
  if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") return 0;
  const amount = (entry as { message?: { usage?: { cost?: { total?: unknown } } } }).message?.usage?.cost?.total;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function sessionCost(ctx: CostContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    total += entryCost(entry);
  }
  return total;
}

const formatCost = (value: number) => `$${value.toFixed(2)}`;

export default async function sessionCostLimit(pi: ExtensionAPI) {
  let limit: number | undefined;

  const restoreLimit = (ctx: CostContext) => {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === LIMIT_ENTRY);
    if (entry?.type === "custom") {
      const saved = (entry.data as { limit?: unknown } | undefined)?.limit;
      if (saved !== null && saved !== undefined && !validAmount(saved)) throw new Error("Invalid saved session cost limit");
      limit = typeof saved === "number" ? saved : undefined;
    } else {
      limit = undefined;
    }
  };

  const overLimit = (ctx: CostContext) => limit !== undefined && sessionCost(ctx) >= limit;

  const publish = (ctx: CostContext) => {
    if (limit === undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const cost = sessionCost(ctx);
    ctx.ui.setStatus(STATUS_KEY, cost >= limit
      ? `Session cost limit reached (${formatCost(cost)} / ${formatCost(limit)})`
      : `Session ${formatCost(cost)} / ${formatCost(limit)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    restoreLimit(ctx);
    publish(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreLimit(ctx);
    publish(ctx);
  });
  pi.on("message_end", (_event, ctx) => {
    publish(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    publish(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.text.startsWith("/")) return;
    if (!overLimit(ctx)) return;
    const error = `Session cost limit of ${formatCost(limit!)} reached (API prices). Raise it with /cost <amount> or remove it with /cost clear.`;
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error }));
    ctx.ui.notify(error, "warning");
    return { action: "handled" };
  });

  pi.on("tool_call", (_event, ctx) => {
    if (!overLimit(ctx)) return;
    publish(ctx);
    return { block: true, terminate: true, reason: `Session cost limit of ${formatCost(limit!)} reached (API prices). Tool execution blocked.` };
  });

  pi.registerCommand("cost", {
    description: "Set or clear this conversation's API cost limit. Usage: /cost <amount in USD> or /cost clear",
    getArgumentCompletions: (prefix: string) => ("clear".startsWith(prefix.trim().toLowerCase()) ? [{ value: "clear", label: "clear" }] : []),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const raw = args.trim();
        if (/^clear$/i.test(raw)) {
          limit = undefined;
          pi.appendEntry(LIMIT_ENTRY, { limit: null });
          publish(ctx);
          ctx.ui.notify("Session cost limit cleared.", "info");
          return;
        }
        const amount = parseAmount(raw);
        limit = amount;
        pi.appendEntry(LIMIT_ENTRY, { limit: amount });
        publish(ctx);
        ctx.ui.notify(`Session cost limit set to ${formatCost(amount)} (API prices). Spent so far: ${formatCost(sessionCost(ctx))}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
