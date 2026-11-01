import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type as Schema } from "typebox";
import { Parse } from "typebox/value";
import { promptTools } from "./prompt-tools.ts";

const definitions = Schema.Array(Schema.Object({
  name: Schema.String({ minLength: 1 }), label: Schema.String(), description: Schema.String(), parameters: Schema.Record(Schema.String(), Schema.Unknown()),
  exposure: Schema.Optional(Schema.Union([Schema.Literal("direct"), Schema.Literal("model-only")])),
}));

const answer = Schema.Object({ text: Schema.String(), details: Schema.Unknown() });

export function registerQueueTools(pi: ExtensionAPI) {
  const tools = Parse(definitions, JSON.parse(process.env.PIOP_QUEUE_TOOLS ?? "[]"));
  const kept = new Map<string, boolean>();
  const prompt = promptTools(pi);
  const removals: Array<() => void> = [];

  for (const tool of tools) {
    pi.registerTool({
      ...tool,
      parameters: tool.parameters as never,
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const send = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("piop.runtime-events"))?.value as ((name: string, data: unknown) => Promise<unknown>) | undefined;

        if (!send) throw new Error("Piop runtime events are unavailable");
        const result = Parse(answer, await send("queue_tool", { tool: tool.name, params }));

        return { content: [{ type: "text" as const, text: result.text }], details: result.details };
      },
    });
    removals.push(prompt.register(tool.name, () => kept.get(tool.name) === true));
  }

  const off = pi.events.on("piop:rpc", request => {
    if (request.command !== "queue_tools") return;
    const state = request.payload as Record<string, unknown>;

    for (const tool of tools) {
      const keep = state?.[tool.name] === true;
      kept.set(tool.name, keep);

      if (keep) prompt.show(tool.name);
    }
  });

  pi.on("session_shutdown", () => { off(); for (const remove of removals) remove(); });
}
