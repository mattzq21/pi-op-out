import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const CACHE_FORK_ENTRY = "piop-openai-cache-fork";

const LEGACY_CACHE_LINEAGE_ENTRY = "piop-openai-cache-lineage";

const MAX_ANCESTORS = 64;

const MAX_CACHE_KEY_CHARS = 64;

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

const RUNTIME_STATE_PROPERTY = "__piopOpenAICacheLineageRuntime";

const WRAPPED_STREAM_PROPERTY = "__piopOpenAICacheLineageWrapper";

type CacheLineageRuntimeState = { activeId?: string };

declare global {
  var __piopOpenAICacheLineageRuntime: CacheLineageRuntimeState | undefined;
}

const runtimeState = globalThis[RUNTIME_STATE_PROPERTY] ??= {};

const lineageSchema = Type.Object({ id: Type.String() });

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String({ minLength: 1 }), parentSession: Type.Optional(Type.String()) });

type LineageHeader = Static<typeof headerSchema>;

const modelSchema = Type.Object({ provider: Type.String(), api: Type.String() });

const payloadSchema = Type.Object({ prompt_cache_key: Type.String() });

function normalizeCacheKey(value: string | undefined): string | undefined {
  if (!value) return undefined;

  return Array.from(value).slice(0, MAX_CACHE_KEY_CHARS).join("");
}

function storedLineage(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (entry?.type !== "custom" || (entry.customType !== CACHE_FORK_ENTRY && entry.customType !== LEGACY_CACHE_LINEAGE_ENTRY) || !Check(lineageSchema, entry.data)) continue;
    const id = normalizeCacheKey(entry.data.id);

    if (id) return id;
  }

  return undefined;
}

async function readSessionHeader(path: string): Promise<LineageHeader | undefined> {
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
    const value = JSON.parse(newline < 0 ? contents : contents.slice(0, newline));

    return Check(headerSchema, value) ? value : undefined;
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
  const saved = storedLineage(ctx.sessionManager.getBranch());

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

function usesOpenAIResponses(model: ExtensionContext["model"]): boolean {
  if (!Check(modelSchema, model)) return false;
  const provider = model.provider;

  return (provider === "openai-codex" && model.api === "openai-codex-responses")
    || (provider === "openai" && model.api === "openai-responses");
}

export default function openAICacheFork(pi: ExtensionAPI): void {
  let cacheLineageId: string | undefined;
  let restoreProvider: (() => void) | undefined;

  const wrapCodexProvider = (ctx: ExtensionContext): void => {
    const provider = ctx.modelRegistry.getProvider("openai-codex");

    if (!provider) return;

    const previousNative = ctx.modelRegistry.getRegisteredNativeProvider("openai-codex");
    const previousConfig = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
    const currentStream = previousConfig?.streamSimple ?? provider.streamSimple;

    if (Object.getOwnPropertyDescriptor(currentStream, WRAPPED_STREAM_PROPERTY)?.value === true) return;

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
    restoreProvider = () => {
      const current = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");

      if (current?.streamSimple !== wrappedStream) return;
      pi.unregisterProvider("openai-codex");

      if (previousNative) pi.registerProvider(previousNative);
      else {
        const restored = { ...current };

        if (previousConfig?.streamSimple) restored.streamSimple = previousConfig.streamSimple;
        else delete restored.streamSimple;

        if (previousConfig?.api) restored.api = previousConfig.api;
        else delete restored.api;

        if (Object.keys(restored).length) pi.registerProvider("openai-codex", restored);
      }
      pi.events.emit("piop:models-refreshed", { ctx });
    };
    pi.events.emit("piop:models-refreshed", { ctx });
  };

  const initialize = async (ctx: ExtensionContext): Promise<string> => {
    if (cacheLineageId) {
      runtimeState.activeId = cacheLineageId;

      return cacheLineageId;
    }

    const id = await inheritedLineage(ctx);

    if (!storedLineage(ctx.sessionManager.getBranch())) {
      try {
        pi.appendEntry(CACHE_FORK_ENTRY, { id });
      } catch (error) {
        throw new Error(`piop-openai-cache-fork could not save cache identity: ${String(error)}`, { cause: error });
      }
    }

    cacheLineageId = id;
    runtimeState.activeId = id;

    return cacheLineageId;
  };

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
    wrapCodexProvider(ctx);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (!usesOpenAIResponses(ctx.model) || !Check(payloadSchema, event.payload)) return undefined;
    const promptCacheKey = await initialize(ctx);

    const payload = event.payload.prompt_cache_key === promptCacheKey
      ? event.payload
      : { ...event.payload, prompt_cache_key: promptCacheKey };

    return payload === event.payload ? undefined : payload;
  });
  pi.on("session_shutdown", () => {
    restoreProvider?.();
    restoreProvider = undefined;
    if (runtimeState.activeId === cacheLineageId) runtimeState.activeId = undefined;
    cacheLineageId = undefined;
  });
}
