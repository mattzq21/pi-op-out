import { extendedHooks } from "../../resources/hooks-extended/interface.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "piop-session-cost";

const LIMIT_ENTRY = "piop-session-cost-limit";

const MIN_LIMIT = 0.01;

const MAX_LIMIT = 100000;

const USAGE = "Usage: /cost <amount in USD> or /cost clear";

type CostContext = Pick<ExtensionContext, "sessionManager" | "ui">;

const amountSchema = Type.Number({ minimum: MIN_LIMIT, maximum: MAX_LIMIT });

const usageSchema = Type.Object({ cost: Type.Object({ total: Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_VALUE }) }) });

const messageCostSchema = Type.Object({ message: Type.Object({ usage: usageSchema }) });

const entryCostSchema = Type.Object({ usage: usageSchema });

const savedLimitSchema = Type.Object({ limit: Type.Optional(Type.Unknown()) });

function validAmount(value: unknown): value is number {
  return Check(amountSchema, value);
}

function parseAmount(raw: string): number {
  const normalized = raw.trim().replace(/^\$/, "");
  const amount = Number(normalized.replaceAll(",", ""));

  if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(normalized) || !validAmount(amount)) {
    throw new Error(`Invalid amount "${raw.trim()}". ${USAGE} (between $0.01 and $100,000)`);
  }

  return amount;
}

function entryCost(entry: ReturnType<CostContext["sessionManager"]["getBranch"]>[number]): number {
  if (entry.type === "message") return Check(messageCostSchema, entry) ? entry.message.usage.cost.total : 0;

  return ["compaction", "usage", "branch_summary"].includes(entry.type) && Check(entryCostSchema, entry) ? entry.usage.cost.total : 0;
}

function sessionCost(ctx: CostContext): number {
  let total = 0;
  let correction = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    const cost = entryCost(entry) - correction;
    const next = total + cost;
    correction = (next - total) - cost;
    total = next;
  }

  return total;
}

const formatCost = (value: number) => `$${value.toFixed(2)}`;

function compareCost(cost: number, limit: number): number {
  if (Math.abs(cost - limit) <= Number.EPSILON * Math.max(cost, limit) * 4) return 0;

  return cost < limit ? -1 : 1;
}

export default async function sessionCostLimit(pi: ExtensionAPI) {
  let limit: number | undefined;

  const restoreLimit = (ctx: CostContext) => {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === LIMIT_ENTRY);

    if (entry?.type === "custom") {
      const saved = Check(savedLimitSchema, entry.data) ? entry.data.limit : undefined;

      if (saved !== null && saved !== undefined && !validAmount(saved)) throw new Error("Invalid saved session cost limit");
      limit = validAmount(saved) ? saved : undefined;
    } else {
      limit = undefined;
    }
  };

  const overLimit = (ctx: CostContext) => limit !== undefined && compareCost(sessionCost(ctx), limit) >= 0 ? limit : undefined;

  const publish = (ctx: CostContext, pendingCost = 0) => {
    if (limit === undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined);

      return;
    }

    const cost = sessionCost(ctx) + pendingCost;
    ctx.ui.setStatus(STATUS_KEY, compareCost(cost, limit) >= 0
      ? `Session cost limit reached (${formatCost(cost)} / ${formatCost(limit)})`
      : `Session ${formatCost(cost)} / ${formatCost(limit)}`);
  };

  extendedHooks(pi).on("session_restore", (_event, ctx) => {
    restoreLimit(ctx);
    publish(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    publish(ctx, Check(messageCostSchema, event) ? event.message.usage.cost.total : 0);
  });
  pi.on("agent_end", (_event, ctx) => {
    publish(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    publish(ctx);
  });

  const cancelSummary = (ctx: CostContext) => {
    const reached = overLimit(ctx);

    if (reached === undefined) return;
    publish(ctx);
    ctx.ui.notify(`Session cost limit of ${formatCost(reached)} reached (API prices). Summary cancelled. Raise it with /cost <amount> or remove it with /cost clear.`, "warning");

    return { cancel: true };
  };

  pi.on("session_before_compact", (_event, ctx) => cancelSummary(ctx));
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary) return cancelSummary(ctx);
  });

  pi.on("cache_warming_decision", (event, ctx) => {
    if (limit === undefined) return;
    publish(ctx);
    const cost = sessionCost(ctx);

    if (compareCost(cost, limit) >= 0 || !Number.isFinite(event.warmCost) || compareCost(cost + Math.max(0, event.warmCost), limit) > 0) return { action: "stop" };
  });

  pi.on("input", (event, ctx) => {
    const reached = overLimit(ctx);

    if (reached === undefined) return;
    const error = `Session cost limit of ${formatCost(reached)} reached (API prices). Raise it with /cost <amount> or remove it with /cost clear.`;
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error }));
    ctx.ui.notify(error, "warning");

    return { action: "handled" };
  });

  pi.on("tool_call", (_event, ctx) => {
    const reached = overLimit(ctx);

    if (reached === undefined) return;
    publish(ctx);

    return { block: true, terminate: true, reason: `Session cost limit of ${formatCost(reached)} reached (API prices). Tool execution blocked.` };
  });
  const stopAtLimit = (ctx: ExtensionContext) => {
    const reached = overLimit(ctx);

    if (reached === undefined || ctx.signal?.aborted) return;
    publish(ctx);
    ctx.abort();
    ctx.ui.notify(`Session cost limit of ${formatCost(reached)} reached (API prices). Raise it with /cost <amount> or remove it with /cost clear.`, "warning");
  };

  pi.on("turn_start", (_event, ctx) => stopAtLimit(ctx));
  pi.on("context", (_event, ctx) => stopAtLimit(ctx));

  pi.registerCommand("cost", {
    description: "Set or clear this conversation's API cost limit. Usage: /cost <amount in USD> or /cost clear",
    getArgumentCompletions: (prefix: string) => [...(prefix.trim() ? [] : [{ value: "", label: "[amount | clear]" }]), ...("clear".startsWith(prefix.trim().toLowerCase()) ? [{ value: "clear", label: "clear" }] : [])],
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const raw = args.trim();

        if (/^clear$/i.test(raw)) {
          pi.appendEntry(LIMIT_ENTRY, { limit: null });
          limit = undefined;
          publish(ctx);
          ctx.ui.notify("Session cost limit cleared.", "info");

          return;
        }

        const amount = parseAmount(raw);
        pi.appendEntry(LIMIT_ENTRY, { limit: amount });
        limit = amount;
        publish(ctx);
        ctx.ui.notify(`Session cost limit set to ${formatCost(amount)} (API prices). Spent so far: ${formatCost(sessionCost(ctx))}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
