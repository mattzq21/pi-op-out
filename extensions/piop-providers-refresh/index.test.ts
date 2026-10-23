import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import providersRefresh from "./index.ts";

const { runtimeRequest } = createRequire(import.meta.url)("../../daemon/resources/runtime-configuration.cjs");
const bridgeKey = Symbol.for("piop.runtime-bridge");
const previousBridge = Object.getOwnPropertyDescriptor(globalThis, bridgeKey);

afterEach(() => {
  if (previousBridge) Object.defineProperty(globalThis, bridgeKey, previousBridge);
  else Reflect.deleteProperty(globalThis, bridgeKey);
});

function fixture(refresh: (options: { allowNetwork: boolean }) => unknown) {
  const handlers = new Map<string, Array<(event: any) => void>>();
  const events = {
    on(channel: string, handler: (event: any) => void) {
      const listeners = handlers.get(channel) ?? [];
      listeners.push(handler);
      handlers.set(channel, listeners);
      return () => { handlers.set(channel, listeners.filter(listener => listener !== handler)); };
    },
    emit(channel: string, event: any) {
      for (const handler of handlers.get(channel) ?? []) handler(event);
    },
  };
  providersRefresh({ events } as any);
  const ctx = { modelRegistry: { refresh } };
  const session = { extensionRunner: { createCommandContext: () => ctx } };
  Object.defineProperty(globalThis, bridgeKey, { value: (request: unknown) => events.emit("piop:rpc", request), configurable: true });
  return { ctx, events, request: () => runtimeRequest(session, "provider_auth_refresh", {}) };
}

test("provider refresh waits for local models and then announces the session context", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const calls: unknown[] = [];
  const f = fixture(options => { calls.push(options); return pending; });
  const announcements: unknown[] = [];
  f.events.on("piop:models-refreshed", event => { announcements.push(event); });
  let completed = false;
  const request = f.request().then(() => { completed = true; });
  await Promise.resolve();
  expect(calls).toEqual([{ allowNetwork: false }]);
  expect(announcements).toEqual([]);
  expect(completed).toBe(false);
  finish();
  await request;
  expect(announcements).toEqual([{ ctx: f.ctx }]);
  expect(completed).toBe(true);
});

for (const cause of [new Error("registry unavailable"), "registry unavailable"]) {
  test(`provider refresh returns ${typeof cause} failures to the caller without announcing success`, async () => {
    const f = fixture(async () => { throw cause; });
    const announcements: unknown[] = [];
    f.events.on("piop:models-refreshed", event => { announcements.push(event); });
    const error = await f.request().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Could not refresh provider models: registry unavailable. Reopen the conversation to retry.");
    expect(error.cause).toBe(cause);
    expect(announcements).toEqual([]);
  });
}

test("provider refresh preserves a synchronous registry failure", async () => {
  const cause = new Error("registry unavailable");
  const f = fixture(() => { throw cause; });
  const error = await f.request().catch((error: unknown) => error);
  expect(error.cause).toBe(cause);
  expect(error.message).toContain("Could not refresh provider models");
});

test("provider refresh leaves other request handlers' completion unchanged", async () => {
  const f = fixture(() => { throw new Error("Unexpected refresh"); });
  const ready = Promise.resolve("settings saved");
  const request = { command: "runtime_settings", ready };
  f.events.emit("piop:rpc", request);
  expect(request.ready).toBe(ready);
  expect(await request.ready).toBe("settings saved");
});
