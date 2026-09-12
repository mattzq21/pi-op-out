import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

const CACHE_LINEAGE_ENTRY = "piop-openai-cache-lineage";
const MAX_ANCESTORS = 64;
const MAX_CACHE_KEY_CHARS = 64;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const RUNTIME_STATE_PROPERTY = "__piopOpenAICacheLineageRuntime";
const WRAPPED_STREAM_PROPERTY = "__piopOpenAICacheLineageWrapper";

type JsonObject = Record<string, unknown>;
type CacheLineageRuntimeState = { activeId?: string };

const runtimeGlobal = globalThis as typeof globalThis & {
  [RUNTIME_STATE_PROPERTY]?: CacheLineageRuntimeState;
};
const runtimeState = runtimeGlobal[RUNTIME_STATE_PROPERTY] ??= {};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCacheKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return Array.from(value).slice(0, MAX_CACHE_KEY_CHARS).join("");
}

function storedLineage(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CACHE_LINEAGE_ENTRY || !isJsonObject(entry.data)) continue;
    const id = normalizeCacheKey(entry.data.id);
    if (id) return id;
  }
  return undefined;
}

function isSessionHeader(value: unknown): value is SessionHeader {
  return isJsonObject(value) && value.type === "session" && typeof value.id === "string" && value.id.length > 0;
}

async function readSessionHeader(path: string): Promise<SessionHeader | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = contents.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) return undefined;
    const value = JSON.parse(newline < 0 ? contents : contents.slice(0, newline)) as unknown;
    return isSessionHeader(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parentPath(parentSession: string, childPath: string | undefined): string {
  if (isAbsolute(parentSession) || !childPath) return parentSession;
  return resolve(dirname(childPath), parentSession);
}

async function inheritedLineage(ctx: ExtensionContext): Promise<string> {
  const sessionId = normalizeCacheKey(ctx.sessionManager.getSessionId()) ?? "session";
  const saved = storedLineage(ctx.sessionManager.getBranch() as SessionEntry[]);
  if (saved) return saved;

  let lineageId = sessionId;
  let childPath = ctx.sessionManager.getSessionFile();
  let parentSession = ctx.sessionManager.getHeader()?.parentSession;
  const visited = new Set<string>();

  for (let depth = 0; parentSession && depth < MAX_ANCESTORS; depth++) {
    const path = parentPath(parentSession, childPath);
    if (visited.has(path)) break;
    visited.add(path);
    const header = await readSessionHeader(path);
    if (!header) break;
    lineageId = normalizeCacheKey(header.id) ?? lineageId;
    childPath = path;
    parentSession = header.parentSession;
  }
  return lineageId;
}

function usesOpenAIResponses(model: unknown): boolean {
  if (!isJsonObject(model)) return false;
  return (model.provider === "openai-codex" && model.api === "openai-codex-responses")
    || (model.provider === "openai" && model.api === "openai-responses");
}

export default function openAICacheLineage(pi: ExtensionAPI): void {
  let cacheLineageId: string | undefined;

  const wrapCodexProvider = (ctx: ExtensionContext): void => {
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    if (!provider) return;
    const currentStream = provider.streamSimple as typeof provider.streamSimple & {
      [WRAPPED_STREAM_PROPERTY]?: boolean;
    };
    if (currentStream[WRAPPED_STREAM_PROPERTY]) return;
    const wrappedStream: typeof provider.streamSimple = (model, context, options) => provider.streamSimple(
      model,
      context,
      { ...options, sessionId: runtimeState.activeId ?? options?.sessionId },
    );
    Object.defineProperty(wrappedStream, WRAPPED_STREAM_PROPERTY, { value: true });
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      streamSimple: wrappedStream,
    });
  };

  const initialize = async (ctx: ExtensionContext): Promise<string> => {
    if (cacheLineageId) {
      runtimeState.activeId = cacheLineageId;
      return cacheLineageId;
    }
    cacheLineageId = await inheritedLineage(ctx);
    runtimeState.activeId = cacheLineageId;
    if (!storedLineage(ctx.sessionManager.getBranch() as SessionEntry[])) {
      try {
        pi.appendEntry(CACHE_LINEAGE_ENTRY, { id: cacheLineageId });
      } catch {
        // The in-memory lineage still fixes this process even if the marker cannot be persisted.
      }
    }
    return cacheLineageId;
  };

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
    wrapCodexProvider(ctx);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (!usesOpenAIResponses(ctx.model) || !isJsonObject(event.payload) || typeof event.payload.prompt_cache_key !== "string") return undefined;
    const promptCacheKey = await initialize(ctx);
    const payload = event.payload.prompt_cache_key === promptCacheKey
      ? event.payload
      : { ...event.payload, prompt_cache_key: promptCacheKey };
    return payload === event.payload ? undefined : payload;
  });
  pi.on("session_shutdown", () => {
    if (runtimeState.activeId === cacheLineageId) runtimeState.activeId = undefined;
    cacheLineageId = undefined;
  });
}
