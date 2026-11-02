import { Type as Schema, type Static } from "typebox";
import { Check } from "typebox/value";
import type { RawSource, SearchBackend } from "./interface.ts";

// A Claude Pro/Max sign-in only works for requests that look like Claude Code. Pi's Anthropic provider sends the same identity.
const CLAUDE_CODE_VERSION = "2.1.280";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const MAX_CONTINUATIONS = 5;

const blockSchema = Schema.Object({
  type: Schema.String(), text: Schema.Optional(Schema.Unknown()), citations: Schema.Optional(Schema.Unknown()), content: Schema.Optional(Schema.Unknown()),
  url: Schema.Optional(Schema.Unknown()), title: Schema.Optional(Schema.Unknown()), error_code: Schema.Optional(Schema.Unknown()),
});

const messageSchema = Schema.Object({ content: Schema.Array(Schema.Unknown()), stop_reason: Schema.Union([Schema.String(), Schema.Null()]) });

type Block = Static<typeof blockSchema>;

const block = (value: unknown): value is Block => Check(blockSchema, value);

function parseMessage(text: string) {
  const payload: unknown = JSON.parse(text);

  if (!Check(messageSchema, payload)) throw new Error("Invalid web search response");

  return { content: payload.content, stopReason: payload.stop_reason };
}

function extractResult(content: unknown[]) {
  const parts: string[] = [];
  const sources: RawSource[] = [];
  const results: RawSource[] = [];
  const errors: string[] = [];
  let searched = false;

  for (const item of content.filter(block)) {
    if (item.type === "text" && Check(Schema.String(), item.text)) {
      parts.push(item.text);

      if (Array.isArray(item.citations)) {
        for (const citation of item.citations.filter(block)) if (citation.type === "web_search_result_location") sources.push(citation);
      }
    }

    if (item.type !== "web_search_tool_result") continue;

    if (Array.isArray(item.content)) {
      searched = true;
      results.push(...item.content.filter(block).filter((result) => result.type === "web_search_result"));
    } else if (block(item.content) && item.content.type === "web_search_tool_result_error") {
      errors.push(String(item.content.error_code));
    }
  }

  if (!searched) throw new Error(errors.length ? `Claude web search failed: ${errors.join(", ")}` : "Claude returned an answer without performing a web search.");

  return { answer: parts.join(""), sources: [...sources, ...results] };
}

export const anthropic: SearchBackend = {
  api: "anthropic-messages",
  account: "a Claude Pro/Max sign-in. Use Pi /login → Anthropic (Claude Pro/Max) on this host",
  accepts: (apiKey) => apiKey.includes("sk-ant-oat"),

  async search({ modelId, baseUrl, apiKey, headers, query, domains, instructions }, post) {
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Accept", "application/json");
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20");
    headers.set("user-agent", `claude-cli/${CLAUDE_CODE_VERSION}`);
    headers.set("x-app", "cli");
    const tool = { type: "web_search_20250305", name: "web_search", max_uses: 5, ...(domains.length ? { allowed_domains: domains } : {}) };
    const messages: unknown[] = [{ role: "user", content: query }];
    const content: unknown[] = [];

    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const reply = parseMessage(await post(`${baseUrl}/v1/messages`, headers, {
        model: modelId,
        max_tokens: 8192,
        system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: instructions }],
        messages,
        tools: [tool],
      }));
      content.push(...reply.content);

      if (reply.stopReason === "end_turn") return extractResult(content);

      if (reply.stopReason !== "pause_turn") throw new Error(`Claude web search stopped early: ${reply.stopReason ?? "no reason"}.`);
      messages.splice(1, 1, { role: "assistant", content });
    }

    throw new Error("Claude web search did not finish. Try a narrower query.");
  },
};
