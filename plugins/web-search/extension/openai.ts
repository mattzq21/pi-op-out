import { Type as Schema, type Static } from "typebox";
import { Check } from "typebox/value";
import type { SearchBackend } from "./interface.ts";

const responseValueSchema = Schema.Object({
  type: Schema.Optional(Schema.Unknown()), status: Schema.Optional(Schema.Unknown()), error: Schema.Optional(Schema.Unknown()), message: Schema.Optional(Schema.Unknown()),
  response: Schema.Optional(Schema.Unknown()), item: Schema.Optional(Schema.Unknown()), output: Schema.Optional(Schema.Unknown()), content: Schema.Optional(Schema.Unknown()),
  annotations: Schema.Optional(Schema.Unknown()), text: Schema.Optional(Schema.Unknown()), title: Schema.Optional(Schema.Unknown()), caption: Schema.Optional(Schema.Unknown()),
  url: Schema.Optional(Schema.Unknown()), source_website_url: Schema.Optional(Schema.Unknown()), action: Schema.Optional(Schema.Unknown()), sources: Schema.Optional(Schema.Unknown()), results: Schema.Optional(Schema.Unknown()),
});

type RecordValue = Static<typeof responseValueSchema>;

function record(value: unknown): value is RecordValue {
  return Check(responseValueSchema, value);
}

function responseError(payload: RecordValue): string | undefined {
  if (payload.error) {
    return record(payload.error) && Check(Schema.String(), payload.error.message) ? payload.error.message : "Web search failed";
  }

  if (payload.status && payload.status !== "completed") return `Web search response was ${payload.status}`;
}

function streamEvent(frame: string) {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");

  if (!data || data === "[DONE]") return undefined;
  const event: unknown = JSON.parse(data);

  if (!record(event)) return undefined;

  if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) {
    const failure = record(event.response) ? event.response : event;
    throw new Error(responseError(failure) ?? (Check(Schema.String(), event.message) ? event.message : "Web search failed"));
  }

  return event;
}

function streamResponse(text: string, items: RecordValue[]) {
  let completed: RecordValue | undefined;

  for (const frame of text.split(/\r?\n\r?\n/)) {
    const event = streamEvent(frame);

    if (!event) continue;

    if (event.type === "response.output_item.done" && record(event.item)) items.push(event.item);

    if ((event.type === "response.completed" || event.type === "response.done") && record(event.response)) completed = event.response;
  }

  return completed;
}

function parseResponse(text: string): RecordValue[] {
  let completed: RecordValue | undefined;
  const items: RecordValue[] = [];

  if (text.trimStart().startsWith("{")) {
    const payload: unknown = JSON.parse(text);

    if (!record(payload)) throw new Error("Invalid web search response");
    completed = payload;
  } else {
    completed = streamResponse(text, items);
  }

  if (!completed) throw new Error("Web search stream ended before completion. Try the search again.");
  const error = responseError(completed);

  if (error) throw new Error(error);
  const output = Array.isArray(completed.output) && completed.output.length ? completed.output.filter(record) : items;

  if (!output.some((item) => item.type === "web_search_call")) throw new Error("OpenAI returned an answer without performing a web search.");

  return output;
}

const source = (value: RecordValue) => ({ url: value.url ?? value.source_website_url, title: value.title ?? value.caption });

function extractResult(output: RecordValue[]) {
  const parts: string[] = [];
  const sources: ReturnType<typeof source>[] = [];

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(record)) {
        if (part.type === "output_text" && Check(Schema.String(), part.text)) parts.push(part.text);

        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations.filter(record)) if (annotation.type === "url_citation") sources.push(source(annotation));
        }
      }
    }
  }

  for (const item of output) {
    if (item.type !== "web_search_call") continue;

    for (const group of [record(item.action) ? item.action.sources : undefined, item.sources, item.results]) {
      if (Array.isArray(group)) sources.push(...group.filter(record).map(source));
    }
  }

  return { answer: parts.join("\n"), sources };
}

export const openai: SearchBackend = {
  api: "openai-responses",
  account: "an OpenAI ChatGPT sign-in. Use Pi /login → OpenAI (Sign in with ChatGPT) on this host",
  accepts: (apiKey) => !apiKey.startsWith("sk-"),

  async search({ modelId, baseUrl, apiKey, headers, query, domains, instructions }, post) {
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Accept", "text/event-stream");
    const searchTool = domains.length ? { type: "web_search", filters: { allowed_domains: domains } } : { type: "web_search" };
    const text = await post(`${baseUrl}/responses`, headers, {
      model: modelId,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [searchTool],
      include: ["web_search_call.action.sources"],
      store: false, stream: true, tool_choice: "required", parallel_tool_calls: true,
    });

    return extractResult(parseResponse(text));
  },
};
